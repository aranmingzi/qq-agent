// 身份快照：导出 / 校验 / 恢复（2026-10-26）
//
// 学自《认知连续性》样例的 snapshot / restore / verify 三件套，但按我们的实情改了两处，
// 这两处**必须钉住**，否则将来会被"照抄样例"的人改回去：
//   ① digest 只算规则层 —— 记忆每天在长，算进去第二天就"对不上"，那不是损坏
//   ② 消息流默认不恢复 —— id 会撞车，且它是隐私大头
//
// 用法：node test/test-identity-snapshot.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-identity-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { updateConfig, getConfig } = await import('../src/config.js');
const { writeJsonAtomic } = await import('../src/json-store.js');
const {
  buildSnapshot, checkSnapshot, restoreSnapshot, digestOfRules, collectRules,
  SNAPSHOT_VERSION, MIN_ROLE_TEXT
} = await import('../src/identity.js');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
function ok(name, fn) {
  try { fn(); check(name, true); } catch (error) { check(name, false, String(error?.message ?? error)); }
}
import assert from 'node:assert/strict';

const ROLE = '你是一条叫小鲸鱼的鱼，说话带一点海风味，喜欢用短句。'.repeat(12);   // 远长于 40 字
const SECRET = 'sk-FAKE-THIS' + '-MUST-NEVER-' + 'LEAVE-THE-MA' + 'CHINE-0001';

// ── 造一份"活着的"身份 ────────────────────────────────────────────────
updateConfig({
  persona: { botName: '小鲸鱼', roleText: ROLE, masterQQ: '10000001', customRules: '不许说自己是AI' },
  // 故意放一把密钥进去，验证快照绝不外带
  providers: [{ name: 'test', baseURL: 'https://example.invalid/v1', apiKey: SECRET, model: 'm1' }]
});
fs.mkdirSync(path.join(tmp, 'memory', 'facts'), { recursive: true });
writeJsonAtomic(path.join(tmp, 'memory', 'facts', '10001.json'), {
  qq: '10001',
  facts: [{ id: 'a1', text: '他喜欢在深夜发长语音', kind: 'fact', weight: 1, createdAt: 1, updatedAt: 1, source: 'group:1' }]
});
writeJsonAtomic(path.join(tmp, 'memory', 'group_1.json'), {
  activeTopic: [{ content: '在聊要不要换头像', createdAt: 1 }], pendingThought: [], memberImpression: [], lastConsolidatedAt: 0
});
fs.mkdirSync(path.join(tmp, 'diary', 'group_1'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'diary', 'group_1', '2026-10-24.md'), '# 今天\n群里很安静。\n', 'utf8');
// 这条不该进快照：发过 QQ 空间的简版是发布记录，不是身份
fs.writeFileSync(path.join(tmp, 'diary', 'group_1', '2026-10-24.public.json'), '{}', 'utf8');
fs.mkdirSync(path.join(tmp, 'messages'), { recursive: true });
writeJsonAtomic(path.join(tmp, 'messages', 'group_1.json'), {
  chatKey: 'group:1', nextLocalId: 6,
  messages: Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, mid: 1000 + i, ts: 1792000000000 + i * 1000, senderId: i % 2 ? 'self' : '10001',
    senderName: i % 2 ? '我' : '阿七', text: `第${i + 1}句`, self: !!(i % 2), read: true, reply: null, media: []
  }))
});

// ── ① 快照内容 ────────────────────────────────────────────────────────
const snap = buildSnapshot({ perChat: 3 });
check('① 快照版本与三要素齐全',
  snap.version === SNAPSHOT_VERSION && snap.botName === '小鲸鱼'
  && snap.rules?.persona?.roleText === ROLE && snap.memory && snap.recent,
  JSON.stringify({ version: snap.version, botName: snap.botName }));
