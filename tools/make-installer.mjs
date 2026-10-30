#!/usr/bin/env node
/**
 * QQ Agent 安装包生成器（Windows / NSIS 3.x）
 *
 * 流程：
 *   1) 复用 tools/make-portable.mjs 把工程脱敏 + 裁剪成可分发载荷
 *   2) 安装版专用二次裁剪（去 test/、去 *.bak-*、locales 只留中英、去构建期依赖）
 *   3) 把 node_modules/electron/dist/electron.exe 就地改名成 QQ Agent.exe 并写图标与版本资源
 *   4) 生成 THIRD-PARTY-NOTICES.md 与 README.html
 *   5) 调 makensis 编出 QQagent-Setup-<version>.exe，再打 zip、写 SHA256SUMS.txt
 *
 * 用法：
 *   node tools/make-installer.mjs                 全流程
 *   node tools/make-installer.mjs --skip-zip      不打 zip
 *   node tools/make-installer.mjs --stage-only    只做载荷
 *   node tools/make-installer.mjs --reuse-app     复用上次载荷，只重编安装器
 *   node tools/make-installer.mjs --out D:\tmp\out
 *
 * 外部工具（自动查找 / 自动下载）：
 *   makensis     QQAGENT_MAKENSIS，dsh-work/nsis/makensis.exe，已装 NSIS，或 npm 包 @nsis-u/makensis
 *   rcedit       QQAGENT_RCEDIT，dsh-work/rcedit/package/bin/；缺就跳过品牌化
 *   7-Zip        QQAGENT_7Z，C:\Program Files\7-Zip\7z.exe；缺就不打 zip
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const argOf = (name, dflt) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};

const OUT_DIR = path.resolve(argOf('--out', path.join(ROOT, 'dist-installer')));
const STAGE = path.join(OUT_DIR, 'app');
const WORK = path.join(ROOT, 'dsh-work');
const SKIP_ZIP = has('--skip-zip');
const STAGE_ONLY = has('--stage-only');
const REUSE_APP = has('--reuse-app');

const APP_NAME = 'QQ Agent';
const APP_EXE = 'QQ Agent.exe';
const PUBLISHER = '白光 (liuyuyu599com-svg)';
const COPYRIGHT = 'MIT License (c) 2026 白光 (liuyuyu599com-svg)';
const MAX_PATH_LEN = 150;
const INSTALL_DIR_HINT = '%LOCALAPPDATA%\\Programs\\QQAgent';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = argOf('--version', PKG.version || '1.0.0');

const SETUP_NAME = 'QQagent-Setup-' + VERSION + '.exe';
const ZIP_NAME = 'QQagent-' + VERSION + '-win.zip';
const SETUP_PATH = path.join(OUT_DIR, SETUP_NAME);
const ZIP_PATH = path.join(OUT_DIR, ZIP_NAME);
const README_OUT = path.join(OUT_DIR, 'README.html');

const say = (s) => process.stdout.write((s === undefined ? '' : s) + '\n');
const mb = (n) => Math.round(n / 1048576);
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const rmf = (p) => fs.rmSync(p, { recursive: true, force: true });

function walk(dir, fn, rel) {
  rel = rel || '';
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (fn(full, r, e) === false) continue;
    if (e.isDirectory()) walk(full, fn, r);
  }
}

function dirStat(dir) {
  let bytes = 0;
  let files = 0;
  let maxRel = 0;
  walk(dir, (full, rel, e) => {
    if (e.isDirectory()) return;
    try { bytes += fs.statSync(full).size; } catch (err) { }
    files += 1;
    if (rel.length > maxRel) maxRel = rel.length;
  });
  return { bytes: bytes, files: files, maxRel: maxRel };
}

/* --------------------------------------------------------------- 外部工具 */

function firstExisting(list) {
  for (const p of list) if (p && exists(p)) return p;
  return '';
}

