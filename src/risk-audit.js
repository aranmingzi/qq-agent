// 风控自检：把"会不会被踢/被封"从经验变成一张能看的清单。
//
// 为什么要有它（2026-10-22 生态调研的 P3-2）：
//   B 站关于 QQ 机器人播放量最高的几个视频里，「小号别再被封」「掉线/冻结」占了一半。
//   这是用户真正怕的事，而我们之前只在出事之后从日志里找原因。
//
// 纪律：
//   · 只做**只读检查**，不自动改配置（自检不该替人做决定）；
//   · 每条都给出"为什么"和"怎么办"，不吓唬人；
//   · 没有数据就跳过，不编。

const LEVEL_ORDER = { ok: 0, info: 1, warn: 2, critical: 3 };

function worst(levels) {
  return levels.reduce((acc, l) => (LEVEL_ORDER[l] > LEVEL_ORDER[acc] ? l : acc), 'ok');
}

function has(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * @param {object} cfg 完整配置
 * @param {object} [stats] { todaySent, hourlySent, onlineMinutes }
 * @param {Function} [now]
 * @returns {{level:string, items:Array, summary:string}}
 */
export function auditRisk(cfg = {}, stats = {}, now = Date.now()) {
  const items = [];
  const add = (code, level, title, detail, hint) => items.push({ code, level, title, detail, hint });

  // ── 1. 协议端与账号 ────────────────────────────────────────────────
  if (cfg.snowluma && cfg.snowluma.autoLaunch === true) {
    add('autolaunch', 'info', '开机自动拉起协议端', '应用启动时会尝试注入 QQ 并启动 SnowLuma/NapCat。',
      '如果这台机器还要手动登别的号，建议关掉自动拉起，避免两个实例抢登录。');
  }
  if (cfg.snowluma && !String(cfg.snowluma.accountQQ || '').trim()) {
    add('no-account', 'info', '没填机器人 QQ 号', '每次启动都需要扫码登录；扫码频率高时容易被风控盯上。',
      '在设置里填上小号 QQ，走快速登录（NapCat 的 -q），少扫码。');
  }

  // ── 2. 发送频率 ───────────────────────────────────────────────────
  const maxMin = Number(cfg.send?.maxPerMinute) || 0;
  const maxHour = Number(cfg.send?.maxPerHour) || 0;
  if (maxMin === 0 && maxHour === 0) {
    add('no-rate-limit', 'warn', '发送完全没限速', '每分钟/每小时上限都是 0（不限）。群聊里模型偶尔会连发，容易撞上频率风控。',
      '建议至少设 maxPerHour（例如 60–120），给突发一个上限。');
  } else if (maxMin > 10) {
    add('rate-too-high', 'warn', '每分钟上限偏高', `当前每分钟最多 ${maxMin} 条，超出真人节奏。`,
      '真人一分钟很难发 10 条以上；建议降到 5 条以内。');
  } else {
    add('rate-ok', 'ok', '发送频率有上限', `每分钟 ${maxMin || '不限'} / 每小时 ${maxHour || '不限'}。`, '');
  }

  // ── 3. 主动行为 ───────────────────────────────────────────────────
  if (cfg.proactive?.enabled) {
    const p = Number(cfg.proactive.probability) || 0;
    if (p > 0.4) {
      add('proactive-hot', 'warn', '主动开话题概率偏高', `当前 ${p}，冷场时较容易被判定为"机器人在刷存在感"。`,
        '建议 0.1–0.25；并且保留夜间静默。');
    } else {
      add('proactive-ok', 'ok', '主动开话题已限制', `概率 ${p}，有间隔与冷场阈值兜底。`, '');
    }
  }

  // ── 4. 唤醒闸门 ───────────────────────────────────────────────────
  if (cfg.gate?.enabled === false) {
    add('gate-off', 'warn', '唤醒闸门关着', '每条白名单消息都会完整跑一次模型，既费钱也更容易"什么都接"。',
      '打开 gate（可以先开 dryRun 观察一周再真拦）。');
  } else if (cfg.gate?.dryRun) {
    add('gate-dryrun', 'info', '唤醒闸门在演练模式', '只记"本来会跳过哪些"，不真拦。适合观察判据是否误杀。',
      '看几天日志确认没误杀必回消息后，关掉 dryRun。');
  } else {
    add('gate-ok', 'ok', '唤醒闸门生效', '弱触发先过判据，不必每条都叫模型。', '');
  }

  // ── 5. 权限边界 ───────────────────────────────────────────────────
  if (cfg.persona && !String(cfg.persona.masterQQ || '').trim()) {
    add('no-master', 'warn', '没设主人 QQ', '任何群友都能触发【主人专属】的能力（定时任务、改配置类指令）。',
      '在设置里填 masterQQ；不确定就先填自己的号。');
  }
  if (String(cfg.server?.bindHost || '127.0.0.1') !== '127.0.0.1' && !String(cfg.server?.token || '').trim()) {
    add('open-console', 'critical', '控制台对外监听但没有令牌', '同网段任何人都能打开控制台改配置、切账号。',
      '要么改回 127.0.0.1，要么设置访问令牌（启动时也会强制退回回环，但别依赖这层兜底）。');
  }

  // ── 6. 成本保险丝 ─────────────────────────────────────────────────
  const daily = Number(cfg.budget?.dailyCostYuan) || 0;
  if (daily <= 0) {
    add('no-budget', 'info', '没开预算保险丝', '成本没有硬上限；异常循环（比如模型反复调工具）会一直烧。',
      '建议设一个能接受的日上限，超了自动暂停比事后看账单好。');
  }

  // ── 7. 当天发送量（有数据才判）───────────────────────────────────
  const todaySent = Number(stats.todaySent) || 0;
  if (todaySent > 0) {
    if (todaySent >= 300) {
      add('volume-high', 'warn', '今天发得有点多', `已发 ${todaySent} 条。新号/小号在高频发送下更容易被限制。`,
        '检查是不是有循环回复或闸门太松；必要时临时降频。');
    } else {
      add('volume-ok', 'ok', '今日发送量正常', `已发 ${todaySent} 条。`, '');
    }
  }

  const level = worst(items.map((i) => i.level));
  const label = { ok: '正常', info: '有提示', warn: '需要注意', critical: '有风险' }[level] || level;
  const counts = items.reduce((acc, i) => { acc[i.level] = (acc[i.level] || 0) + 1; return acc; }, {});
  const summary = `${label}：${items.length} 项检查` +
    (counts.warn ? `，${counts.warn} 项需要注意` : '') +
    (counts.critical ? `，${counts.critical} 项有风险` : '') +
    (counts.info ? `，${counts.info} 项提示` : '');

  return { level, items, summary, checkedAt: Number(now) || Date.now() };
}