check('② 记忆层搬齐了 facts / 会话记忆 / 日记 / 摘要',
  snap.stats.facts === 1 && snap.stats.chatMemories === 1 && snap.stats.diaryDays === 1,
  JSON.stringify(snap.stats));
check('③ 消息流只取最近 N 条（默认 40，这里传 3）',
  snap.stats.recentMessages === 3 && snap.recent['group:1'].length === 3,
  `实际 ${snap.stats.recentMessages} 条`);
check('④ 日记只搬正文 .md，不搬 .public.json 发布记录',
  Object.keys(snap.memory.diary.group_1).length === 1);
check('⑤ 消息流不夹带媒体（图片/语音路径搬过去是死链）',
  Object.values(snap.recent).flat().every((m) => !('media' in m)));

// ── ⑥ 绝不带密钥 ──────────────────────────────────────────────────────
const raw = JSON.stringify(snap);
check('⑥ 快照里不含任何密钥（providers.apiKey / token）',
  !raw.includes(SECRET) && !raw.includes('apiKey') && !raw.includes('token'),
  raw.includes(SECRET) ? '⚠️ 密钥泄漏进快照了' : '');

// ── ⑦ digest 只盖规则层（本模块最重要的设计决策）─────────────────────
ok('⑦ digest 稳定：同一份内容两次导出一致', () => {
  assert.strictEqual(buildSnapshot().digest, snap.digest);
});
ok('⑧ 改记忆**不**改 digest（记忆每天在长，那不是损坏）', () => {
  writeJsonAtomic(path.join(tmp, 'memory', 'facts', '10002.json'), {
    qq: '10002', facts: [{ id: 'b1', text: '新来的群友', weight: 1 }]
  });
  assert.strictEqual(buildSnapshot().digest, snap.digest, '记忆变了 digest 也跟着变 = 第二天必然"对不上"');
});
ok('⑨ 改规则**必须**改 digest（规则变了就是真的被改了）', () => {
  const rules = collectRules(getConfig());
  const changed = { ...rules, persona: { ...rules.persona, botName: '别的鱼' } };
  assert.notStrictEqual(digestOfRules(changed), digestOfRules(rules));
});
ok('⑩ 键顺序不同也算同一个摘要（stable stringify）', () => {
  const a = { x: 1, y: { b: 2, a: 1 } };
  const b = { y: { a: 1, b: 2 }, x: 1 };
  assert.strictEqual(digestOfRules(a), digestOfRules(b));
});

// ── ⑪ 校验闸门 ────────────────────────────────────────────────────────
check('⑪ 好快照通过校验', checkSnapshot(snap).ok === true, JSON.stringify(checkSnapshot(snap).problems));
ok('⑫ 缺 botName 被拦（没有名字就不是她）', () => {
  const r = checkSnapshot({ ...snap, rules: { ...snap.rules, persona: { ...snap.rules.persona, botName: '  ' } } });
  assert.ok(!r.ok && r.problems.some((p) => p.includes('botName')));
});
ok(`⑬ roleText 短于 ${MIN_ROLE_TEXT} 字被拦（被截断也算，不只是全空）`, () => {
  const r = checkSnapshot({ ...snap, rules: { ...snap.rules, persona: { ...snap.rules.persona, roleText: '你是一条鱼' } } });
  assert.ok(!r.ok && r.problems.some((p) => p.includes('roleText')));
});
ok('⑭ digest 对不上被拦（规则被改过 / 文件损坏）', () => {
  const r = checkSnapshot({ ...snap, digest: 'deadbeef'.repeat(8) });
  assert.ok(!r.ok && r.problems.some((p) => p.includes('摘要不符')));
});
ok('⑮ 版本高于程序支持被拦（避免新快照被老程序读歪）', () => {
  const r = checkSnapshot({ ...snap, version: SNAPSHOT_VERSION + 1 });
  assert.ok(!r.ok && r.problems.some((p) => p.includes('版本')));
});