function download(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'qqagent-installer-builder' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + '：' + url)); return; }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function extractTarGz(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = firstExisting(['C:\\Windows\\System32\\tar.exe', '/usr/bin/tar', '/bin/tar']);
  if (!tar) throw new Error('系统里找不到 tar，解不开 makensis 压缩包');
  execFileSync(tar, ['-xzf', file, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
}

async function ensureMakensis() {
  const found = firstExisting([
    process.env.QQAGENT_MAKENSIS,
    path.join(WORK, 'nsis', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]);
  if (found) return found;

  const dest = path.join(WORK, 'nsis');
  const tgz = path.join(WORK, 'makensis.tgz');
  const url = 'https://registry.npmjs.org/@nsis-u/makensis/-/makensis-3.3.0.tgz';
  say('· 本机没有 makensis，从 npm registry 取一份：' + url);
  fs.mkdirSync(WORK, { recursive: true });
  await download(url, tgz);
  rmf(dest);
  extractTarGz(tgz, dest);
  rmf(tgz);
  const got = path.join(dest, 'makensis.exe');
  if (!exists(got)) throw new Error('解压后没看到 makensis.exe：' + got);
  return got;
}

async function ensureRcedit() {
  const found = firstExisting([
    process.env.QQAGENT_RCEDIT,
    path.join(WORK, 'rcedit', 'package', 'bin', 'rcedit-x64.exe'),
    path.join(WORK, 'rcedit', 'package', 'bin', 'rcedit.exe'),
  ]);
  if (found) return found;
  say('· 本机没有 rcedit，从 npm registry 取一份（失败就跳过品牌化，不影响出包）');
  try {
    const dest = path.join(WORK, 'rcedit');
    const tgz = path.join(WORK, 'rcedit.tgz');
    await download('https://registry.npmjs.org/rcedit/-/rcedit-5.0.2.tgz', tgz);
    rmf(dest);
    extractTarGz(tgz, dest);
    rmf(tgz);
    return firstExisting([
      path.join(dest, 'package', 'bin', 'rcedit-x64.exe'),
      path.join(dest, 'package', 'bin', 'rcedit.exe'),
    ]);
  } catch (err) {
    say('  ! rcedit 取不到（' + err.message + '），跳过图标与版本资源');
    return '';
  }
}

function sevenZip() {
  return firstExisting([
    process.env.QQAGENT_7Z,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]);
}

/* ------------------------------------------------------------- 载荷：阶段一 */

function runPortable() {
  rmf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });
  const script = path.join(ROOT, 'tools', 'make-portable.mjs');
  say('== 阶段一：复用便携包流水线（脱敏 + 裁剪 + 泄露自检）==');
  execFileSync(process.execPath, [script, '--out', STAGE], { cwd: ROOT, stdio: 'inherit' });
}

/* ------------------------------------------------------------- 载荷：阶段二 */

const PRUNE_PATHS = [
  'test',
  'tools/portable',
  'tools/copy-ai-bundle.mjs',
  '启动 QQagent.bat',
  'Start.bat',
  '首次使用必读.md',
  'node_modules/.cache',
  'node_modules/@electron',
  'node_modules/@electron-internal',
  'node_modules/@types',
  'node_modules/electron/dist/debug.log',
];

const KEEP_LOCALES = ['en-US.pak', 'zh-CN.pak'];

/**
 * 安装版配置的最后一刀：make-portable 已经清过密钥和身份白名单，
 * 这里再补三类「换了台电脑就是错值」的本机痕迹，以及密钥的兜底清零。
 *
 * 为什么必须补：便携包是给同一台机器用的，安装包是给别人用的。
 *   - net.proxyUrl 指向本机的 Clash（127.0.0.1:7897）。对方没开这个端口，
 *     所有走代理的海外域名会直接连接超时；留空才能让 src/net-proxy.js 自己探测
 *     （discoverProxy 会试 7897/7890/10809/10808/2080）。
 *   - snowluma.dir 是绝对路径时，对方机器上这个目录不存在 → 协议端永远找不到。
 *   - 任何 non-empty 的 apiKey / token / secret 都不该进别人的包。零命中是硬要求。
 */
function sanitizeStageConfig() {
  const f = path.join(STAGE, 'data', 'config.json');
  if (!exists(f)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) {
    say('  ! data/config.json 解析失败，跳过配置兜底：' + err.message);
    return;
  }
  const notes = [];

  // 1) 本机代理地址（别人的 7897 不一定是代理，留空交给自动探测）
  if (cfg.net && cfg.net.proxyUrl) {
    notes.push('net.proxyUrl 清空（原值指向本机代理）');
    cfg.net.proxyUrl = '';
  }

  // 2) 协议端目录与账号
  if (cfg.snowluma) {
    if (cfg.snowluma.dir) { cfg.snowluma.dir = ''; notes.push('snowluma.dir 清空'); }
    if (cfg.snowluma.accountQQ) { cfg.snowluma.accountQQ = ''; notes.push('snowluma.accountQQ 清空'); }
  }

  // 3) 兜底：任何层级的密钥字段一律清零（make-portable 漏掉的这里收口）
  const SECRET = /^(apiKey|accessToken|httpAccessToken|token|secret|password|appSecret|authToken|masterQQ)$/i;
  let wiped = 0;
  (function walkObj(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') { walkObj(v); continue; }
      if (typeof v === 'string' && v.length > 0 && SECRET.test(k)) { o[k] = ''; wiped += 1; }
    }
  })(cfg);
  if (wiped) notes.push('密钥类字段清零 ' + wiped + ' 处');

  // 4) 手机访问：别人的包一律从回环开始，别带着"监听全网卡但没令牌"的状态出去
  if (cfg.server) {
    cfg.server.bindHost = '127.0.0.1';
    cfg.server.token = '';
    cfg.server.port = 3210;
  }

  fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
  say('  · data/config.json 兜底：' + (notes.length ? notes.join('；') : '无需改动'));
}

