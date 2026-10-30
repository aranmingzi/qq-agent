// Electron 媒体权限处理器：给语音通话的「耳朵」开口子。
//
// 为什么要单独一个模块、而不是写在 electron/main.js 里：
// electron/main.js 在测试进程里跑不起来（它 import 了 electron 本体，
// 一 import 就要 app 就绪）。而这段逻辑恰恰是最容易写错的地方 ——
// 判错一个 origin 就等于把系统混音采集权限白送给任意页面。
// 抽出来之后可以塞一个假 session 进去，把三个 handler 真的调用一遍。
//
// 背景（为什么非做不可）：
// Electron 里 getDisplayMedia 默认被拒。它不是麦克风权限，是 display-capture 权限 ——
// 光放行 media 不够，必须 setDisplayMediaRequestHandler 显式回一个 stream。
// 而且只有 Windows 支持 audio: 'loopback'（抓系统混音），
// 这正是"听见 QQ 里对方说话"的唯一不需要装驱动的办法。

/**
 * 只放行本机回环地址上的控制台。
 *
 * 用 URL 解析而不是正则/前缀匹配：`http://127.0.0.1.evil.com` 这种
 * 前缀伪装的经典坑，只有真解析出 hostname 才拦得住。
 * 也顺带兼容带路径的来源（Electron 给的 requestingUrl 可能是
 * `http://127.0.0.1:3210/console/`，正则锚定结尾会误拒）。
 */
export function isLocalOrigin(origin) {
  const text = String(origin || '').trim();
  if (!text) return false;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** 我们允许申请的权限白名单。其它一律拒（默认拒绝，不是默认放行）。 */
export const ALLOWED_PERMISSIONS = Object.freeze(['media', 'speaker-selection', 'display-capture']);

/**
 * 装三个 handler。
 *
 * @param {object} options
 * @param {object} options.session        Electron 的 session（测试里传假的）
 * @param {Function} [options.log]        日志
 * @param {Function} [options.isAllowedOrigin] 覆盖 origin 判定（测试用）
 * @returns {{ granted: string[], rejected: string[], reset: Function }}
 */
export function installCallMediaHandlers({ session, log = () => {}, isAllowedOrigin = isLocalOrigin } = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('installCallMediaHandlers 需要 Electron 的 session');
  }
  const granted = [];
  const rejected = [];

  const originOf = (details) => {
    // 两个 API 给的字段名不一样：request handler 给 requestingUrl，
    // check handler 直接把 requestingOrigin 当第三个参数传进来。
    const raw = details?.requestingUrl || details?.securityOrigin || details?.requestingOrigin || '';
    return String(raw);
  };

  if (typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (!ALLOWED_PERMISSIONS.includes(permission)) return false;
      return isAllowedOrigin(requestingOrigin);
    });
  }

  if (typeof session.setPermissionRequestHandler === 'function') {
    session.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (!ALLOWED_PERMISSIONS.includes(permission)) {
        callback(false);
        return;
      }
      const origin = originOf(details);
      const ok = isAllowedOrigin(origin);
      if (ok) granted.push(permission);
      else {
        rejected.push(permission);
        log(`[通话] 拒绝来自 ${origin || '（无来源）'} 的 ${permission}`);
      }
      callback(ok);
    });
  }

  if (typeof session.setDisplayMediaRequestHandler === 'function') {
    session.setDisplayMediaRequestHandler(
      (request, callback) => {
        const origin = originOf(request);
        if (!isAllowedOrigin(origin)) {
          rejected.push('display-capture');
          log(`[通话] 拒绝非本机来源的 display-capture：${origin || '（无来源）'}`);
          // 回空对象 = 什么都不给。不能回 undefined，Electron 会当成"还没决定"而挂住。
          callback({});
          return;
        }
        granted.push('display-capture');
        // 只给音频，且只给 loopback（系统混音）。
        // video 显式给 null：抓 QQ 窗口画面是另一件事，现在给了反而让用户以为在录屏。
        callback({ audio: 'loopback', video: null });
      },
      { useSystemPicker: false }
    );
  }

  return {
    granted,
    rejected,
    reset() {
      granted.length = 0;
      rejected.length = 0;
    }
  };
}
