//
// data/tmp 清理（2026-10-26）
//
// 为什么需要：临时文件在**异常路径**上必然残留 —— 进程被杀、ffmpeg 刚写完杀软正在扫
// （Windows 上 rmSync 直接 EBUSY/EPERM）。实测 data/tmp 里躺着 9 月 30 日以来的帧文件，
// data/messages 里躺着两个 `*.json.<pid>.tmp`。清理失败是常态而不是例外，
// 所以不能只靠"用完就删"，必须有一个"下次启动时补刀"的出口。
//
// 只删**文件**、只删**超过 maxAgeMs 没动过**的，且只扫 data/tmp 与 messages 下的
// 原子写残留。绝不递归进 data/voice、data/sticker-files 这类素材库。
//
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

function sweepDir(dir, maxAgeMs, { pattern = null } = {}) {
  const out = { removed: 0, freed: 0, failed: 0 };
  if (!fs.existsSync(dir)) return out;
  const now = Date.now();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (pattern && !pattern.test(name)) continue;
    const f = path.join(dir, name);
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) continue;
      if (now - Math.max(st.mtimeMs, st.ctimeMs) < maxAgeMs) continue;
      fs.rmSync(f, { force: true });
      out.removed += 1;
      out.freed += st.size;
    } catch {
      out.failed += 1;   // 被占用就留给下一轮，别为了删干净把启动卡住
    }
  }
  return out;
}

/**
 * 启动时扫一次。返回统计，便于 /api/status 里看一眼。
 * @param {{ maxAgeMs?: number }} [opts]
 */
export function sweepStaleTmp({ maxAgeMs = DAY } = {}) {
  const age = Math.max(0, Number(maxAgeMs) || DAY);
  const tmp = sweepDir(path.join(DATA_DIR, 'tmp'), age);
  // 原子写的残留：`<name>.<pid>.tmp`。写成功的已经 rename 走了，留下的都是半截。
  const msgs = sweepDir(path.join(DATA_DIR, 'messages'), age, { pattern: /\.tmp$/ });
  return {
    removed: tmp.removed + msgs.removed,
    freed: tmp.freed + msgs.freed,
    failed: tmp.failed + msgs.failed
  };
}