/* ------------------------------------------------------------- 身份脱敏 */

// 本机真实身份：主人号、常用群号、账号昵称、开发机绝对路径。
// 这些串散落在四处——默认配置、人设文案、UI 的 mock 数据、历史文档与注释。
// 安装包是给别人用的：装完随手一搜就能看到号，所以只在载荷副本上换掉，
// 源码保持原样（源码里的实机事故记录本来就是给维护者看的）。
const REAL_IDS = [
  '10000001',            // 主人号
  '10000002',            // 账号自身号
  '20000001',            // 主群
  '20000002',            // 第二个群
  '20000003',             // 第三个群
  '20000004',            // 常用私聊
  '20000005',             // 事故记录里的群
  '小鲸鱼',                // 账号昵称
  'D:\\\\QQagent',            // 开发机路径（JSON 双反斜杠形式）
  'C:/QQagent',            // 开发机路径（正斜杠形式）
];

const ID_SCRUB = [
  ['10000001', '10000001'],
  ['10000002', '10000002'],
  ['20000001', '10000003'],
  ['20000002', '10000004'],
  ['20000003', '10000005'],
  ['20000004', '10000006'],
  ['20000005', '10000007'],
  ['小鲸鱼', '小鲸鱼'],
  ['D:\\\\QQagent', 'C:\\\\QQAgent'],
  ['C:/QQagent', 'C:/QQAgent'],
];

const TEXT_EXT = /\.(m?js|cjs|json|md|html|css|txt|ya?ml|nsi|ps1|bat|cmd|sh)$/i;
const SCRUB_MAX = 4 * 1024 * 1024;

/** 遍历载荷里的文本文件（跳过 node_modules 与超大文件），fn 收到绝对路径与内容。 */
function eachTextFile(fn) {
  walk(STAGE, (full, rel, e) => {
    if (!e.isFile() || !TEXT_EXT.test(e.name)) return;
    if (rel.indexOf('node_modules/') === 0) return;
    let st;
    try { st = fs.statSync(full); } catch (err) { return; }
    if (st.size > SCRUB_MAX) return;
    let t;
    try { t = fs.readFileSync(full, 'utf8'); } catch (err) { return; }
    fn(full, rel, t);
  });
}

