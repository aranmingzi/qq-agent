// 自定义人设条目的 id 管理。
//
// ⚠️ 历史坑：id 曾经直接用数组下标 `custom_${i}`。删掉中间一条后，后面所有条目
//    的 id 全部平移，前端拿着 `custom_1` 去删除/修改，实际操作的是**另一条**人设，
//    而且没有任何报错 —— 表现就是"删了 A，B 没了"或"改 A 改到了 B 上"。
//
// 现在的规则：
//   · 新条目写入 `custom_<随机 uid>` 并持久化；
//   · 老数据（`custom_0` 这种纯数字下标、或没有 id）在任意一次写操作时，
//     按「名字+正文」的指纹换成 `custom_<hash8>`（确定性，重启/重算都不会变，
//     删掉别的条目也不影响它）；
//   · 纯数字下标**不算**稳定 id —— 它天生会随删除漂移，必须被迁移掉。
import crypto from 'node:crypto';

// custom_ 后面不能“全是数字”：那正是旧的下标格式
const STABLE_ID = /^custom_(?!\d+$)[A-Za-z0-9]+$/;

/** 内容指纹：同一份人设在任何位置都得到同一个 id，与数组顺序无关 */
function fingerprint(persona) {
  return crypto
    .createHash('sha1')
    .update(`${String(persona?.name ?? '')}\u0000${String(persona?.text ?? '')}`)
    .digest('hex')
    .slice(0, 8);
}

export function customPersonaId(persona, index) {
  const id = String(persona?.id || '');
  if (STABLE_ID.test(id)) return id;
  // 还没迁移的老数据：先按下标给个临时 id（只在内存里用于匹配，落盘时会被换成指纹 id）
  return `custom_${index}`;
}

/** 按 id 找下标（找不到返回 -1） */
export function findCustomPersonaIndex(list, id) {
  if (!Array.isArray(list)) return -1;
  const key = String(id || '');
  if (!key) return -1;
  const exact = list.findIndex((p, i) => customPersonaId(p, i) === key);
  if (exact >= 0) return exact;
  // 旧前端可能还缓存着 `custom_2` 这种下标 id → 按下标兜底一次，别直接 404
  const legacy = /^custom_(\d+)$/.exec(key);
  if (legacy) {
    const i = Number(legacy[1]);
    if (i >= 0 && i < list.length) return i;
  }
  return -1;
}

/** 落盘前补全 id，保证下次读取时 id 不再随下标漂移 */
export function withStableIds(list) {
  const used = new Set();
  const out = [];
  for (const [i, persona] of (Array.isArray(list) ? list : []).entries()) {
    const current = String(persona?.id || '');
    if (STABLE_ID.test(current) && !used.has(current)) {
      used.add(current);
      out.push(persona);
      continue;
    }
    const base = `custom_${fingerprint(persona)}`;
    let next = base;
    let n = 1;
    // 两份完全相同的人设（改名同文）会撞指纹 → 加序号，保证唯一
    while (used.has(next)) next = `${base}${n++}`;
    used.add(next);
    out.push({ ...persona, id: next });
  }
  return out;
}