// ── ⑯ 恢复 ────────────────────────────────────────────────────────────
ok('⑯ dryRun 只校验不写盘', () => {
  updateConfig({ persona: { botName: '临时改坏的名字', roleText: ROLE } });
  const r = restoreSnapshot(snap, { dryRun: true });
  assert.ok(r.ok && r.dryRun);
  assert.strictEqual(getConfig().persona.botName, '临时改坏的名字', 'dryRun 竟然真写了');
});
ok('⑰ 真恢复：人设与规则写回', () => {
  const r = restoreSnapshot(snap);
  assert.ok(r.ok && !r.dryRun);
  assert.strictEqual(getConfig().persona.botName, '小鲸鱼');
  assert.strictEqual(getConfig().persona.roleText, ROLE);
  assert.ok(r.restored.includes('persona') && r.restored.includes('facts'));
});
ok('⑱ 恢复前现有身份已备份（改了还能回头）', () => {
  const dir = path.join(tmp, 'backups', 'identity');
  const dirs = fs.readdirSync(dir);
  assert.ok(dirs.length >= 1, '没有生成备份目录');
  assert.ok(fs.existsSync(path.join(dir, dirs[0], 'config.json')), '备份里没有 config.json');
  assert.ok(fs.existsSync(path.join(dir, dirs[0], 'memory')), '备份里没有 memory');
});
ok('⑲ 恢复后 facts 文件落盘且内容对得上', () => {
  const f = JSON.parse(fs.readFileSync(path.join(tmp, 'memory', 'facts', '10001.json'), 'utf8'));
  assert.strictEqual(f.facts[0].text, '他喜欢在深夜发长语音');
});
ok('⑳ 消息流默认**不**恢复，且明确告知后果', () => {
  const r = restoreSnapshot(snap);
  assert.ok(!r.restored.includes('recent'), '默认恢复了消息流（id 会撞车）');
  assert.ok(r.warnings.some((w) => w.includes('消息流未恢复')), '没有告知风格画像会重算');
});
ok('㉑ 坏人设恢复抛错，且 problems 可读', () => {
  try {
    restoreSnapshot({ ...snap, rules: { ...snap.rules, persona: { botName: '', roleText: '' } } });
    assert.fail('坏人设竟然恢复成功了');
  } catch (error) {
    assert.ok(Array.isArray(error.problems) && error.problems.length >= 2, '错误信息里没有可读的 problems');
  }
});
ok('㉒ 非法键被跳过而不是写坏（facts 键必须是 QQ 号）', () => {
  const r = restoreSnapshot({ ...snap, memory: { ...snap.memory, facts: { '../../evil': { facts: [] } } } });
  assert.ok(r.warnings.some((w) => w.includes('跳过非法')), '非法键被写进去了');
});

// ── ㉓ 属性级校验（P2）：导出 → 恢复 → 还是不是同一个人 ─────────────────
const { verifyIdentity, selfTestVerify, IDENTITY_PROBES } = await import('../src/identity.js');