function scrubIdentifiers() {
  say('');
  say('== 阶段二·五：身份脱敏 ==');
  let files = 0;
  let hits = 0;
  eachTextFile((full, rel, t) => {
    const before = t;
    // 1) 出厂配置里的主人号本身清空：别人的主人是别人，README 让用户自己填
    t = t.replace(/(masterQQ["']?\s*[:=]\s*["'])10000001(["'])/g, '$1$2');
    // 2) 人设文案点名主人号没意义，模型只需要知道「主人」
    t = t.split('对主人 10000001 可以稍软一点').join('对主人可以稍软一点');
    // 3) 其余（注释、mock 数据、示例路径）统一换等长示例值，便于肉眼辨认
    for (const pair of ID_SCRUB) t = t.split(pair[0]).join(pair[1]);
    if (t === before) return;
    fs.writeFileSync(full, t, 'utf8');
    files += 1;
    for (const id of REAL_IDS) if (before.indexOf(id) >= 0) { hits += 1; break; }
  });
  say('  · 改写 ' + files + ' 个文件（真实号/昵称/本机路径 → 示例值）');
}

/** 出厂审计：真实身份零命中才算过。返回问题数。 */
function auditIdentifiers() {
  const hot = [];
  eachTextFile((full, rel, t) => {
    for (const id of REAL_IDS) {
      if (t.indexOf(id) >= 0) { hot.push(rel + ' ← ' + id); break; }
    }
  });
  if (!hot.length) {
    say('  + 身份脱敏：真实 QQ 号 / 群号 / 昵称 / 本机路径零命中');
    return 0;
  }
  for (const h of hot) say('  x 身份残留 ' + h);
  return 1;
}

function pruneStage() {
  say('');
  say('== 阶段二：安装版专用裁剪 ==');
  for (const rel of PRUNE_PATHS) {
    const p = path.join(STAGE, rel);
    if (!exists(p)) continue;
    rmf(p);
    say('  - 删除 ' + rel);
  }

  const bakList = [];
  walk(STAGE, (full, rel, e) => {
    if (e.isFile() && /\.bak($|-|_)/i.test(e.name)) bakList.push(full);
  });
  for (const f of bakList) { try { fs.unlinkSync(f); } catch (err) { } }
  say('  - 删除编辑器备份 *.bak-*：' + bakList.length + ' 个');

  const locales = path.join(STAGE, 'node_modules', 'electron', 'dist', 'locales');
  let loc = 0;
  if (isDir(locales)) {
    for (const f of fs.readdirSync(locales)) {
      if (KEEP_LOCALES.indexOf(f) >= 0) continue;
      try { fs.unlinkSync(path.join(locales, f)); loc += 1; } catch (err) { }
    }
  }
  say('  - 精简 locales：删 ' + loc + ' 个，留 ' + KEEP_LOCALES.join(' / '));

  for (const rel of ['snowluma/logs', 'snowluma/cache', 'data/electron']) {
    const p = path.join(STAGE, rel);
    if (!isDir(p)) continue;
    for (const f of fs.readdirSync(p)) rmf(path.join(p, f));
    say('  - 清空 ' + rel);
  }
  sanitizeStageConfig();
  scrubIdentifiers();

  const sl = path.join(STAGE, 'snowluma');
  if (isDir(sl)) {
    for (const f of fs.readdirSync(sl)) {
      if (/^guild\d+\.db(-shm|-wal)?$/i.test(f)) {
        rmf(path.join(sl, f));
        say('  - 删除 QQ 本地库残留 snowluma/' + f);
      }
    }
  }
}

/* --------------------------------------------------------------- 品牌化 exe */

async function brandExecutable() {
  say('');
  say('== 阶段三：把 Electron 改名成程序本体 ==');
  const distDir = path.join(STAGE, 'node_modules', 'electron', 'dist');
  const srcExe = path.join(distDir, 'electron.exe');
  const dstExe = path.join(distDir, APP_EXE);
  if (!exists(srcExe)) {
    if (exists(dstExe)) { say('  · 已经改过名：' + path.relative(STAGE, dstExe)); return; }
    throw new Error('载荷里没有 electron.exe：' + srcExe);
  }
  fs.renameSync(srcExe, dstExe);
  say('  + ' + path.relative(STAGE, srcExe) + '  ->  ' + path.relative(STAGE, dstExe));

  const ico = path.join(ROOT, 'tools', 'installer', 'qqagent.ico');
  const rcedit = await ensureRcedit();
  if (!rcedit) { say('  ! 没有 rcedit，exe 图标与版本资源保持 Electron 原样'); return; }
  try {
    execFileSync(rcedit, [
      dstExe,
      '--set-icon', ico,
      '--set-version-string', 'ProductName', APP_NAME,
      '--set-version-string', 'FileDescription', APP_NAME,
      '--set-version-string', 'CompanyName', PUBLISHER,
      '--set-version-string', 'LegalCopyright', COPYRIGHT,
      '--set-version-string', 'OriginalFilename', APP_EXE,
      '--set-file-version', VERSION + '.0',
      '--set-product-version', VERSION,
    ], { stdio: 'inherit' });
    say('  + 图标与版本资源已写入');
  } catch (err) {
    say('  ! rcedit 失败（' + err.message + '），exe 资源保持原样，安装包照出');
  }
}

