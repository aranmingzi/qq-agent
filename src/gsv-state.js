/**
 * GSV 服务状态快照 —— 学自「小鱼语音包」的 active.json + apply.ps1 模式。
 *
 * 它解决什么：角色本音 API（api_v2.py）是「全局单模型」，QQagent 这边用
 * loadedVoice 做进程内缓存，只在角色变化时才发 set_*_weights。但服务本身
 * 可能被外部重启、被别的工具改了 tts_infer.yaml、或换过权重 —— 一旦发生，
 * 进程内缓存就和服务实际加载的权重脱节，表现是「拿 A 的权重配 B 的参考音频，
 * 音色全错还查不出来」（gpt-sovits.js 注释里记过这类事故）。
 *
 * 方案（照抄训练工程的做法）：
 *   · 每次成功切完权重，落一份快照 {mode, s1, s2, applied} 到 data/voice/gsv-active.json；
 *   · 启动/健康检查时读快照和服务端 /docs 之外没有官方状态接口，所以用
 *     「快照时间 + 最近一次 set 成功时间」做弱一致 —— 服务重启后第一次合成前
 *     强制重切一次（ensureVoice 的 force 参数），宁可多花 1~5 秒也不赌缓存。
 *
 * 纪律：纯函数 + 零依赖注入式 IO，test 里不需要真服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const SNAPSHOT_FILE = path.join(ROOT, 'data', 'voice', 'gsv-active.json');

/**
 * 读快照。损坏/缺失一律返回 null —— 快照是优化项，不是事实源。
 */
export function readSnapshot(file = SNAPSHOT_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof j?.voice !== 'string') return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * 写快照。失败只打日志 —— 写不进去不影响合成主流程。
 * @param {{voice: string, s1: string, s2: string}} s
 */
export function writeSnapshot(s, file = SNAPSHOT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      ...s,
      mode: 'finetuned',
      applied: new Date().toLocaleString('zh-CN', { hour12: false }),
    }, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[gsv-state] 快照写不进去:', String(e?.message ?? e).slice(0, 100));
    return false;
  }
}

/**
 * 服务端当前加载的权重（从快照推断）。快照缺失 = 未知。
 * 用于服务重启检测：重启后快照还在，但服务实际是 tts_infer.yaml 里的默认权重。
 * 这里给出「快照记录」，由调用方决定要不要 force 重切。
 */
export function snapshotVoice(file = SNAPSHOT_FILE) {
  return readSnapshot(file)?.voice || null;
}