ok('㉓ 探针自检：每条探针的坏样本必须被抓到（否则"全过"是假象）', () => {
  const st = selfTestVerify(snap);
  assert.ok(st.ok, st.failures.join('；'));
});
ok('㉔ 探针自检能发现自己失效（把探针改成永远通过，selfTest 必须红）', () => {
  const saved = IDENTITY_PROBES[0].compare;
  IDENTITY_PROBES[0].compare = () => ({ ok: true, detail: '' });
  const st = selfTestVerify(snap);
  IDENTITY_PROBES[0].compare = saved;
  assert.ok(!st.ok, '探针改成永远返回 true 后，selfTest 竟然还是绿的');
});
ok('㉕ round-trip：导出 → 恢复 → 再导出，身份等价', () => {
  const before = buildSnapshot({ perChat: 3 });
  restoreSnapshot(before);
  const after = buildSnapshot({ perChat: 3 });
  const v = verifyIdentity(before, after);
  assert.ok(v.ok, v.checks.filter((c) => !c.ok).map((c) => `${c.id}(${c.detail})`).join('；'));
});
ok('㉖ 换了人设必须被认出来（不是同一个人）', () => {
  const before = buildSnapshot({ perChat: 3 });
  updateConfig({ persona: { botName: '换了个人', roleText: ROLE } });
  const after = buildSnapshot({ perChat: 3 });
  const v = verifyIdentity(before, after);
  assert.ok(!v.ok && v.checks.find((c) => c.id === 'botname')?.ok === false);
  updateConfig({ persona: { botName: '小鲸鱼', roleText: ROLE } });   // 还原，别影响后面
});
ok('㉗ 校验明确列出"没比什么"（不写出来的话，通过容易被当成全都比了）', () => {
  const v = verifyIdentity(snap, snap);
  assert.ok(v.skipped.length >= 1 && v.skipped[0].includes('recent'));
});

// ── ㉘ config.json schema 版本 ────────────────────────────────────────
const { CONFIG_SCHEMA, applySchema } = await import('../src/config.js');
ok('㉘ 出厂配置带 schema 版本号', () => {
  assert.strictEqual(Number(getConfig().schema), CONFIG_SCHEMA);
});
ok('㉙ 旧文件（无 schema 字段）视为 0 并迁移到当前版本', () => {
  const merged = applySchema({ ...getConfig() }, { persona: { botName: '小鲸鱼' } });   // raw 里没有 schema
  assert.strictEqual(Number(merged?.schema ?? getConfig().schema), CONFIG_SCHEMA);
});

// ── ㉚ 空字段不许覆盖本机值（2026-10-26 修的真 bug）────────────────────
// 场景：从一台没配主人的机器导出快照，恢复到一台配好的机器。
// 旧写法会把 '' 写进 config → 主人识别静默失效（比失忆更糟：她会把别人当主人）。
ok('㉚ 快照里的空字段不会清空本机已有值（masterQQ / selfNickname）', () => {
  updateConfig({ persona: { masterQQ: '10000001', selfNickname: '小鱼' } });
  const poor = {
    ...snap,
    rules: { ...snap.rules, persona: { ...snap.rules.persona, masterQQ: '', selfNickname: '' } },
    digest: digestOfRules({ ...snap.rules, persona: { ...snap.rules.persona, masterQQ: '', selfNickname: '' } })
  };
  restoreSnapshot(poor);
  assert.strictEqual(getConfig().persona.masterQQ, '10000001', 'masterQQ 被空值清掉了');
  assert.strictEqual(getConfig().persona.selfNickname, '小鱼', 'selfNickname 被空值清掉了');
});
ok('㉛ 但非空字段照常覆盖（别把"不覆盖"写成"永远不改"）', () => {
  const changed = {
    ...snap,
    rules: { ...snap.rules, persona: { ...snap.rules.persona, masterQQ: '10001' } },
    digest: digestOfRules({ ...snap.rules, persona: { ...snap.rules.persona, masterQQ: '10001' } })
  };
  restoreSnapshot(changed);
  assert.strictEqual(getConfig().persona.masterQQ, '10001');
  updateConfig({ persona: { masterQQ: '10000001' } });   // 还原
});
ok('㉜ 缺 memory 的快照必须说出来，不能静默报成功', () => {
  const bare = { ...snap, memory: {} };
  const r = restoreSnapshot(bare);
  assert.ok(r.warnings.some((w) => w.includes('没有任何记忆')), '一条记忆都没恢复却没提示');
});

// ── 收尾 ──────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n身份快照：${checks.length - failed.length} 项通过 / 共 ${checks.length} 项`);
if (failed.length) {
  console.error('❌ 失败项：\n' + failed.map((f) => `  - ${f.name}${f.detail ? `：${f.detail}` : ''}`).join('\n'));
  process.exit(1);
}