/* ------------------------------------------------------- 说明文件 / 依赖清单 */

function collectRuntimeDeps() {
  const seen = [];
  const index = new Map();
  const add = (dir, fallback) => {
    const pj = path.join(dir, 'package.json');
    if (!exists(pj)) return;
    let m;
    try { m = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { return; }
    let lic = m.license || '';
    if (!lic && Array.isArray(m.licenses)) {
      lic = m.licenses.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
    }
    const name = m.name || fallback;
    if (index.has(name)) return;
    const row = { name: name, version: m.version || '', license: lic || '未声明' };
    index.set(name, row);
    seen.push(row);
  };
  const nm = path.join(STAGE, 'node_modules');
  if (isDir(nm)) {
    for (const d of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.charAt(0) === '.') continue;
      if (d.name.charAt(0) === '@') {
        for (const s of fs.readdirSync(path.join(nm, d.name), { withFileTypes: true })) {
          if (!s.isDirectory()) continue;
          add(path.join(nm, d.name, s.name), d.name + '/' + s.name);
        }
        continue;
      }
      add(path.join(nm, d.name), d.name);
    }
  }
  return seen.sort((a, b) => a.name.localeCompare(b.name));
}

function writeThirdPartyNotices() {
  const deps = collectRuntimeDeps();
  const out = [];
  out.push('# QQ Agent — 第三方组件与许可');
  out.push('');
  out.push('本文件由 tools/make-installer.mjs 在构建时自动生成，对应 QQ Agent ' + VERSION + '。');
  out.push('QQ Agent 本体以 MIT 许可发布，完整条文见同目录 LICENSE。下面列出随包分发的第三方组件。');
  out.push('');
  out.push('## 一、运行时依赖（Node.js 侧，随包分发）');
  out.push('');
  out.push('| 组件 | 版本 | 许可 |');
  out.push('| --- | --- | --- |');
  for (const d of deps) out.push('| ' + d.name + ' | ' + (d.version || '-') + ' | ' + d.license + ' |');
  out.push('');
  out.push('## 二、Electron / Chromium');
  out.push('');
  out.push('- Electron 以 MIT 许可分发，许可证原文见 `node_modules/electron/dist/LICENSE`。');
  out.push('- Electron 内嵌 Chromium，其自带组件各自的许可原文见 `node_modules/electron/dist/LICENSES.chromium.html`（约 20 MB，请保留）。');
  out.push('- 程序本体 `node_modules/electron/dist/QQ Agent.exe` 就是 Electron 主程序，仅改名与写资源，未修改其代码。');
  out.push('');
  out.push('## 三、协议端（NapCat / SnowLuma）');
  out.push('');
  out.push('`snowluma/` 下的 NapCat 相关文件（`napcat.mjs`、`NapCatWinBootMain.exe`、`NapCatWinBootHook.dll`、`qqnt.json` 等）');
  out.push('版权归各自项目作者所有，随包仅作为「连接 PC 版 QQ 的协议端」原样分发，未做修改。');
  out.push('再分发或商用前请先阅读上游项目的许可条款。');
  out.push('');
  out.push('## 四、图标与位图');
  out.push('');
  out.push('- `assets/` 下的图标与 `tools/installer/` 下的安装器位图由本项目自行绘制，随本项目 MIT 许可。');
  out.push('- 界面使用系统自带字体，未内嵌任何商用字库。');
  out.push('');
  out.push('## 五、说明');
  out.push('');
  out.push('- 上表许可取自各包 `package.json` 的 `license` 字段；如与上游仓库不一致，以上游仓库为准。');
  out.push('- 本文件随安装包分发；改依赖后请重新执行 `npm run build:installer` 让它自动更新。');
  out.push('');
  const p = path.join(STAGE, 'THIRD-PARTY-NOTICES.md');
  fs.writeFileSync(p, out.join('\n'), 'utf8');
  say('  + THIRD-PARTY-NOTICES.md（' + deps.length + ' 个运行时依赖）');
}

