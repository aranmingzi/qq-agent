#!/usr/bin/env node
/**
 * 把 47GB 唱歌环境搬到移动硬盘（或直接搬到对方电脑）。
 *
 *   node tools/copy-ai-bundle.mjs --check              只看要拷多少、拷去哪
 *   node tools/copy-ai-bundle.mjs --to E:\QQagent-ai   拷到移动硬盘的临时目录
 *   node tools/copy-ai-bundle.mjs --to E:\QQagent-ai --verify   拷完校验关键文件
 *
 * 为什么不用压缩包：47GB 里 90% 是模型权重（.pth/.onnx），压不动，压一次要一小时只省几 GB。
 * 直接拷更稳，而且 robocopy 支持增量——中断了再跑一遍只会补差量。
 *
 * 必须带走的两样最容易漏：
 *   1) 各目录里的模型权重（少一个就是"唱不了"）
 *   2) runtime/py312 —— diffsinger-env 这个 venv 依赖的基础 Python。漏了它，
 *      DiffSinger 在对方电脑上 100% 起不来（pyvenv.cfg 找不到 home）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const argOf = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const TO = argOf('--to', '');
const CHECK_ONLY = ARGV.includes('--check') || !TO;
const VERIFY = ARGV.includes('--verify');
const BASE_PY = process.env.QQAGENT_BASE_PY || 'C:\\Program Files\\Python312';

const BUNDLE = [
  { dir: 'rvc', need: ['rvc_service.py', 'py310/python.exe'] },
  { dir: 'diffsinger-env', need: ['Scripts/python.exe', 'pyvenv.cfg'] },
  { dir: 'diffsinger-hutao', need: ['hu2_tao2'] },
  { dir: 'gpt-sovits-app', need: ['GPT-SoVITS-v2pro-20250604/api_v2.py', 'GPT-SoVITS-v2pro-20250604/runtime/python.exe'] },
  { dir: 'gpt-sovits-models', need: [] },
  { dir: 'svc', need: ['svc_service.py'] },
  { dir: 'seed-vc', need: ['seedvc_service.py'] },
  { dir: 'ddsp-svc', need: ['ddsp_service.py'] },
  { dir: 'songs', need: ['raw'] },
  { dir: 'background_music', need: [] },
];

const say = (s = '') => console.log(s);
const mb = (b) => Math.round(b / 1048576);

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { if (!/^(__pycache__|tmp|logs)$/i.test(e.name)) stack.push(full); }
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* 忽略 */ } }
    }
  }
  return total;
}

function robocopy(src, dest) {
  const args = [
    src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
    '/MT:16', '/R:1', '/W:1',
    '/XF', '*.log', '*.tmp', '*.pyc',
    '/XD', '__pycache__', 'tmp', 'logs',
  ];
  const r = spawnSync('robocopy', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  // robocopy 的退出码 0-7 都算成功（1=有文件复制, 2=有额外文件, 3=1+2…）
  if (r.error) throw r.error;
  return r.status;
}

/* ------------------------------------------------------------ 体检模式 */
if (CHECK_ONLY) {
  say('== 唱歌环境清单 ==');
  say(`源：${ROOT}`);
  say(`基础 Python：${BASE_PY}${fs.existsSync(BASE_PY) ? '' : '   ← 不存在！'}`);
  say('');
  let total = 0;
  for (const item of BUNDLE) {
    const p = path.join(ROOT, item.dir);
    if (!fs.existsSync(p)) { say(`  缺失  ${item.dir}`); continue; }
    const size = dirSize(p);
    total += size;
    const missing = item.need.filter((n) => !fs.existsSync(path.join(p, ...n.split('/'))));
    say(`  ${String(mb(size)).padStart(6)} MB  ${item.dir}${missing.length ? '  ⚠ 缺：' + missing.join(', ') : ''}`);
  }
  if (fs.existsSync(BASE_PY)) {
    const size = dirSize(BASE_PY);
    total += size;
    say(`  ${String(mb(size)).padStart(6)} MB  runtime/py312  ← 基础 Python（venv 靠它）`);
  }
  say('');
  say(`合计约 ${mb(total)} MB（${(total / 1073741824).toFixed(1)} GB）`);
  say('');
  say('拷到移动硬盘：');
  say('  node tools/copy-ai-bundle.mjs --to E:\\QQagent-ai --verify');
  say('');
  say('对方电脑上：');
  say('  1) 先把「QQagent-便携版.zip」解压成 C:\\QQagent');
  say('  2) 把移动硬盘里 QQagent-ai 下的 10 个文件夹 + runtime 整个拖进 C:\\QQagent');
  say('  3) 双击「启动 QQagent.bat」——自检会自动把 Python 路径指到包内');
  process.exit(0);
}

/* ------------------------------------------------------------ 复制模式 */
if (!fs.existsSync(TO)) fs.mkdirSync(TO, { recursive: true });
const toRoot = path.resolve(TO);
say(`== 复制唱歌环境到 ${toRoot} ==`);
say('（robocopy 增量复制：中断了重跑一次只补差量）');
say('');

const started = Date.now();
let copied = 0;
for (const item of BUNDLE) {
  const src = path.join(ROOT, item.dir);
  if (!fs.existsSync(src)) { say(`· ${item.dir} 不存在，跳过`); continue; }
  const dest = path.join(toRoot, item.dir);
  const t0 = Date.now();
  say(`… ${item.dir}（${mb(dirSize(src))} MB）`);
  const code = robocopy(src, dest);
  if (code > 7) { say(`✗ ${item.dir} 复制失败（robocopy ${code}）`); process.exitCode = 1; continue; }
  copied += 1;
  say(`✓ ${item.dir}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// 基础 Python：漏了它就是白拷
if (fs.existsSync(BASE_PY)) {
  const dest = path.join(toRoot, 'runtime', 'py312');
  say(`… runtime/py312（${mb(dirSize(BASE_PY))} MB）← diffsinger-env 的命根子`);
  const code = robocopy(BASE_PY, dest);
  if (code > 7) { say('✗ 基础 Python 复制失败'); process.exitCode = 1; }
  else { copied += 1; say('✓ runtime/py312'); }
} else {
  say(`✗ 找不到 ${BASE_PY}，DiffSinger 在对方电脑上会失效`);
  process.exitCode = 1;
}

// 带一份自检脚本过去，对方电脑上没 Node 也能跑（用 electron 的 Node）
for (const f of ['tools/portable-setup.mjs']) {
  const src = path.join(ROOT, f);
  const dest = path.join(toRoot, f);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

say('');
say(`== 完成 ${copied} 项，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟 ==`);

/* ------------------------------------------------------------ 校验 */
if (VERIFY) {
  say('');
  say('== 校验关键文件 ==');
  let bad = 0;
  for (const item of BUNDLE) {
    for (const n of item.need) {
      const p = path.join(toRoot, item.dir, ...n.split('/'));
      if (!fs.existsSync(p)) { say(`✗ ${item.dir}/${n}`); bad += 1; }
    }
  }
  for (const p of [path.join(toRoot, 'runtime', 'py312', 'python.exe')]) {
    if (!fs.existsSync(p)) { say('✗ runtime/py312/python.exe'); bad += 1; }
  }
  say(bad ? `✗ 有 ${bad} 项缺失，别急着拔盘` : '✓ 关键文件齐全');
  if (bad) process.exitCode = 1;
}
