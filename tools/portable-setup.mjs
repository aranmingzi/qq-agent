#!/usr/bin/env node
/**
 * 便携版首次运行自检 / 自愈。
 * 由「启动 QQagent.bat」在启动 Electron 之前调用（借用 Electron 自带的 Node，不依赖系统 Node）。
 *
 * 它解决的唯一硬问题：
 *   diffsinger-env 是 venv，pyvenv.cfg 里写死了创建时那台机器的 Python 绝对路径
 *   （home = C:\Program Files\Python312）。换台电脑、或解压到别的目录，venv 直接失效。
 *   本脚本把 home/executable 改成「包内自带的基础 Python」的当前位置，改完 RVC/DiffSinger 照样能用。
 *
 * 其余都是体检：缺什么说清楚缺什么，别让人对着黑窗口猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P = (...s) => path.join(ROOT, ...s);
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const ok = (s) => console.log('  [ok]   ' + s);
const warn = (s) => console.log('  [注意] ' + s);
const bad = (s) => console.log('  [缺失] ' + s);
const step = (s) => console.log('\n' + s);

let problems = 0;
const fail = (msg) => { problems += 1; bad(msg); };

/* ------------------------------------------------ 1. 数据目录骨架 */
step('1/4 准备数据目录');
for (const d of ['data', 'data/messages', 'data/memory/facts', 'data/diary', 'data/sessions',
  'data/sticker-files', 'data/voice', 'data/playlist', 'data/tmp', 'data/electron']) {
  fs.mkdirSync(P(d), { recursive: true });
}
// 配置：没有就用示例补一份（绝不覆盖已有配置）
const cfgFile = P('data/config.json');
const example = P('data/config.example.json');
if (!exists(cfgFile)) {
  if (exists(example)) {
    fs.copyFileSync(example, cfgFile);
    ok('data/config.json 已按示例生成');
  } else {
    fail('data/config.json 与 config.example.json 都不存在');
  }
} else {
  ok('data/config.json 已存在（保留不动）');
}

/* ------------------------------------------------ 2. 修 Python venv */
step('2/4 检查 Python 环境（唱歌用）');
const venvDir = P('diffsinger-env');
const venvCfg = path.join(venvDir, 'pyvenv.cfg');
const basePy = P('runtime', 'py312');

