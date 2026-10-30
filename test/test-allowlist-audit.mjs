// 白名单变更审计：白名单是静默生效的硬边界，少一个群 = 那个群里她彻底消失
// （不收消息、不回话、连聊天记录都不留），事后必须能查到"什么时候被谁去掉的"。
// 这里固定住的是：改一次记一行、added/removed 算得对、没改就不写。
// 用法：node test/test-allowlist-audit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须重定向数据目录：否则会往生产 config.json 里写测试数据
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-allow-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { updateConfig, CONFIG_FILE } = await import('../src/config.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail += 1;
    process.exitCode = 1;
    console.log(`✗ ${name}\n    ${error?.message ?? error}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  }
}

const AUDIT_FILE = path.join(tmp, 'config-changes.jsonl');
const readAudit = () =>
  fs.existsSync(AUDIT_FILE)
    ? fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

// 打底：先写入一个已知白名单（这次不应产生"移除"记录，但会有新增）
updateConfig({ allow: { groups: ['g1', 'g2', 'g3'], private: ['p1'] } });

ok('改了白名单必须留一行审计', () => {
  const rows = readAudit();
  assert(rows.length >= 1, '审计文件里没有记录');
  const last = rows[rows.length - 1];
  eq(last.after.groups, ['g1', 'g2', 'g3'], '审计里的 after.groups');
  assert(typeof last.at === 'string' && last.at.includes('T'), 'at 应是 ISO 时间');
});

ok('新增群 → added 里有它，removed 为空', () => {
  const before = readAudit().length;
  updateConfig({ allow: { groups: ['g1', 'g2', 'g3', 'g4'] } });
  const rows = readAudit();
  assert(rows.length === before + 1, '应该只多一行');
  const last = rows[rows.length - 1];
  eq(last.added, ['g4'], 'added');
  eq(last.removed, [], 'removed');
});

ok('移除群 → removed 里有它（这是"她突然不说话"的典型原因）', () => {
  const before = readAudit().length;
  updateConfig({ allow: { groups: ['g1', 'g3'] } });   // 去掉 g2、g4
  const rows = readAudit();
  assert(rows.length === before + 1, '应该只多一行');
  const last = rows[rows.length - 1];
  eq(last.removed, ['g2', 'g4'], 'removed');
  eq(last.added, [], 'added');
  eq(last.before.groups, ['g1', 'g2', 'g3', 'g4'], 'before 必须是改之前的样子');
});

ok('只改 deny 也要记（deny 是"永久拒绝"，比 allow 更硬）', () => {
  const before = readAudit().length;
  updateConfig({ deny: { groups: ['bad1'] } });
  const rows = readAudit();
  assert(rows.length === before + 1, 'deny 变更也必须留痕');
  eq(rows[rows.length - 1].after.denyGroups, ['bad1'], 'denyGroups');
});

ok('跟白名单无关的改动不写审计（避免把文件刷爆）', () => {
  const before = readAudit().length;
  updateConfig({ send: { maxPerMinute: 3 } });
  eq(readAudit().length, before, '普通配置项不该产生白名单审计');
});

ok('allowAllWhenEmpty 翻转也要记（它决定"名单为空时她还能不能说话"）', () => {
  const before = readAudit().length;
  updateConfig({ allowAllWhenEmpty: true });
  const rows = readAudit();
  assert(rows.length === before + 1, 'allowAllWhenEmpty 变更没留痕');
  eq(rows[rows.length - 1].after.allowAllWhenEmpty, true, 'after.allowAllWhenEmpty');
});

ok('同一份配置连写两次，第二次不产生记录', () => {
  updateConfig({ allow: { groups: ['g1', 'g3'] } });
  const before = readAudit().length;
  updateConfig({ allow: { groups: ['g1', 'g3'] } });
  eq(readAudit().length, before, '内容没变就不该写');
});

ok('审计不污染主配置（白名单本身仍然正确落盘）', () => {
  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  eq(saved.allow.groups, ['g1', 'g3'], 'config.json 里的 allow.groups');
  assert(!('added' in saved) && !('before' in saved), '审计字段不能混进 config.json');
});

console.log(`\n${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`);
