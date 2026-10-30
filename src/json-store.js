// 读 JSON 数据的唯一入口 —— 把"文件不存在"和"文件坏了"分开。
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────────
// 以前的写法几乎都是这样：
//
//     function readJson(file, fallback) {
//       try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
//     }
//
// 一个 catch 同时兜住了两件性质完全不同的事：
//   · ENOENT      —— 第一次运行，文件还没生成。**理应**当空状态。
//   · JSON 解析失败 —— 文件内容坏了（断电、写盘中断、手改坏、磁盘满写了一半）。
//                       这时当空状态，就是**静默清零**：下一次写盘把仅剩的证据也覆盖掉。
//
// 后果不是"多一条空数据"，是"人工可救的数据变成不可救"。所以这里学 HarborQQ 补丁
// 的核心思路，但**不照抄它的处理方式**：它是 `throw '数据文件损坏，拒绝覆盖'`。
// 对我们不对 —— 我们是常驻后台，拒绝写 = 功能静默死掉，用户只看到"梗库突然不工作了"，
// 反而更难查。适配成我们的场景是「**隔离后继续**」：
//
//     解析失败 → 把坏文件改名成 xxx.corrupt-<时间戳> 留档
//              → console.warn 一条（带文件路径和原因）
//              → 按空状态继续跑
//
// 三件事同时成立：不毁证据（坏文件还在，能手工捞）、不停摆（功能照常）、可追溯（日志有痕迹）。

import fs from 'node:fs';
import path from 'node:path';

/** 隔离文件的后缀前缀。`data/memes.json.corrupt-20261021-235900` */
export const CORRUPT_TAG = '.corrupt-';

/** 本地时间戳 `YYYYMMDD-HHMMSS`（人名可读；不用 Date.now() 是因为日志里对不上表）。 */
export function stampOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 撞名时的备选名（同一秒坏的两次，或上一轮已经隔离过同名文件）。 */
function pickFree(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i <= 99; i += 1) {
    const alt = `${base}-${i}`;
    if (!fs.existsSync(alt)) return alt;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 把坏文件改名留档（同目录，不搬走 —— 同目录才能保证同盘 rename 是原子的）。
 * @returns {{ok:boolean, path:string, error?:string}}
 */
export function quarantineCorrupt(file, { now = Date.now() } = {}) {
  const target = pickFree(`${file}${CORRUPT_TAG}${stampOf(now)}`);
  try {
    fs.renameSync(file, target);
    return { ok: true, path: target };
  } catch (error) {
    // rename 失败（文件被别的进程锁住 / 权限不对）→ 退化成复制留档。
    // 复制成功也算留住证据，但原文件还在原地，下次写盘仍可能覆盖 —— 所以额外告警。
    try {
      fs.copyFileSync(file, target);
      return { ok: true, path: target, error: `改名失败，已复制留档（原文件仍在原地）：${error?.message ?? error}` };
    } catch (copyError) {
      return { ok: false, path: '', error: `留档失败：${copyError?.message ?? copyError}` };
    }
  }
}

/**
 * 读 JSON，带"损坏隔离"语义。
 *
 * @param {string} file 绝对路径
 * @param {*} fallback 读不到时返回什么
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.warn] 告警出口（默认 console.warn）
 * @param {string} [opts.tag] 日志前缀（如 'memes'）
 * @param {number} [opts.now] 注入时间（测试用，保证文件名可断言）
 * @param {boolean} [opts.stripBom=true] 是否去 UTF-8 BOM（Windows 记事本会写）
 * @returns {{data:*, status:'ok'|'missing'|'corrupt'|'unreadable', quarantined:string, error:string}}
 */
export function readJsonDetailed(file, fallback = null, { warn, tag = '', now, stripBom = true } = {}) {
  const say = typeof warn === 'function' ? warn : (m) => console.warn(m);
  const label = tag ? `[${tag}] ` : '';

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { data: fallback, status: 'missing', quarantined: '', error: '' };
    }
    // 读不了（EACCES / EISDIR / EBUSY）：隔离也做不了，只能告警 + 退回空状态。
    // 这种情况比"内容坏了"更少见，且通常伴随系统级问题，不应该吞成静默。
    say(`${label}数据文件读不了（${error?.code || '未知错误'}）：${file} —— 本次按空状态继续`);
    return { data: fallback, status: 'unreadable', quarantined: '', error: String(error?.message ?? error) };
  }

  if (stripBom && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  try {
    return { data: JSON.parse(text), status: 'ok', quarantined: '', error: '' };
  } catch (error) {
    const q = quarantineCorrupt(file, { now });
    const note = q.ok ? `已留档为 ${path.basename(q.path)}` : `留档失败（${q.error}）`;
    say(`${label}数据文件损坏：${path.basename(file)}（${error?.message ?? error}）—— ${note}，本次按空状态继续`);
    if (q.ok && q.error) say(`${label}${q.error}`);
    return {
      data: fallback,
      status: 'corrupt',
      quarantined: q.path,
      error: String(error?.message ?? error),
    };
  }
}

/** 只要数据的版本（绝大多数调用点用这个）。诊断信息走 readJsonDetailed。 */
export function readJsonSafe(file, fallback = null, opts = {}) {
  return readJsonDetailed(file, fallback, opts).data;
}

/**
 * 原子写：先写 .tmp 再 rename。
 * 目的不是"更快"，是"进程被杀时不会留下半个 JSON" —— 而半个 JSON 正是上面
 * 需要隔离的那种坏文件。所有走 readJsonSafe 的数据都应该用它写。
 */
export function writeJsonAtomic(file, data, { pretty = 2 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, pretty);
  fs.writeFileSync(tmp, `${body}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // Windows 上目标文件被占用（杀软扫描 / 另一个句柄）时 rename 会 EPERM。
    // 删掉目标再 rename 一次 —— 这时上面的留档已经发生过了，不会丢证据。
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
    try { fs.rmSync(file, { force: true }); } catch { /* 再试一次 */ }
    fs.renameSync(tmp, file);
  }
}