function readVenvHome() {
  if (!exists(venvCfg)) return '';
  const m = fs.readFileSync(venvCfg, 'utf8').match(/^home\s*=\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

const hasVenvPy = exists(path.join(venvDir, 'Scripts', 'python.exe'));
const hasBasePy = exists(path.join(basePy, 'python.exe'));
const curHome = readVenvHome();

if (!exists(venvDir)) {
  warn('没有 diffsinger-env：唱歌（DiffSinger 部分）不可用，其余功能不受影响');
} else if (!exists(venvCfg) || !hasVenvPy) {
  warn('diffsinger-env 结构异常（缺 pyvenv.cfg 或 Scripts/python.exe）');
  console.log('         解决：重新解压「唱歌增强包」覆盖到本目录');
} else if (hasBasePy && curHome === basePy) {
  ok('diffsinger-env 已指向包内 Python');
} else if (hasBasePy) {
  // ← 换机器 / 换目录后的自愈：一律指回包内那份基础 Python，不赌对方系统里装了什么
  const lines = fs.readFileSync(venvCfg, 'utf8').split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(home|executable|command)\s*=/i.test(l));
  lines.unshift(`home = ${basePy}`);
  lines.push(`executable = ${path.join(basePy, 'python.exe')}`);
  fs.writeFileSync(venvCfg, lines.join('\n') + '\n', 'utf8');
  ok(`diffsinger-env 已重新指向包内 Python：${basePy}`);
} else if (curHome && exists(path.join(curHome, 'python.exe'))) {
  ok(`diffsinger-env 沿用本机 Python：${curHome}`);
} else {
  fail('diffsinger-env 找不到可用的基础 Python（包里缺 runtime/py312）');
  console.log('         解决：重新解压「唱歌增强包」覆盖到本目录');
}

// 便携式 Python（无需修，只做存在性检查）
for (const [label, rel] of [
  ['RVC / 扒谱 Python', path.join('rvc', 'py310', 'python.exe')],
  ['GPT-SoVITS Python', path.join('gpt-sovits-app', 'GPT-SoVITS-v2pro-20250604', 'runtime', 'python.exe')],
]) {
  if (exists(P(rel))) ok(label + ' 就位');
  else warn(label + ' 未找到（' + rel.replace(/\\/g, '/') + '）→ 对应唱法不可用');
}

/* ------------------------------------------------ 3. 协议端 / QQ */
step('3/4 检查 QQ 协议端（NapCat）');
if (exists(P('snowluma', 'NapCatWinBootMain.exe'))) ok('NapCat 文件完整');
else fail('snowluma/NapCatWinBootMain.exe 缺失，无法连 QQ');

let qqPath = '';
const qqCandidates = [];
try {
  const out = execFileSync('reg', ['query',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    '/v', 'UninstallString'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const m = out.match(/REG_SZ\s+(.+)/);
  if (m) {
    const dir = path.dirname(m[1].trim().replace(/^"|"$/g, ''));
    if (exists(path.join(dir, 'QQ.exe'))) qqCandidates.push(path.join(dir, 'QQ.exe'));
  }
} catch { /* 注册表没查到，再用常见目录兜底（和 src/napcat-process.js 同一套候选） */ }

const pf = process.env.ProgramFiles || 'C:\\Program Files';
const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const lad = process.env.LOCALAPPDATA || '';
for (const c of [
  path.join(pf, 'Tencent', 'QQNT', 'QQ.exe'),
  path.join(pf86, 'Tencent', 'QQNT', 'QQ.exe'),
  lad && path.join(lad, 'Programs', 'Tencent', 'QQNT', 'QQ.exe'),
  lad && path.join(lad, 'Tencent', 'QQNT', 'QQ.exe'),
]) {
  if (c && exists(c)) qqCandidates.push(c);
}
qqPath = qqCandidates[0] || '';

if (qqPath) {
  ok('已安装 PC 版 QQ：' + qqPath);
} else {
  // 不阻断启动：程序本身能开，只是连不上 QQ
  warn('没检测到 PC 版 QQ（NT 架构）。机器人要靠本机 QQ 才能连，装好后再启动一次即可。');
  console.log('         装在非常规目录、或者是绿色版，也会报这一条——不影响程序启动，');
  console.log('         控制台「SnowLuma」页点「启动 QQ」时会自己再找一次。');
}

/* ------------------------------------------------ 4. 基础体检 */
step('4/4 基础体检');
if (exists(P('node_modules', 'electron', 'dist', 'electron.exe'))) ok('Electron 就位');
else fail('node_modules/electron 缺失，压缩包可能没解压完整');

if (exists(P('ui-console', 'index.html'))) ok('控制台已构建（/console/）');
else warn('ui-console 缺失，会自动退回旧面板 /legacy/');

try {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (!cfg.api?.apiKey) warn('还没填 API Key —— 启动后在「设置」页填，顶部体检卡会提示');
  if (!cfg.api?.model) warn('还没选模型 —— 同上');
  if (!(cfg.allow?.groups?.length || cfg.allow?.private?.length)) {
    warn('还没设白名单 —— 不设的话机器人谁都不理（防止乱说话）');
  }
} catch { warn('config.json 读不出来，可能是手动改坏了（删掉它重新启动会自动生成）'); }

console.log('');
console.log(problems ? `有 ${problems} 项必须解决，见上面 [缺失] 行。` : '一切就绪。');
process.exit(problems ? 1 : 0);
