// 平台薄接口：把"发一条消息"从 OneBot 动作名里解耦出来。
//
// 为什么要有它（2026-10-22 生态调研的 P2-5）：
//   现在 sender.js 直接调 onebot.sendText / sendSticker / sendRecord …
//   换协议端（LLOneBot 的 Satori/Milky）或将来接别的平台，就得改一片调用点。
//
// 做法：**只加一层转发，不写第二个实现**。
//   · 能力表按方法是否存在算出来（协议端缺某动作 → 上层能提前降级，而不是运行时报错）；
//   · 这一层故意不做重试/限频/加密，那些留在 SendQueue（唯一的发送纪律所在）。

export class UnsupportedPlatformAction extends Error {
  constructor(action, platform = '') {
    super(`当前协议端${platform ? `（${platform}）` : ''}不支持「${action}」`);
    this.name = 'UnsupportedPlatformAction';
    this.action = action;
    this.code = 'EPLATFORM_UNSUPPORTED';
  }
}

const METHODS = [
  'sendText', 'sendImage', 'sendSticker', 'sendRecord', 'sendFile', 'sendPoke',
  'recallMessage', 'sendGroupSign', 'sendLike', 'call',
];

/**
 * @param {object} adapter OneBotClient 之类
 * @param {object} [opts] { name }
 */
export function createPlatform(adapter, { name = 'onebot11' } = {}) {
  if (!adapter || typeof adapter !== 'object') throw new Error('createPlatform 需要一个协议端实例');
  const platform = { name, raw: adapter, __kind: 'platform' };

  for (const m of METHODS) {
    platform[m] = (...args) => {
      const fn = adapter[m];
      if (typeof fn !== 'function') throw new UnsupportedPlatformAction(m, name);
      return fn.apply(adapter, args);
    };
  }

  /** 能力表：true / false（缺方法就是 false，不假装有）。 */
  platform.capabilities = () => {
    const out = {};
    for (const m of METHODS) out[m] = typeof adapter[m] === 'function';
    return out;
  };

  platform.supports = (m) => typeof adapter?.[m] === 'function';

  return platform;
}

/** 已经是平台对象就原样返回（幂等，避免被包两层）。 */
export function asPlatform(x, opts) {
  if (x && x.__kind === 'platform') return x;
  return createPlatform(x, opts);
}
