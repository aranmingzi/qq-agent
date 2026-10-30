/**
 * 钩子总线 —— 插件型扩展包（plugins/）的唯一承载
 * 移植自 Estrella-Bot（QQ-Agent 生态 · MIT）。
 *
 * 钩子点与 QQ Agent orchestrator 的流程对应（6 个）：
 *   before-context        组消息之后、建上下文之前
 *   before-llm-messages   消息建好、发给模型之前（可改 messages）
 *   before-tool           工具调用前（可否决）
 *   after-tool            工具调用后
 *   before-media          出站媒体（图/文件/语音/表情）真正发出之前（可否决）
 *   after-response        本轮回复结束之后
 *
 * 为什么要有 before-media：文字发错还能撤回，图/文件/语音发出去就是发出去了。
 * 以前唯一的拦截点在工具层（send_image 校验 URL），但定时任务、唱歌交付、
 * 插件自己的 api.sendImage 都绕过工具层。收口到 sender 才能"所有出站媒体都过一个点"。
 *
 * 语义（照抄参考实现）：
 *  - 钩子出错 → fail-open（吞掉记账，绝不变成否决）。
 *  - 否决不打断后续钩子：全部跑完再取第一个否决。
 *  - 未知钩子点拒绝并告警（不静默忽略）。
 */

export const HOOK_POINTS = Object.freeze([
  'before-context',
  'before-llm-messages',
  'before-tool',
  'after-tool',
  'before-media',
  'after-response',
]);

const VETO_KEY = 'block';

export function createHookBus({ log } = {}) {
  const warn = (m) => log?.warn?.(m);
  const points = new Map();
  for (const p of HOOK_POINTS) points.set(p, []);

  return {
    /** 注册钩子。未知点 / 非函数 → false 并告警。 */
    on(point, fn, { owner = '' } = {}) {
      const key = String(point ?? '');
      if (!points.has(key)) {
        warn(`扩展包「${owner}」注册了未知钩子点「${key}」，已忽略（支持：${HOOK_POINTS.join(' / ')}）`);
        return false;
      }
      if (typeof fn !== 'function') {
        warn(`扩展包「${owner}」的钩子「${key}」不是函数，已忽略`);
        return false;
      }
      points.get(key).push({ owner: String(owner ?? ''), fn });
      return true;
    },

    /** 注销某个扩展包的全部钩子。 */
    offOwner(owner) {
      const o = String(owner ?? '');
      let n = 0;
      for (const [k, list] of points) {
        const keep = list.filter((h) => h.owner !== o);
        n += list.length - keep.length;
        points.set(k, keep);
      }
      return n;
    },

    size(point) {
      return (points.get(String(point ?? '')) || []).length;
    },

    total() {
      let n = 0;
      for (const list of points.values()) n += list.length;
      return n;
    },

    owners() {
      const s = new Set();
      for (const list of points.values()) for (const h of list) if (h.owner) s.add(h.owner);
      return [...s].sort();
    },

    /**
     * 触发钩子点。
     * @returns {Promise<{vetoed, ran, errors}>}
     */
    async emit(point, payload = {}) {
      const key = String(point ?? '');
      const list = points.get(key);
      const errors = [];
      if (!list || !list.length) return { vetoed: null, ran: 0, errors };

      let ran = 0;
      let vetoed = null;
      for (const h of list) {
        ran += 1;
        try {
          const v = await h.fn(payload);
          if (!vetoed && v && typeof v === 'object' && v[VETO_KEY] === true) {
            vetoed = {
              reason: String(v.reason ?? '').trim() || '该动作被扩展包拒绝（未给原因）',
              owner: h.owner,
            };
          }
        } catch (e) {
          const message = String(e?.message ?? e);
          errors.push({ owner: h.owner, message });
          warn(`扩展包「${h.owner}」的钩子「${key}」出错（已放行）：${message}`);
        }
      }
      return { vetoed, ran, errors };
    },
  };
}
