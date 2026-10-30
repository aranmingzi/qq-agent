#!/usr/bin/env node
/**
 * 生成「别人电脑上也能跑」的便携分享包。
 *
 *   node tools/make-portable.mjs              # 核心包（约 350MB）
 *   node tools/make-portable.mjs --with-ai    # 追加唱歌环境（+48GB，含基础 Python）
 *   node tools/make-portable.mjs --zip        # 再压成 dist-portable/*.zip / *.7z.001
 *   node tools/make-portable.mjs --out D:\share\QQagent
 *
 * 核心包 = 对话 / 记忆 / 表情 / 日记 / 点歌台 / TTS（走 API）+ NapCat + Electron，解压双击即用。
 * 唱歌增强包 = RVC / DiffSinger / GPT-SoVITS / seed-vc / 曲库 / 背景乐 + 它们要的基础 Python。
 *
 * 安全承诺（本脚本强制）：
 *   1. data/config.json 里所有 apiKey / token / secret 清空；
 *   2. 白名单群号、私聊 QQ 号、主号 QQ、协议端账号全部清空；
 *   3. snowluma 的账号配置、登录缓存、日志、QQ 本地库残留全部剔除；
 *   4. 聊天记录 / 记忆 / 日记 / 表情库 / 群梗 一个字节都不带（data/ 只放脱敏 config.json）；
 *   5. 打完自检：把原配置里的 QQ 号与密钥拿去全文扫描，命中就报错退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const WITH_AI = ARGV.includes('--with-ai');
const DO_ZIP = ARGV.includes('--zip');
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'dist-portable', 'QQagent')));

const CORE_DIRS = [
  'src', 'ui', 'ui-console', 'ui-mobile', 'electron',
  'tools', 'scripts', 'test', 'assets', 'docs', 'skills',
  'snowluma', 'node_modules',
];
const CORE_FILES = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', '.gitignore'];
const AI_DIRS = [
  'rvc', 'diffsinger-env', 'diffsinger-hutao', 'gpt-sovits-app', 'gpt-sovits-models',
  'svc', 'seed-vc', 'ddsp-svc', 'songs', 'background_music',
];
// diffsinger-env 是 venv，home 指向本机 C:\Program Files\Python312；对方电脑没有 → 随包带基础 Python
const BASE_PY_SRC = process.env.QQAGENT_BASE_PY || 'C:\\Program Files\\Python312';
const BASE_PY_DEST = 'runtime\\py312';

const JUNK_FILE = /(\.bak($|-|_))|(\.orig$)|(\.tmp$)|(\.log$)|(~$)|(^Thumbs\.db$)/i;
// 只跳过「工程根下的运行时产物」，注意别误伤 src/data（表情表）
const SKIP_ROOT = new Set([
  '.git', '.deploy', '_package', '_wheels',
  'dist', 'dist-portable', 'out', 'work', 'cache', 'data',
]);

const say = (s = '') => process.stdout.write(s + '\n');
const mb = (bytes) => Math.round(bytes / 1048576);

function dirSize(p, skip) {
  let total = 0;
  let stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (skip && skip(full)) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/* ---------------------------------------------------------------- 过滤规则 */

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function coreFilter(src) {
  const rel = path.relative(ROOT, src).split(path.sep).join('/');
  if (!rel) return true;
  const base = path.basename(src);
  if (JUNK_FILE.test(base)) return false;

  const top = rel.split('/')[0];
  if (rel === top && SKIP_ROOT.has(top)) return false;          // 只砍根级同名目录
  if (rel.startsWith('node_modules/.cache')) return false;

  if (rel === 'snowluma' || rel.startsWith('snowluma/')) return napcatFilter(rel, base, src);
  return true;
}

/** NapCat：保留骨架与模板，剔除一切登录态与账号痕迹 */
function napcatFilter(rel, base, src) {
  if (JUNK_FILE.test(base)) return false;
  const sub = rel.replace(/^snowluma\/?/, '');
  if (sub.startsWith('logs') || sub.startsWith('cache')) return isDir(src) ? true : false;
  // napcat_10000001.json / onebot11_10000001.json / napcat_protocol_10000001.json
  if (/^config\/(napcat|napcat_protocol|onebot11)_\d+\.json$/i.test(sub)) return false;
  // QQ 本地库残留
  if (/^guild\d+\.db(-shm|-wal)?$/i.test(sub)) return false;
  if (/^config\/(napcat|onebot11)_\d+\.json/i.test(sub)) return false;
  return true;
}

