// 出口闸门：**要发出去的那一句话里，有没有不该出门的东西**。
//
// 为什么单独一层（学自 Estrella-Bot `egress.js`，2026-10-22 调研的 P0-3）：
//   我们原先的掩码只管"回显给用户看"（面板里把 Key 打成 sk-****），
//   完全不管"模型把 Key 原样复述进群"。这两件事的失败后果差一个数量级：
//   面板回显错一次只是难看，群里复述一次等于把 Key 公开了 —— 而且已经发出去，收不回。
//
// 三道判据，按可靠性从高到低：
//   ① **值匹配**：启动时把"本次生效的那几个密钥值"装进来，正文里出现原值就拦。
//      这是唯一能抓住"自定义格式密钥"的办法（形态千奇百怪，值只有一份）。
//   ② **形态匹配**：sk- / Bearer / AKIA / BEGIN PRIVATE KEY / api_key= 这些已知形态。
//      抓的是"模型凭印象编出来的 Key"和"从别处粘来的 Key"。
//   ③ 值匹配 > 形态匹配：先跑①，①命中就不必再猜形态。
//
// 两条纪律：
//   · **fail-closed**：规则自己出错 → 整条不发。发出去就收不回了，
//     这一处宁可错杀（用户看得到"这条被拦下"），不可放过。
//   · **日志里绝不出现原文**：命中记录只留 rule id + 长度 + 掩码。
//     否则闸门自己变成新的泄露面（这个坑我们踩过：错误信息里带出了 Key 前 8 位）。
import { scanRules, realHits, describeHits, SEVERITY } from './gate-scan.js';

/**
 * 形态规则。**只写已见形态**，不猜"看起来像密钥的随机串"——
 * 后者会把正常的长 id、base64 图片名、哈希值全拦掉，最后只能把闸门关掉。
 */
export const EGRESS_RULES = [
  {
    id: 'openai-sk',
    kind: 'credential',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/,
    note: 'OpenAI/DeepSeek/DashScope 系密钥'
  },
  {
    id: 'bearer',
    kind: 'credential',
    pattern: /\bBearer\s+[A-Za-z0-9._\-]{16,}/i,
    note: 'Authorization: Bearer 头'
  },
  {
    id: 'kv-secret',
    kind: 'credential',
    // api_key=xxx / apiKey: "xxx" / access_token=xxx / client_secret: xxx
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]{12,}/i,
    note: '键值对形式的密钥'
  },
  {
    id: 'github-token',
    kind: 'credential',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    note: 'GitHub token'
  },
  {
    id: 'aws-key',
    kind: 'credential',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    note: 'AWS access key'
  },
  {
    id: 'private-key',
    kind: 'credential',
    pattern: /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----/,
    note: '私钥 PEM 头'
  },
  {
    id: 'cookie-session',
    kind: 'credential',
    // skey=@abc123; p_skey=... 这类 QQ/网页登录态
    pattern: /\b(?:skey|p_skey|uin|sid|sessionid)\s*=\s*[A-Za-z0-9@._\-]{10,}/i,
    note: '登录态 cookie'
  }
];

/** 运行时密钥集：**本次生效的值**，不是配置文件里的字面量（掩码已在 load 时还原）。 */
const RUNTIME_SECRETS = new Set();
/** 太短的值不能进集合：`1234`、`test` 这种会把正常句子全拦掉。 */
const MIN_SECRET_LEN = 8;

/**
 * 装入本次生效的密钥（启动时、配置热更新后各调一次）。
 * @param {Iterable<string>} values
 * @returns {number} 实际收下的条数（供启动日志说"装了几把"）
 */
export function setRuntimeSecrets(values) {
  RUNTIME_SECRETS.clear();
  const seen = new Set();
  for (const v of values || []) {
    const s = String(v ?? '').trim();
    if (s.length < MIN_SECRET_LEN) continue;
    // 掩码不是密钥：配置里可能残留 `sk-****107d` / `••••••••` / 被编码器吃成 `????` 的残骸。
    // 装进阻断集只会让"正常复述配置界面"被拦，拦不到任何真东西。
    // 判据与 config.js 的 looksMasked 同形（那边管落盘，这边管出口）。
    if (s.includes('****') || s.includes('••') || /\?{4,}/.test(s)) continue;
    seen.add(s);
  }
  for (const s of seen) RUNTIME_SECRETS.add(s);
  return RUNTIME_SECRETS.size;
}

export function clearRuntimeSecrets() { RUNTIME_SECRETS.clear(); }
export function runtimeSecretCount() { return RUNTIME_SECRETS.size; }