function buildDate() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function renderReadme() {
  const tplPath = path.join(ROOT, 'tools', 'installer', 'readme.html');
  if (!exists(tplPath)) throw new Error('找不到说明模板：' + tplPath);
  let html = fs.readFileSync(tplPath, 'utf8');
  const map = [
    ['{{VERSION}}', VERSION],
    ['{{DATE}}', buildDate()],
    ['{{INSTALL_DIR}}', INSTALL_DIR_HINT],
    ['{{INSTALLER_PATH}}', SETUP_NAME],
  ];
  for (const pair of map) html = html.split(pair[0]).join(pair[1]);
  html = html.replace(/\{\{[A-Z_]+\}\}/g, '');
  fs.writeFileSync(README_OUT, html, 'utf8');
  fs.writeFileSync(path.join(STAGE, 'README.html'), html, 'utf8');
  say('  + README.html（' + html.length + ' 字符）');
}

/* ------------------------------------------------------------------ 编译 */

/**
 * makensis 只认带 BOM 的 UTF-8 或 ANSI/UTF-16 脚本。
 * 不带 BOM 的中文脚本会当场报 "Bad text encoding: <file>:<line>"。
 * 编辑器、git 配置、甚至某些工具保存时都会把 BOM 吃掉，所以编译前强制补一次。
 */