function aiFilter(src) {
  const rel = path.relative(ROOT, src).split(path.sep).join('/');
  const base = path.basename(src);
  if (JUNK_FILE.test(base)) return false;
  // 跑出来的测试音频、日志、上传中转，都不进包
  if (/\/(logs?|tmp|temp|output|cache)\//i.test(rel + '/') && !isDir(src)) return false;
  if (/\.(wav|m4a|mp3|flac)$/i.test(base)) return false;
  return true;
}

/* ---------------------------------------------------------------- 配置脱敏 */

const SECRET_KEY = /^(apiKey|accessToken|httpAccessToken|token|secret|password|appSecret|authToken)$/i;

function sanitizeConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));

  // 1) 所有密钥类字段清零（不分层级）
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') { walk(v); continue; }
      if (typeof v === 'string' && SECRET_KEY.test(k)) o[k] = '';
    }
  })(c);

  // 2) 身份与白名单：一个都不留
  c.allow = { groups: [], private: [] };
  c.deny = { groups: [], private: [] };
  if (c.persona) c.persona.masterQQ = '';
  if (c.snowluma) {
    c.snowluma.accountQQ = '';
    c.snowluma.dir = '';            // 让对方的程序自己探测 snowluma 目录
  }
  if (c.webSearch) c.webSearch.anysearchKeys = [];
  if (Array.isArray(c.providers)) c.providers = c.providers.map((p) => ({ ...p, apiKey: '' }));
  if (Array.isArray(c.accountsBridge)) c.accountsBridge = [];

  // 3) 数据目录与账户体系的本地痕迹
  c.masterQQ = '';
  if (c.api) c.api.routing = c.api.routing || {};
  // 手机访问：对方自己开。带着「监听 0.0.0.0 但没令牌」的残留状态会触发强制回环警告。
  if (c.server) {
    c.server.bindHost = '127.0.0.1';
    c.server.token = '';
    c.server.port = 3210;
  }

  return c;
}

/** 从原配置里收集「不能出现在分享包」的标识 */
function collectSecrets(cfg) {
  const ids = new Set();
  const add = (v) => { if (v && /^\d{5,12}$/.test(String(v))) ids.add(String(v)); };
  (cfg.allow?.groups || []).forEach(add);
  (cfg.allow?.private || []).forEach(add);
  (cfg.deny?.groups || []).forEach(add);
  (cfg.deny?.private || []).forEach(add);
  add(cfg.snowluma?.accountQQ);
  add(cfg.persona?.masterQQ);
  add(cfg.masterQQ);

  const keys = new Set();
  const addKey = (v) => { if (typeof v === 'string' && v.length >= 16 && /^(sk-|ey)/.test(v)) keys.add(v); };
  addKey(cfg.api?.apiKey); addKey(cfg.audio?.apiKey); addKey(cfg.vision?.qwen?.apiKey);
  (cfg.providers || []).forEach((p) => addKey(p.apiKey));
  addKey(cfg.server?.token);
  return { ids: [...ids], keys: [...keys] };
}

/* ---------------------------------------------------------------- 复制 */