/**
 * 从配置对象里收集所有"会被当成密钥用"的值。
 * 集中在这里而不是散在 app.js：新增一个服务商时只改这一处，
 * 忘了改的表现是"某个 Key 拦不住"，所以宁可多收（收错只是多拦几条）。
 */
export function collectSecretsFromConfig(cfg = {}) {
  const out = [];
  const push = (v) => { const s = String(v ?? '').trim(); if (s) out.push(s); };
  push(cfg.api?.apiKey);
  for (const p of Array.isArray(cfg.providers) ? cfg.providers : []) push(p?.apiKey);
  push(cfg.vision?.qwen?.apiKey);
  push(cfg.audio?.apiKey);
  for (const k of Array.isArray(cfg.webSearch?.anysearchKeys) ? cfg.webSearch.anysearchKeys : []) push(k);
  push(cfg.snowluma?.accessToken);
  push(cfg.snowluma?.httpAccessToken);
  push(cfg.server?.token);
  return out;
}

/** 掩码：保留 3 前缀 + 后 4 位（足够人工比对，不够还原）。 */
export function maskOne(secret) {
  const s = String(secret ?? '');
  if (s.length < 12) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/**
 * 文本里出现了运行时密钥的**原值**。这是最可靠的一道，也最容易被忘。
 * 逐字符扫描而不是正则：密钥里可能有 `.`、`+`、`/`、`@`，套进正则就会静默失配。
 */
function matchRuntimeSecrets(text) {
  const hits = [];
  for (const s of RUNTIME_SECRETS) {
    let from = 0;
    let guard = 0;
    while (guard < 20) {
      guard += 1;
      const idx = text.indexOf(s, from);
      if (idx < 0) break;
      hits.push({
        id: 'runtime-secret',
        kind: 'credential',
        severity: SEVERITY.BLOCK,
        index: idx,
        length: s.length,
        note: `命中本次生效的密钥值（${maskOne(s)}）`
      });
      from = idx + s.length;
    }
  }
  return hits;
}

/**
 * 扫一段**即将发出去**的文本。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.blockOnError=true] 规则自身出错时是否拦下（出口一律 true）
 * @returns {{blocked:boolean, hits:Array, ruleIds:string[], reason:string}}
 */
export function scanEgress(text, opts = {}) {
  const body = String(text ?? '');
  if (!body.trim()) return { blocked: false, hits: [], ruleIds: [], reason: '' };

  const blockOnError = opts.blockOnError !== false;

  // ① 值匹配优先（能抓到形态表覆盖不了的自定义 Key）
  const secretHits = matchRuntimeSecrets(body);

  // ② 形态匹配（一次遍历）
  const shaped = scanRules(EGRESS_RULES, body, { blockOnError, maxHits: 10 });

  const hits = [...secretHits, ...(shaped.hits || [])].sort((a, b) => a.index - b.index);
  const ruleIds = [...new Set(realHits(shaped).map((h) => h.id).concat(secretHits.map((h) => h.id)))];
  const errored = (shaped.errors || []).length > 0;

  const blocked = hits.length > 0 || (blockOnError && errored);
  const reason = blocked
    ? (hits.length
      ? `这条里有不该发出去的内容（${describeHits(shaped) || ruleIds.join('、')}）`
      : '出口规则自身出错，按 fail-closed 拦下')
    : '';

  return { blocked, hits, ruleIds, reason, errors: shaped.errors || [], truncated: shaped.truncated };
}

/**
 * 给日志用的脱敏：把所有命中的凭据换成掩码。
 * 与 `scanEgress` 分开：这里**不判拦不拦**，只负责"别把 Key 写进日志"。
 */
export function maskSecrets(text) {
  let out = String(text ?? '');
  if (!out) return out;
  // 先值匹配（长度倒序，避免短值先把长值切碎）
  const secrets = [...RUNTIME_SECRETS].sort((a, b) => b.length - a.length);
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(maskOne(s));
  }
  // 再形态匹配
  const shaped = scanRules(EGRESS_RULES, out, { blockOnError: false, maxHits: 50 });
  if (shaped.hits.length) {
    // 从后往前替换，保证前面的 index 不失效
    const ordered = [...shaped.hits].sort((a, b) => b.index - a.index);
    for (const h of ordered) {
      if (h.kind === 'gate-error' || h.length <= 0) continue;
      const raw = out.slice(h.index, h.index + h.length);
      out = out.slice(0, h.index) + maskOne(raw) + out.slice(h.index + h.length);
    }
  }
  return out;
}
