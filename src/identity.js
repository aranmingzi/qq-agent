//
// 身份快照：把「她是谁」从一台机器搬到另一台机器。
//
// 来源：2026-10-25 学习的《认知连续性》样例 —— 迁移的不是权重，是「规则 + 记录 + 状态」。
// 但两处必须按我们的实情改：
//
//  1) 样例的 digest 覆盖整个快照。我们**不能**照做：facts 每天自动增删衰减、
//     日记每天都在写，整个快照算摘要第二天必对不上 —— 那不是损坏，是活着的痕迹。
//     → digest **只算规则层**（规则不会自己变，变了就是真的被改了）。
//
//  2) 样例说「回答只依赖三样」。我们实测还依赖**第四样：最近消息流**
//     （style-profile 不落盘，每轮从最近 40 条现算 —— 没有它，换台机器说话方式就变）。
//     → 快照带上最近消息流，但恢复时默认不写回（见 restoreSnapshot 的理由）。
//
// ⚠️ 本模块**绝不碰密钥**：providers / server.token / 各家 apiKey 一概不进快照。
//    快照文件里全是明文（人设、日记、群友发言），导出即视为敏感文件。
//
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, getConfig, updateConfig, MIN_ROLE_TEXT } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

export const SNAPSHOT_VERSION = 1;

// 阈值从 config.js 导入，不在这里再写一份：两边各写一份必然有一天改一处漏一处，
// 出现"快照校验说合格、运行时身份闸说不合格"的分裂。
export { MIN_ROLE_TEXT };

export const IDENTITY_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'identity');

// 规则层字段。这些值只有人改才会变，所以它们是 digest 的唯一输入。
const RULE_FIELDS = [
  'botName', 'selfNickname', 'roleText', 'participation', 'customRules', 'masterQQ', 'roleInSystem'
];

const FACTS_DIR = path.join(DATA_DIR, 'memory', 'facts');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const DIARY_DIR = path.join(DATA_DIR, 'diary');
const SUMMARY_DIR = path.join(DATA_DIR, 'summary');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

/**
 * 稳定序列化：对象键排序，保证同一份内容在任何机器上算出同一个摘要。
 * JSON.stringify 的键顺序跟着插入顺序走，直接 stringify 会因写入路径不同而对不上。
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ── 采集 ────────────────────────────────────────────────────────────────

/** 规则层。digest 只由它决定。 */
export function collectRules(cfg = getConfig()) {
  const p = cfg.persona || {};
  const persona = {};
  for (const f of RULE_FIELDS) persona[f] = p[f] ?? '';
  return {
    persona,
    customPersonas: cfg.customPersonas || [],
    personaBindings: cfg.personaBindings || {},
    personaModes: cfg.personaModes || {},
    identityModes: cfg.identityModes || {}
  };
}

export function digestOfRules(rules) {
  return sha256(stableStringify(rules));
}

function readDirJson(dir, pattern) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    const data = readJsonSafe(path.join(dir, name), null);
    if (data == null) continue;
    out[name.replace(/\.json$/, '')] = data;
  }
  return out;
}

