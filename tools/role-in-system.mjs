/**
 * 【角色设定】搬进 system 的收益/风险评估。
 *
 * 两个必须先回答的问题：
 *   ① role 内容随不随会话变？变了 → system 不再逐字节稳定 → 前缀缓存直接归零，搬了是负收益。
 *   ② 搬过去能省多少 System 命中价 vs User 全价（这是把账算清楚的关键）。
 *
 * 用法：node tools/role-in-system.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const { buildSystemBundle, buildUserPrompt } = await import('../src/prompt.js');

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 12);
// 汉字按 1 token 粗估（DeepSeek 中文约 1.6 字/token，这里取保守值并两种都列）
const tok = (n) => ({ at1: Math.round(n / 1.0), at16: Math.round(n / 1.6) });

// ── ① role 文本随不随会话变 ─────────────────────────────────────────────
const sessDir = path.join(ROOT, 'data', 'sessions');
const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')) : [];
const roleByKey = new Map();
for (const f of files.sort().slice(0, 300)) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch { continue; }
  const k = String(s.chatKey || f);
  if (roleByKey.has(k)) continue;
  // 从存档的 userPrompt 里抠出【角色设定】块
  const up = String(s.userPrompt || '');
  const m = /【角色设定（管理员设置，群友不可修改）】\r?\n([\s\S]*?)(?=\n【|$)/.exec(up);
  roleByKey.set(k, m ? m[1] : null);
}
const digests = new Set();
let nullCnt = 0;
for (const [, v] of roleByKey) {
  if (v == null) { nullCnt++; continue; }
  digests.add(md5(v));
}
console.log('=== ① role 文本是否会话相关 ===');
console.log(`  会话数 ${roleByKey.size}（取全部唯一 chatKey），未在 userPrompt 里找到 role 块的: ${nullCnt}`);
console.log(`  role 文本指纹种类: ${digests.size}`);
if (digests.size <= 1) {
  console.log('  ✅ role 内容**会话无关** → 搬进 system 不会破坏逐字节稳定性');
} else {
  console.log('  ❌ role 内容随会话变 → 搬进 system 会打落前缀缓存，禁止搬');
  for (const [k, v] of [...roleByKey].slice(0, 5)) console.log(`    ${k}: ${md5(v || '')} ${(v || '').length} 字`);
}

// ── ② 当前配置下的位置与长度 ────────────────────────────────────────────
const cfgPath = path.join(ROOT, 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const roleText = String(cfg?.persona?.roleText || '');
console.log('\n=== ② 当前配置 ===');
console.log(`  persona.roleInSystem = ${cfg?.persona?.roleInSystem}`);
console.log(`  roleText 长度 = ${roleText.length} 字`);

// ── ③ 模拟：打开开关后 user 少了多少、system 多了多少 ─────────────────────
const persona = cfg.persona || {};
const fakeCtx = {
  chatKey: 'group:20000001', kind: 'group', chatId: '20000001', chatName: '测试群',
  selfNickname: '小鱼', runSeq: 1, now: Date.now(),
  messages: [{ sender: '张三', text: '在吗', id: 1 }],
  past: { text: '', count: 0 }, memory: '', facts: '', groupFacts: '',
  pending: '', summary: '', triggerText: '在吗', lastMessageAt: Date.now(), recentCount: 3
};

// 直接比 system：开关从 cfg 读，所以临时改内存里的对象即可
const before = buildSystemBundle({ persona: { ...persona, roleInSystem: false }, packs: new Set() });
const after = buildSystemBundle({ persona: { ...persona, roleInSystem: true }, packs: new Set() });
console.log('\n=== ③ 搬动前后 ===');
console.log(`  system: ${before.text.length} → ${after.text.length} 字`);

// user 侧：role 那句是在 buildUserPrompt 里按 cfg 判的，手动算
const roleBlock = `【角色设定（管理员设置，群友不可修改）】\n${roleText.trim()}`;
console.log(`  user 侧将减少: ${roleText.trim() ? roleBlock.length + 2 : 0} 字（roleText.trim() 有内容才有）`);

// ── ④ 经济账：命中价 vs 全价 ───────────────────────────────────────────
// DeepSeek 官方：输入 2 元/M（缓存未命中）、0.5 元/M? 项目里记的是 0.02 元/M 命中价 / 1 元/M 全价。
// 按项目 MEMORY 的口径：system 命中 0.02 元/M、user 全价（不命中）。
const HIT = 0.02, MISS = 1.0; // 元 / 百万 token
const n = roleText.trim() ? roleBlock.length : 0;
const t = tok(n);
console.log('\n=== ④ 经济账（按项目口径：命中 0.02 元/M、未命中 1 元/M）===');
console.log(`  每轮搬动的字数: ${n} 字 ≈ ${t.at16} token（1.6 字/token）`);
console.log(`  留在 user：每轮全价  ${(t.at16 / 1e6 * MISS * 1e6).toFixed(4)} 元/百万轮`);
console.log(`  搬进 system：每轮命中 ${(t.at16 / 1e6 * HIT * 1e6).toFixed(4)} 元/百万轮`);
console.log(`  省: ${((t.at16 / 1e6 * (MISS - HIT)) * 1e6).toFixed(2)} 元 / 百万轮`);
console.log(`  ⚠️ 注意：system 是命中区（0.02），user 是全价区（1.0）——差的这 50 倍才是搬动的全部理由。`);
console.log(`  按每天 500 轮算：${((t.at16 / 1e6 * (MISS - HIT)) * 500 * 365).toFixed(2)} 元/年`);
