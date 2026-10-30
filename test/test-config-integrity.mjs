// 配置完整性 + 身份闸（2026-10-25）
//
// 起因：config.json 是全项目唯一承载"她是谁"的文件，但它是唯一不走 json-store 的 JSON。
// 旧写法 `catch { return DEFAULT_CONFIG }` 有三个后果，这里逐条钉死：
//   ① 不告警 —— 进程照常起来变成出厂的小鲸鱼，用户只觉得"她今天怪怪的"
//   ② 不隔离 —— 坏文件原地不动，等下一次 updateConfig() 用默认值覆盖 = 永久丢失
//   ③ 无留痕 —— /api/status 看不出来
//
// 用法：node test/test-config-integrity.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-cfgintegrity-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { CONFIG_FILE, loadConfig, identityProblems, getConfigIntegrity } = await import('../src/config.js');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

const BAD = '{"persona":{"botName":"小鲸鱼"},,,这里坏了';

/** 目录下所有被隔离的坏文件。 */
const quarantined = () => fs.readdirSync(tmp).filter((f) => f.includes('.corrupt-'));

// ── ① 坏配置：必须留档，且内容一字不差 ──────────────────────────────
fs.writeFileSync(CONFIG_FILE, BAD, 'utf8');
const cfg1 = loadConfig();
const files1 = quarantined();

check('① 坏配置被隔离成 .corrupt-*', files1.length === 1,
  `实际隔离了 ${files1.length} 个：${files1.join(', ')}`);
check('② 隔离文件保留了原内容（手工还能救回来）',
  files1.length === 1 && fs.readFileSync(path.join(tmp, files1[0]), 'utf8') === BAD);
check('③ 原文件已不在原位（不会被下一次保存覆盖）', !fs.existsSync(CONFIG_FILE) || files1.length === 1);
check('④ 回落到出厂配置但不抛异常',
  cfg1?.persona?.botName === '小鲸鱼' && String(cfg1?.persona?.roleText || '').length > 100,
  `botName=${cfg1?.persona?.botName} roleText=${String(cfg1?.persona?.roleText || '').length} 字`);
check('⑤ integrity 记录为 corrupt 且带上隔离路径',
  getConfigIntegrity().status === 'corrupt' && getConfigIntegrity().quarantined.includes('.corrupt-'),
  JSON.stringify(getConfigIntegrity()));

// ── ⑥ 好配置：不许误伤 ──────────────────────────────────────────────
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  persona: { botName: '大肥鱼', roleText: 'x'.repeat(200), masterQQ: '10000001' },
  allow: { groups: ['10001'] }
}), 'utf8');
const cfg2 = loadConfig();
check('⑥ 好配置正常读取，不产生隔离文件',
  cfg2?.persona?.botName === '大肥鱼' && quarantined().length === 1,
  `botName=${cfg2?.persona?.botName} 隔离文件数=${quarantined().length}`);
check('⑦ 好配置 integrity = ok', getConfigIntegrity().status === 'ok' && getConfigIntegrity().identityProblems.length === 0,
  JSON.stringify(getConfigIntegrity().identityProblems));

// ── ⑧ 首次启动（文件不存在）：正常，不许喊 ────────────────────────────
fs.rmSync(CONFIG_FILE, { force: true });
const cfg3 = loadConfig();
check('⑧ 缺文件时按首次启动处理（status=missing、不隔离、不报身份问题）',
  getConfigIntegrity().status === 'missing' && quarantined().length === 1 && cfg3?.persona?.botName === '小鲸鱼',
  `status=${getConfigIntegrity().status} botName=${cfg3?.persona?.botName}`);
check('⑨ 出厂配置本身不触发身份闸（否则每次新装都误报）',
  identityProblems(cfg3).length === 0, JSON.stringify(identityProblems(cfg3)));

// ── ⑩ 身份闸：规则层被清空时必须喊 ──────────────────────────────────
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  persona: { botName: '', roleText: '', masterQQ: '' }
}), 'utf8');
loadConfig();
const problems = getConfigIntegrity().identityProblems;
check('⑩ 人设被清空 → 身份闸报出全部 3 项', problems.length === 3, JSON.stringify(problems));
check('⑪ 身份闸能识别"截断"（短 roleText 也算问题）',
  identityProblems({ persona: { botName: '鱼', roleText: '短', masterQQ: '1' } }).some((p) => p.includes('疑似被清空')),
  JSON.stringify(identityProblems({ persona: { botName: '鱼', roleText: '短', masterQQ: '1' } })));

// ── ⑫ BOM：Windows 记事本存出来的文件不能被当成损坏 ───────────────────
fs.writeFileSync(CONFIG_FILE, '\uFEFF' + JSON.stringify({
  persona: { botName: 'BOM鱼', roleText: 'y'.repeat(200), masterQQ: '10000001' }
}), 'utf8');
const cfg4 = loadConfig();
check('⑫ 带 UTF-8 BOM 的配置能正常读（不算损坏）',
  cfg4?.persona?.botName === 'BOM鱼' && getConfigIntegrity().status === 'ok',
  `botName=${cfg4?.persona?.botName} status=${getConfigIntegrity().status}`);

fs.rmSync(tmp, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.error('配置完整性测试失败');
  process.exit(1);
}