function copy(src, dest, filter) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter, force: true, dereference: false });
  return true;
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  say('== QQ Agent 便携包生成 ==');
  say(`工程根：${ROOT}`);
  say(`输出到：${OUT}`);
  say('');

  if (!fs.existsSync(path.join(ROOT, 'data', 'config.json'))) {
    throw new Error('找不到 data/config.json，无法生成脱敏配置');
  }
  const rawCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
  const secrets = collectSecrets(rawCfg);
  say(`将剔除 ${secrets.ids.length} 个 QQ/群号、${secrets.keys.length} 个密钥`);
  say('');

  // 清空目标（只清自己生成的那个目录，绝不碰别处）
  if (fs.existsSync(OUT)) {
    if (!/dist-portable|QQagent/i.test(OUT)) throw new Error(`拒绝清理可疑目录：${OUT}`);
    say('· 清理旧输出…');
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. 核心目录
  let done = 0;
  for (const d of CORE_DIRS) {
    const t0 = Date.now();
    const ok = copy(path.join(ROOT, d), path.join(OUT, d), coreFilter);
    say(`${ok ? '✓' : '·'} ${d}${ok ? `  ${((Date.now() - t0) / 1000).toFixed(1)}s` : '  (缺失，跳过)'}`);
    if (ok) done += 1;
  }
  for (const f of CORE_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
  }
  say(`· 核心目录完成（${done}/${CORE_DIRS.length}）`);

  // 2. data/ 只放脱敏配置 + 空骨架
  const dataOut = path.join(OUT, 'data');
  fs.mkdirSync(dataOut, { recursive: true });
  const cleanCfg = sanitizeConfig(rawCfg);
  fs.writeFileSync(path.join(dataOut, 'config.json'), JSON.stringify(cleanCfg, null, 2), 'utf8');
  // 留一份示例，配置改坏时可以照着重建（本身不含任何密钥）
  const exampleSrc = path.join(ROOT, 'data', 'config.example.json');
  if (fs.existsSync(exampleSrc)) fs.copyFileSync(exampleSrc, path.join(dataOut, 'config.example.json'));
  for (const d of ['messages', 'memory/facts', 'diary', 'sessions', 'sticker-files', 'voice', 'playlist', 'tmp']) {
    fs.mkdirSync(path.join(dataOut, d), { recursive: true });
  }
  say('✓ data/config.json（已脱敏）');

  // 3. NapCat WebUI token 换新，别把本机 token 带出去
  const webuiPath = path.join(OUT, 'snowluma', 'config', 'webui.json');
  if (fs.existsSync(webuiPath)) {
    try {
      const w = JSON.parse(fs.readFileSync(webuiPath, 'utf8'));
      w.token = crypto.randomBytes(6).toString('hex');
      w.autoLoginAccount = '';
      fs.writeFileSync(webuiPath, JSON.stringify(w, null, 2), 'utf8');
      say(`✓ snowluma WebUI token 重置（${w.token}）`);
    } catch { say('· webui.json 解析失败，保持原样'); }
  }

  // 4. 便携标记 + 启动器 + 说明
  fs.writeFileSync(path.join(OUT, 'portable.flag'), '便携版标记：主进程会把 Electron 数据放到 data/electron\n', 'utf8');
  const portableDir = path.join(ROOT, 'tools', 'portable');
  if (fs.existsSync(portableDir)) {
    for (const f of fs.readdirSync(portableDir)) {
      fs.copyFileSync(path.join(portableDir, f), path.join(OUT, f));
    }
    say('✓ 启动器与说明已放入包根');
  }

  // 5. 唱歌环境（可选）
  if (WITH_AI) {
    say('');
    say('== 追加唱歌环境 ==');
    for (const d of AI_DIRS) {
      if (!fs.existsSync(path.join(ROOT, d))) { say(`· ${d} 缺失，跳过`); continue; }
      const size = mb(dirSize(path.join(ROOT, d), aiFilter));
      say(`… ${d}（约 ${size} MB）复制中`);
      copy(path.join(ROOT, d), path.join(OUT, d), aiFilter);
    }
    // venv 的基础 Python
    if (fs.existsSync(BASE_PY_SRC)) {
      say(`… 基础 Python（${BASE_PY_SRC}）复制中`);
      copy(BASE_PY_SRC, path.join(OUT, ...BASE_PY_DEST.split('\\')), null);
    } else {
      say(`⚠ 找不到基础 Python：${BASE_PY_SRC}，diffsinger-env 在对方电脑上会失效`);
    }
  }

  // 6. 泄露自检
  say('');
  say('== 泄露自检 ==');
  const scanFiles = [
    path.join(OUT, 'data', 'config.json'),
    path.join(OUT, 'snowluma', 'config', 'webui.json'),
    path.join(OUT, 'snowluma', 'config', 'napcat.json'),
  ];
  const leftovers = [];
  for (const f of fs.readdirSync(path.join(OUT, 'snowluma', 'config'))) {
    scanFiles.push(path.join(OUT, 'snowluma', 'config', f));
  }
  for (const f of scanFiles) {
    if (!fs.existsSync(f) || isDir(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const id of secrets.ids) if (text.includes(id)) leftovers.push(`${path.basename(f)} 含 QQ/群号 ${id}`);
    for (const k of secrets.keys) if (text.includes(k)) leftovers.push(`${path.basename(f)} 含密钥 ${k.slice(0, 6)}…`);
  }
  if (leftovers.length) {
    say('✗ 发现泄露：');
    leftovers.forEach((l) => say('   - ' + l));
    process.exitCode = 2;
  } else {
    say('✓ 未发现 QQ 号 / 群号 / 密钥残留');
  }

  // 7. 清场确认
  const badAccounts = fs.readdirSync(path.join(OUT, 'snowluma', 'config'))
    .filter((f) => /^(napcat|napcat_protocol|onebot11)_\d+\.json$/i.test(f));
  say(badAccounts.length ? `✗ snowluma/config 仍有账号配置：${badAccounts.join(', ')}` : '✓ snowluma 账号配置已清空');
  const dataEntries = fs.readdirSync(dataOut);
  say(`· data/ 内容：${dataEntries.join(', ')}`);

  // 8. 体积
  const total = dirSize(OUT);
  say('');
  say(`== 完成：${mb(total)} MB ==`);
  say(`包目录：${OUT}`);
  say('');
  say('给对方的操作：解压 → 装 PC 版 QQ 并登录小号 → 双击「启动 QQagent.bat」→ 按首次使用必读配置');

  // 9. 压缩
  if (DO_ZIP) {
    const sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe';
    if (!fs.existsSync(sevenZip)) { say('⚠ 没找到 7-Zip，跳过压缩'); return; }
    const stageDir = path.dirname(OUT);
    if (WITH_AI) {
      const outFile = path.join(stageDir, 'QQagent-唱歌增强包.7z');
      say(`\n压缩（分卷 4GB，耗时较久）：${outFile}`);
      execFileSync(sevenZip, ['a', '-t7z', '-mx=1', '-v4g', '-y', outFile, OUT], { stdio: 'inherit' });
    } else {
      const outFile = path.join(stageDir, 'QQagent-便携版.zip');
      say(`\n压缩：${outFile}`);
      execFileSync(sevenZip, ['a', '-tzip', '-mx=5', '-y', outFile, path.join(OUT, '*')], { stdio: 'inherit' });
    }
    say('✓ 压缩完成');
  }
}

main();
