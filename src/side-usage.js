// 旁路模型调用的 usage 记账器。
//
// 为什么要有这个模块：唤醒预判、必回重试、日记生成、长期事实提取、记忆整理
// 这些调用不产生会话文件，以前它们的 usage 直接被丢弃 ——「今日 token」系统性偏小，
// 改造前后的对比也会失真（主流程省了、旁路涨了根本看不出来）。
//
// 接线方式：app.js 启动时 setSideUsageRecorder(sessions.recordSideUsage)，
// 其余模块只管 recordSideUsage(...)，不耦合 SessionRegistry 实例。
// recorder 没接上（测试 / 独立脚本）时静默丢弃，绝不炸主流程。
let recorder = null;

export function setSideUsageRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

export function recordSideUsage(purpose, usage, opts = {}) {
  try {
    if (recorder && usage && typeof usage === 'object') recorder(purpose, usage, opts);
  } catch { /* 记账失败不算事故 */ }
}