/** 记忆层：facts（跨群）+ 会话记忆 + 日记 + 往事摘要。全都按 chatKey/QQ 分文件。 */
export function collectMemory() {
  const facts = readDirJson(FACTS_DIR, /^\d+\.json$/);
  // 会话记忆文件名是 group_123 / private_456（下划线），chatKey 是 group:123
  const sessions = readDirJson(MEMORY_DIR, /^(group|private)_[\w-]+\.json$/);
  const summaries = readDirJson(SUMMARY_DIR, /^.+\.json$/);

  const diary = {};
  if (fs.existsSync(DIARY_DIR)) {
    for (const slug of fs.readdirSync(DIARY_DIR)) {
      const dir = path.join(DIARY_DIR, slug);
      if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      const days = {};
      for (const f of fs.readdirSync(dir)) {
        // 只搬正文 .md。.public.json 是发过 QQ 空间的简版，属于发布记录不是身份。
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
        try { days[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { /* 读不动就跳过 */ }
      }
      if (Object.keys(days).length) diary[slug] = days;
    }
  }
  return { facts, sessions, diary, summaries };
}

/**
 * 最近消息流 —— 我们的「第四样依赖」。
 * style-profile 每轮从最近 40 条现算，不落盘；没有它，换台机器说话方式就变。
 * 只留最小字段：媒体（图片/语音二进制路径）一概不搬，搬过去也是死链。
 */
export function collectRecent({ perChat = 40 } = {}) {
  const n = Math.max(0, Math.min(500, Math.floor(Number(perChat) || 0)));
  if (!n || !fs.existsSync(MESSAGES_DIR)) return {};
  const out = {};
  for (const name of fs.readdirSync(MESSAGES_DIR)) {
    if (!/^(group|private)_[\w-]+\.json$/.test(name)) continue;
    const data = readJsonSafe(path.join(MESSAGES_DIR, name), null);
    const list = Array.isArray(data?.messages) ? data.messages : null;
    if (!list || !list.length) continue;
    out[String(data.chatKey || name.replace(/\.json$/, '').replace('_', ':'))] = list.slice(-n).map((m) => ({
      ts: m.ts ?? null,
      senderId: String(m.senderId ?? ''),
      senderName: String(m.senderName ?? ''),
      text: String(m.text ?? ''),
      self: !!m.self
    }));
  }
  return out;
}

// ── 快照 ────────────────────────────────────────────────────────────────

export function buildSnapshot({ perChat = 40, includeRecent = true } = {}) {
  const cfg = getConfig();
  const rules = collectRules(cfg);
  const memory = collectMemory();
  const recent = includeRecent ? collectRecent({ perChat }) : {};
  const snap = {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    botName: rules.persona.botName || '',
    rules,
    memory,
    recent,
    digest: ''
  };
  // digest 只盖规则层 —— 记忆每天在长，把记忆算进去的话第二天就"对不上"了，
  // 而那不是损坏。规则变了才是真的变了。
  snap.digest = digestOfRules(rules);
  snap.stats = {
    facts: Object.values(memory.facts).reduce((n, f) => n + (Array.isArray(f?.facts) ? f.facts.length : 0), 0),
    factOwners: Object.keys(memory.facts).length,
    chatMemories: Object.keys(memory.sessions).length,
    diaryDays: Object.values(memory.diary).reduce((n, d) => n + Object.keys(d).length, 0),
    summaries: Object.keys(memory.summaries).length,
    chats: Object.keys(recent).length,
    recentMessages: Object.values(recent).reduce((n, r) => n + r.length, 0),
    bytes: Buffer.byteLength(JSON.stringify(snap), 'utf8')
  };
  return snap;
}

// ── 校验 ────────────────────────────────────────────────────────────────

/**
 * 恢复前的闸门。规则缺失就是"变成了别的东西"，宁可报错也不许凑合着活
 * —— 这是样例里最值得抄的一条（它 restore 时先查规则非空、再查摘要）。
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkSnapshot(snap) {
  const problems = [];
  if (!snap || typeof snap !== 'object') return { ok: false, problems: ['快照不是对象'] };
  if (Number(snap.version) > SNAPSHOT_VERSION) {
    problems.push(`快照版本 ${snap.version} 高于本程序支持的 ${SNAPSHOT_VERSION}（请先升级）`);
  }
  const p = snap.rules?.persona || {};
  if (!String(p.botName || '').trim()) problems.push('缺少 botName：没有名字就不是她');
  if (String(p.roleText || '').trim().length < MIN_ROLE_TEXT) {
    problems.push(`roleText 只有 ${String(p.roleText || '').trim().length} 字（少于 ${MIN_ROLE_TEXT}）：人设被截断或为空`);
  }
  if (snap.digest) {
    const actual = digestOfRules(snap.rules || {});
    if (actual !== snap.digest) {
      problems.push(`摘要不符：快照自称 ${String(snap.digest).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…（规则被改过或文件损坏）`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── 属性级校验（P2）────────────────────────────────────────────────────
//
// 样例的 verify() 是"把同一组探针再问一遍，答案必须逐字一致"。
// 我们**不能用**：她的输出要过 LLM，还带 35% 随机少一条气泡、工具调用、限流省略，
// 逐字比对只会得到一条永远红、很快被人注释掉的测试。
//
// 改成比**属性**（和 rule-audit.js 的 sample{bad,good} 一个思路）：
// 每条探针自带 bad/good 样本，selfTest 先跑一遍证明探针本身有效 ——
// 否则"全部通过"到底是"身份真的没变"还是"探针根本没写对"，分不出来。
//
// ⚠️ 不比消息流：恢复时默认就不写它（见 restoreSnapshot）。
//    它不是身份，是语料；不写也不算丢。

const factTexts = (snap) => Object.values(snap?.memory?.facts || {})
  .flatMap((f) => (Array.isArray(f?.facts) ? f.facts.map((x) => String(x?.text ?? '').trim()) : []))
  .filter(Boolean);

const diaryDays = (snap) => Object.values(snap?.memory?.diary || {})
  .reduce((n, d) => n + Object.keys(d || {}).length, 0);

export const IDENTITY_PROBES = [
  {
    id: 'rules-digest',
    name: '规则层摘要',
    why: '规则变了就不是她了（这是唯一必须严格相等的一项）',
    // ⚠️ 必须**实时重算**，不能比快照里存的那串 digest：
    // 手改过 rules 却没重算 digest 的文件，比存储值会两边都"对得上"，
    // 于是这条探针形同虚设 —— 是 selfTest 的坏样本把它抓出来的。
    compare: (a, b) => {
      const ra = digestOfRules(a?.rules || {});
      const rb = digestOfRules(b?.rules || {});
      return { ok: ra === rb, detail: `${ra.slice(0, 12)}… vs ${rb.slice(0, 12)}…` };
    },
    sample: {
      good: (s) => ({ ...s }),
      bad: (s) => ({ ...s, rules: { ...s.rules, persona: { ...s.rules.persona, botName: '换了个人' } } })
    }
  },
  {
    id: 'botname',
    name: '名字',
    why: '名字是身份的门牌，也是人设能不能对上号的前提',
    compare: (a, b) => ({
      ok: String(a?.botName || '') === String(b?.botName || ''),
      detail: `${a?.botName || '(空)'} vs ${b?.botName || '(空)'}`
    }),
    sample: { good: (s) => ({ ...s }), bad: (s) => ({ ...s, botName: '别的名字' }) }
  },
  {
    id: 'master',
    name: '主人 QQ',
    why: '认错主人比失忆更糟 —— 她会把别人当主人',
    compare: (a, b) => ({
      ok: String(a?.rules?.persona?.masterQQ || '') === String(b?.rules?.persona?.masterQQ || ''),
      detail: `${a?.rules?.persona?.masterQQ || '(空)'} vs ${b?.rules?.persona?.masterQQ || '(空)'}`
    }),
    sample: {
      good: (s) => ({ ...s }),
      bad: (s) => ({ ...s, rules: { ...s.rules, persona: { ...s.rules.persona, masterQQ: '999999' } } })
    }
  },
  {
    id: 'facts-set',
    name: '事实条目集合',
    why: '记得谁、记得什么事 —— 顺序和权重会漂移，集合本身不该变',
    compare: (a, b) => {
      const x = new Set(factTexts(a));
      const y = new Set(factTexts(b));
      const missing = [...x].filter((t) => !y.has(t));
      return { ok: missing.length === 0 && x.size === y.size, detail: `${x.size} 条 vs ${y.size} 条${missing.length ? `，少了 ${missing.length} 条` : ''}` };
    },
    sample: {
      good: (s) => ({ ...s }),
      bad: (s) => ({
        ...s,
        memory: { ...s.memory, facts: {} }
      })
    }
  },
  {
    id: 'diary-days',
    name: '日记天数',
    why: '日记是她的经历，少一天就是少一段',
    compare: (a, b) => {
      const x = diaryDays(a);
      const y = diaryDays(b);
      return { ok: x === y, detail: `${x} 天 vs ${y} 天` };
    },
    sample: { good: (s) => ({ ...s }), bad: (s) => ({ ...s, memory: { ...s.memory, diary: {} } }) }
  }
];

/**
 * 比两份快照是不是"同一个人"。
 * @returns {{ok:boolean, checks:{id,name,ok,detail,why}[], skipped:string[]}}
 */
export function verifyIdentity(before, after) {
  const checks = IDENTITY_PROBES.map((p) => {
    let r;
    try { r = p.compare(before, after); } catch (error) { r = { ok: false, detail: `探针异常：${error?.message ?? error}` }; }
    return { id: p.id, name: p.name, why: p.why, ok: !!r.ok, detail: r.detail || '' };
  });
  return {
    ok: checks.every((c) => c.ok),
    checks,
    // 明确列出没比什么 —— 不写出来的话，"通过"容易被当成"全都比过了"
    skipped: ['recent（消息流不参与身份校验：恢复时默认不写，它是语料不是身份）']
  };
}

/**
 * 证明探针本身有效：good 必须过、bad 必须**不过**，且不过的必须是它自己那条。
 * 少了这一步，"5/5 通过"到底是身份没变还是探针写错了，永远说不清。
 * @returns {{ok:boolean, failures:string[]}}
 */
export function selfTestVerify(baseSnapshot) {
  const failures = [];
  if (!baseSnapshot || typeof baseSnapshot !== 'object') return { ok: false, failures: ['没有可用的基准快照'] };
  for (const p of IDENTITY_PROBES) {
    if (!p.sample) { failures.push(`${p.id} 缺少样本（没样本的探针不算数）`); continue; }
    const good = verifyIdentity(baseSnapshot, p.sample.good(baseSnapshot));
    if (!good.checks.find((c) => c.id === p.id)?.ok) {
      failures.push(`${p.id}：好样本竟然不通过（探针过严）`);
    }
    const bad = verifyIdentity(baseSnapshot, p.sample.bad(baseSnapshot));
    const self = bad.checks.find((c) => c.id === p.id);
    if (self?.ok) failures.push(`${p.id}：坏样本竟然通过了（探针根本没在检查）`);
  }
  return { ok: failures.length === 0, failures };
}

// ── 恢复 ────────────────────────────────────────────────────────────────

/**
 * 递归复制。返回 `{ copied, failed }` —— 失败数**必须**回传。
 * 2026-10-26：以前只回传成功数、失败被 `catch {}` 吞掉，于是"备份只成功了一半"
 * 看起来和"备份完整"一模一样（Windows 上文件被杀软/另一句柄占用时 EPERM 很常见）。
 * 用 lstatSync 而不是 statSync：符号链接/junction 不该被跟随递归。
 */
function copyDirIfExists(src, dst) {
  const out = { copied: 0, failed: 0 };
  if (!fs.existsSync(src)) return out;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const st = fs.lstatSync(s, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      const sub = copyDirIfExists(s, path.join(dst, name));
      out.copied += sub.copied;
      out.failed += sub.failed;
      continue;
    }
    if (!st.isFile()) continue;
    try { fs.copyFileSync(s, path.join(dst, name)); out.copied += 1; } catch { out.failed += 1; }
  }
  return out;
}

/**
 * 恢复。先备份、先校验、再写；任一步失败都不留下半截状态。
 *
 * ⚠️ 默认**不恢复消息流**：
 *   ① 消息 id / mid 会和本机已有的撞车，硬写会制造重复消息；
 *   ② 它是隐私大头（群友发言原文），跨机器搬运没必要；
 *   ③ 恢复它也不能让 style-profile 立刻对 —— 那玩意儿本来就每轮现算。
 *   需要就显式传 includeRecent:true，后果自负。
 */
export function restoreSnapshot(snap, { includeRecent = false, dryRun = false } = {}) {
  const check = checkSnapshot(snap);
  if (!check.ok) {
    const err = new Error(`快照不可用：${check.problems.join('；')}`);
    err.problems = check.problems;
    throw err;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(IDENTITY_BACKUP_DIR, `before-restore-${stamp}`);
  const restored = [];
  const warnings = [];

  if (!dryRun) {
    let backedUp = 0;
    let backupFailed = 0;
    // 只备份身份相关的小目录。**绝不能**把 data/voice（116MB）、data/sticker-files（89MB）
    // 这类大目录卷进来 —— 那不是身份，是素材库。
    // includeRecent 时才加 messages：因为只有那时才会去覆盖写它（覆盖写又没备份 = 真丢）。
    const plan = [
      [MEMORY_DIR, 'memory'],
      [DIARY_DIR, 'diary'],
      [SUMMARY_DIR, 'summary'],
      [path.join(DATA_DIR, 'config.json'), '']
    ];
    if (includeRecent) plan.unshift([MESSAGES_DIR, 'messages']);
    for (const [src, sub] of plan) {
      try {
        if (sub === '') {
          if (!fs.existsSync(src)) continue;
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(src, path.join(backupDir, 'config.json'));
          backedUp += 1;
        } else {
          const r = copyDirIfExists(src, path.join(backupDir, sub));
          backedUp += r.copied;
          backupFailed += r.failed;
        }
      } catch (error) {
        // 备份失败就停手：宁可什么都不做，也不要"改了却没法回头"。
        const err = new Error(`备份现有身份失败，已中止恢复：${error?.message ?? error}`);
        throw err;
      }
    }
    if (backupFailed > 0) {
      warnings.push(`现有身份备份不完整：${backupFailed} 个文件没备份成功（多半是被占用），恢复仍会继续 —— 出问题请到 ${backupDir} 核对`);
    }
    if (backedUp === 0) warnings.push('没有可备份的现有身份（可能是全新安装）');
  }

  const r = snap.rules || {};
  const persona = {};
  // ⚠️ 空值**不写**。collectRules 把缺字段归一化成了 ''，而 updateConfig 是深度合并，
  // '' 不是 undefined —— 照写会把本机已有的 masterQQ / selfNickname / customRules 清空。
  // 后果是"从一台没配主人的机器导出，恢复到配好的机器" → 主人识别静默失效。
  // 想清空某个字段请用控制台，那不是快照的职责。
  for (const f of RULE_FIELDS) {
    const v = r.persona?.[f];
    if (v !== undefined && String(v ?? '').trim() !== '') persona[f] = v;
  }

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      restored: ['persona', 'customPersonas', 'personaBindings', 'facts', 'sessions', 'diary', 'summaries'],
      backupDir: '', warnings
    };
  }

  const mem = snap.memory || {};
  if (!mem.facts && !mem.sessions && !mem.diary && !mem.summaries) {
    // 2026-10-26：以前缺 memory 就静默跳过，照样返回 ok:true ——
    // 调用方（控制台）会以为"恢复成功"，实际一条记忆都没回来。
    warnings.push('快照里没有任何记忆（facts/会话记忆/日记/摘要全空）：只恢复了规则层');
  }
  if (mem.facts && typeof mem.facts === 'object') {
    fs.mkdirSync(FACTS_DIR, { recursive: true });
    for (const [qq, data] of Object.entries(mem.facts)) {
      if (!/^\d+$/.test(String(qq))) { warnings.push(`跳过非法 QQ 键：${qq}`); continue; }
      writeJsonAtomic(path.join(FACTS_DIR, `${qq}.json`), data);
    }
    restored.push('facts');
  }
  if (mem.sessions && typeof mem.sessions === 'object') {
    for (const [key, data] of Object.entries(mem.sessions)) {
      if (!/^(group|private)_[\w-]+$/.test(String(key))) { warnings.push(`跳过非法记忆键：${key}`); continue; }
      writeJsonAtomic(path.join(MEMORY_DIR, `${key}.json`), data);
    }
    restored.push('sessions');
  }
  if (mem.diary && typeof mem.diary === 'object') {
    for (const [slug, days] of Object.entries(mem.diary)) {
      if (!/^[\w-]+$/.test(String(slug))) { warnings.push(`跳过非法日记键：${slug}`); continue; }
      for (const [date, text] of Object.entries(days || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) { warnings.push(`跳过非法日期：${date}`); continue; }
        fs.mkdirSync(path.join(DIARY_DIR, slug), { recursive: true });
        fs.writeFileSync(path.join(DIARY_DIR, slug, `${date}.md`), String(text ?? ''), 'utf8');
      }
    }
    restored.push('diary');
  }
  if (mem.summaries && typeof mem.summaries === 'object') {
    for (const [key, data] of Object.entries(mem.summaries)) {
      if (!/^[\w-]+$/.test(String(key))) { warnings.push(`跳过非法摘要键：${key}`); continue; }
      writeJsonAtomic(path.join(SUMMARY_DIR, `${key}.json`), data);
    }
    restored.push('summaries');
  }

  if (includeRecent && snap.recent && typeof snap.recent === 'object') {
    warnings.push('消息流已按请求覆盖写入：可能与本机已有消息 id 撞车');
    for (const [chatKey, list] of Object.entries(snap.recent)) {
      const file = path.join(MESSAGES_DIR, `${String(chatKey).replace(':', '_')}.json`);
      const cur = readJsonSafe(file, null) || { chatKey, nextLocalId: 1, messages: [] };
      cur.messages = Array.isArray(cur.messages) ? cur.messages.concat(list) : list;
      writeJsonAtomic(file, cur);
    }
    restored.push('recent');
  } else if (snap.recent && Object.keys(snap.recent).length) {
    warnings.push(`消息流未恢复（${Object.keys(snap.recent).length} 个会话）：风格画像会从最近消息重新算，头几天说话方式可能和原来不完全一样`);
  }

  // config **最后**写。2026-10-26：以前它写在最前面（立即落盘），
  // 万一后面写 facts/diary 时磁盘满或 EPERM 抛了异常，就留下"人设已换、记忆没回来"的半截状态。
  // 文件先落、配置最后，能把半截状态的概率压到最低。
  const configPatch = { persona };
  if (Array.isArray(r.customPersonas) && r.customPersonas.length) configPatch.customPersonas = r.customPersonas;
  if (r.personaBindings && Object.keys(r.personaBindings).length) configPatch.personaBindings = r.personaBindings;
  if (r.personaModes && Object.keys(r.personaModes).length) configPatch.personaModes = r.personaModes;
  if (r.identityModes && Object.keys(r.identityModes).length) configPatch.identityModes = r.identityModes;
  updateConfig(configPatch);
  restored.push('persona', 'customPersonas', 'personaBindings');

  return { ok: true, dryRun: false, restored, backupDir, warnings };
}