function ensureNsiBom(nsi) {
  const buf = fs.readFileSync(nsi);
  // 先把多余的 BOM 全部剥掉再补一个：重复补 BOM 会让 makensis 报 Invalid command: "?;"
  let i = 0;
  while (i + 2 < buf.length && buf[i] === 0xef && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf) i += 3;
  if (i === 3) return false;
  const body = buf.subarray(i);
  fs.writeFileSync(nsi, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  return true;
}

function compileInstaller(makensis) {
  say('');
  say('== 阶段四：编译安装器 ==');
  const nsi = path.join(ROOT, 'tools', 'installer', 'installer.nsi');
  const assetDir = path.join(ROOT, 'tools', 'installer');
  if (ensureNsiBom(nsi)) say('  · 给 installer.nsi 补回 UTF-8 BOM（makensis 需要）');
  rmf(SETUP_PATH);
  const t0 = Date.now();
  say('  makensis：' + makensis);
  say('  载荷：' + STAGE);
  say('  输出：' + SETUP_PATH);
  say('  （几百 MB 载荷 + lzma 全压缩，几分钟内正常，别急着 Ctrl-C）');
  execFileSync(makensis, [
    '-V2',
    '-DAPP_VERSION=' + VERSION,
    '-DAPP_SRC=' + STAGE,
    '-DOUT_FILE=' + SETUP_PATH,
    '-DASSET_DIR=' + assetDir,
    nsi,
  ], { stdio: 'inherit', maxBuffer: 64 * 1024 * 1024 });
  if (!exists(SETUP_PATH)) throw new Error('makensis 说成功了，但没看到输出文件');
  say('  + 编译完成 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's，' + mb(fs.statSync(SETUP_PATH).size) + ' MB');
}

function makeZip() {
  say('');
  say('== 阶段五：免安装 zip ==');
  const sz = sevenZip();
  if (!sz) { say('  ! 没找到 7-Zip，跳过 zip'); return false; }
  rmf(ZIP_PATH);
  execFileSync(sz, ['a', '-tzip', '-mx=5', '-y', ZIP_PATH, '*'], { cwd: STAGE, stdio: 'inherit' });
  say('  + ' + ZIP_NAME + ' ' + mb(fs.statSync(ZIP_PATH).size) + ' MB');
  return true;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function writeChecksums(hasZip) {
  say('');
  say('== 阶段六：校验和 ==');
  const targets = [SETUP_PATH, README_OUT];
  if (hasZip && exists(ZIP_PATH)) targets.push(ZIP_PATH);
  const rows = targets.filter(exists).map((f) => sha256(f) + '  ' + path.basename(f));
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS.txt'), rows.join('\n') + '\n', 'utf8');
  for (const r of rows) say('  ' + r);
}

/* --------------------------------------------------------------- 出厂自检 */

function selfCheck() {
  say('');
  say('== 阶段七：出厂自检 ==');
  let bad = 0;
  const need = [
    'package.json',
    'portable.flag',
    'LICENSE',
    'README.html',
    'THIRD-PARTY-NOTICES.md',
    'electron/main.js',
    'src/app.js',
    'src/config.js',
    'ui-console/index.html',
    'assets/icon.ico',
    'data/config.json',
    'snowluma/napcat.mjs',
    'snowluma/NapCatWinBootMain.exe',
    'snowluma/NapCatWinBootHook.dll',
    'snowluma/qqnt.json',
    'node_modules/electron/dist/' + APP_EXE,
  ];
  for (const rel of need) {
    if (exists(path.join(STAGE, rel))) continue;
    say('  x 缺文件 ' + rel);
    bad += 1;
  }

  bad += auditIdentifiers();

  const st = dirStat(STAGE);
  const budget = MAX_PATH_LEN - '%LOCALAPPDATA%\\Programs\\QQAgent'.length;
  if (st.maxRel > budget) {
    say('  ! 最长相对路径 ' + st.maxRel + ' 字符，超过安全预算 ' + budget);
    bad += 1;
  } else {
    say('  + 最长相对路径 ' + st.maxRel + ' 字符（预算 ' + budget + '）');
  }
  say('  + 载荷 ' + st.files + ' 个文件，' + mb(st.bytes) + ' MB');

  if (exists(SETUP_PATH)) {
    const head = Buffer.alloc(2);
    const fd = fs.openSync(SETUP_PATH, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ') { say('  x Setup 不是 PE 文件'); bad += 1; }
    else say('  + ' + SETUP_NAME + ' ' + mb(fs.statSync(SETUP_PATH).size) + ' MB（PE，MZ 头正常）');
  }

  if (bad) { say('  x 自检未通过：' + bad + ' 项问题'); return false; }
  say('  + 自检通过');
  return true;
}

/* -------------------------------------------------------------------- 主流程 */

async function main() {
  say('== QQ Agent 安装包生成 ==');
  say('工程根：' + ROOT);
  say('输出去：' + OUT_DIR);
  say('版本号：' + VERSION);
  say('');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (REUSE_APP) {
    if (!isDir(STAGE)) throw new Error('--reuse-app 需要已存在的载荷：' + STAGE);
    say('· 复用已有载荷：' + STAGE);
    await brandExecutable();
    writeThirdPartyNotices();
    renderReadme();
  } else {
    runPortable();
    pruneStage();
    await brandExecutable();
    writeThirdPartyNotices();
    renderReadme();
  }

  if (STAGE_ONLY) {
    say('');
    say('· --stage-only：载荷就绪，跳过编译与打包');
    selfCheck();
    say('载荷目录：' + STAGE);
    return;
  }

  const makensis = await ensureMakensis();
  compileInstaller(makensis);

  const hasZip = SKIP_ZIP ? false : makeZip();
  writeChecksums(hasZip);
  const ok = selfCheck();

  say('');
  say('== 产物 ==');
  for (const f of [SETUP_NAME, 'README.html', ZIP_NAME, 'SHA256SUMS.txt']) {
    const p = path.join(OUT_DIR, f);
    if (exists(p)) say('  ' + f + '  ' + mb(fs.statSync(p).size) + ' MB');
  }
  say('');
  say('给对方：把 Setup + README.html + SHA256SUMS.txt 三个文件发过去；');
  say('对方双击 Setup → 一路下一步 → 桌面图标启动 → 按 README.html 第一次使用三步走。');
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write('\n x 构建失败：' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
