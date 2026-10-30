// 跳过阶段的中文标签：**这是唯一实现**。
//
// 为什么需要它：
//   `skip-log.js` 的 `SKIP_STAGES` 是稳定枚举（20 项），但它是给程序看的短横线串
//   （`send-quota` / `proactive-backoff` / `model-silent`…）。面板、日志、接口
//   如果直接把它甩给用户，读的人只会看到一堆英文 —— 而这张表存在的全部意义
//   就是回答"它刚才为什么没理我"。枚举本身已经够抽象了，展示层不能再抽象一次。
//
// 六轮变更说明里有四轮把"面板看不到 stage 的中文含义"写进了残留问题，
// 所以这一轮把它补成唯一实现，而不是每个消费方各写一份 map（那必然漂移）。
//
// 三个字段的分工：
//   · `label` —— 短，进表格/标签用（2-6 个字）。
//   · `hint`  —— 一句话说清"这意味着什么"，给人判断要不要管。
//   · `action` —— 可选，说"该怎么办"。为空表示"不用管，正常现象"。
//
// 纪律：**加一个 stage 就必须同时加一条标签**，否则 `test/test-skip-labels.mjs`
// 会红。这是故意的 —— 枚举注释里那句"加一项要同时想清楚面板上怎么显示"
// 靠人记是记不住的。
import { SKIP_STAGES } from './skip-log.js';

/**
 * @typedef {object} SkipLabel
 * @property {string} label  短标签（表格/徽章用）
 * @property {string} hint   一句话解释
 * @property {string} [action] 该怎么办；空串 = 正常现象不用管
 * @property {boolean} [spent] 这一轮有没有花模型钱（面板排序/统计用）
 */

/** 阶段 → 中文标签。key 必须是 `SKIP_STAGES` 的**值**（不是枚举名）。 */
export const SKIP_LABELS = Object.freeze({
  [SKIP_STAGES.PAUSED]: {
    label: '全局暂停',
    hint: '你手动暂停了，所有会话都不处理。',
    action: '要恢复就在面板点「继续」。',
    spent: false
  },
  [SKIP_STAGES.ABORTED]: {
    label: '被中止',
    hint: '这一轮跑到一半被手动中止了。',
    action: '',
    spent: true
  },
  [SKIP_STAGES.NO_MODEL]: {
    label: '没配模型',
    hint: '没有可用的模型端点，根本没开跑。',
    action: '去设置里填一个 API Key 和模型名。',
    spent: false
  },
  [SKIP_STAGES.OVER_BUDGET]: {
    label: '预算熔断',
    hint: '当日花费到了你设的上限，自动停手。',
    action: '确认账没问题就调高上限，或等第二天重置。',
    spent: false
  },
  [SKIP_STAGES.NO_UNREAD]: {
    label: '没有新消息',
    hint: '被唤醒时已经没有未读了（多半是别的轮次先接走了）。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.RUNNING]: {
    label: '已有轮次在跑',
    hint: '同一个会话正有一轮在跑，这次交给它收尾。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.CONCURRENCY]: {
    label: '并发已满',
    hint: '同时在跑的会话到了上限，这一条排队等下次。',
    action: '群很多、经常撞这里，就把「最大并发」调高。',
    spent: false
  },
  [SKIP_STAGES.GATE]: {
    label: '判据判为不接',
    hint: '唤醒闸门判断这条不值得叫模型（闲聊/别人对别人说话）。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.GATE_ERROR]: {
    label: '判据自身出错',
    hint: '闸门判断时出错了，按"接"放行了 —— 所以这一轮照常跑了。',
    action: '偶发不用管；频繁出现要看日志。',
    spent: true
  },
  [SKIP_STAGES.CHEAP_GATE]: {
    label: '预判不接',
    hint: '便宜的预判模型认为不需要回，省下了一次主模型调用。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.IDENTITY]: {
    label: '身份口令接管',
    hint: '这条是切换人设的口令，被确定性逻辑吃掉了，没走模型。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.DIRECTIVE]: {
    label: '点歌指令接管',
    hint: '这条是点歌/播放这类确定性指令，被专门逻辑处理了。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.EGRESS]: {
    label: '出口闸门拦下',
    hint: '要发的内容里查出了不该发的（密钥/隐私/内部旁白），拦住了。',
    action: '看一下被拦的原文；如果是误拦要调规则。',
    spent: true
  },
  [SKIP_STAGES.SEND_FAIL]: {
    label: '发送失败',
    hint: '内容生成好了，但发到 QQ 失败（协议端/网络）。',
    action: '看「协议端」状态；重连后一般会自愈。',
    spent: true
  },
  [SKIP_STAGES.MODEL_SILENT]: {
    label: '模型选择不说',
    hint: '跑完了，但模型判断这轮没必要开口 —— 这是正常结果，不是故障。',
    action: '',
    spent: true
  },
  [SKIP_STAGES.BUDGET_RETRY]: {
    label: '截断后放弃',
    hint: '输出被长度截断，重试一次仍然截断，于是放弃。',
    action: '频繁出现说明回复太长，考虑调低分条上限。',
    spent: true
  },
  [SKIP_STAGES.RUN_ERROR]: {
    label: '整轮出错',
    hint: '模型/网络/内部异常，这一轮整个失败了。',
    action: '看「出错」详情；连续失败要查端点。',
    spent: true
  },
  [SKIP_STAGES.SEND_GATE]: {
    label: '发送前复核否决',
    hint: '生成期间白名单/暂停/预算变了，发之前又拦了一道。',
    action: '',
    spent: true
  },
  [SKIP_STAGES.PROACTIVE_BACKOFF]: {
    label: '主动被退避',
    hint: '主动开口连续没人接，按退避规则这次先不说话。',
    action: '',
    spent: false
  },
  [SKIP_STAGES.SEND_QUOTA]: {
    label: '额度已满',
    hint: '这一分钟/小时的发言额度用完了，开跑前就放弃，**没花模型钱**。',
    action: '经常撞说明额度设太低，或模型话太密。',
    spent: false
  }
});

/** 兜底：未知 stage（老日志、插件自定义）也要能显示成人话。 */
const FALLBACK = Object.freeze({ label: '', hint: '', action: '', spent: false });

/**
 * 取一个 stage 的展示信息。
 *
 * @param {string} stage
 * @returns {SkipLabel} 未知 stage 返回 `{ label: stage, hint: '未知阶段（可能是旧版本或插件写的）', ... }`
 */
export function describeStage(stage) {
  const key = String(stage || '').trim();
  const hit = SKIP_LABELS[key];
  if (hit) return { ...hit };
  // 未知也要有 label，否则面板上就是一片空白格 —— 空白比"未知"更让人困惑。
  return { ...FALLBACK, label: key || '未知', hint: key ? '未知阶段（可能是旧版本或插件写的）' : '记录里没有阶段字段' };
}

/**
 * 短标签，拿不到就退回原始值。
 * 日志行、徽章这类"一行里塞不下解释"的地方用它。
 */
export function stageLabel(stage) {
  return describeStage(stage).label;
}

/**
 * 面板用的整张表：枚举顺序 + 中文标签，附带每个 stage 的说明。
 *
 * 为什么返回数组而不是对象：面板要按固定顺序渲染，而对象的 key 顺序
 * 在跨端（Node / 浏览器 / JSON 往返）时不该被依赖。
 *
 * @returns {Array<{stage: string, label: string, hint: string, action: string, spent: boolean}>}
 */
export function stageTable() {
  return Object.values(SKIP_STAGES).map((stage) => ({ stage, ...describeStage(stage) }));
}

/**
 * 把 `skipStats()` 的裸计数翻译成可直接渲染的行，按次数降序。
 *
 * 单独抽出来是因为"统计 + 翻译 + 排序"这三件事每个消费方都会各写一遍，
 * 而排序规则（次数降序，同次数按枚举顺序）是最容易写得不一样的那一步。
 *
 * @param {Record<string, number>} stats `skipStats()` 的返回值
 * @returns {Array<{stage: string, count: number, label: string, hint: string, action: string, spent: boolean}>}
 */
export function explainStats(stats = {}) {
  const order = new Map(Object.values(SKIP_STAGES).map((s, i) => [s, i]));
  const rows = Object.entries(stats || {})
    .filter(([, n]) => Number(n) > 0)
    .map(([stage, n]) => ({ stage, count: Number(n) || 0, ...describeStage(stage) }));
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // 同次数时按枚举顺序，保证两次调用顺序一致（面板不会自己跳来跳去）
    return (order.get(a.stage) ?? 999) - (order.get(b.stage) ?? 999);
  });
  return rows;
}

/**
 * 一句话总结：这一段时间里，多少次"没说话"里有多少是**没花钱**的。
 *
 * 这个数字比总次数有用得多 —— 用户真正想知道的是"它在空转烧我的钱吗"。
 *
 * @param {Record<string, number>} stats
 * @returns {string} 例如 `共 42 次没开口，其中 31 次没花模型钱`
 */
export function summarizeStats(stats = {}) {
  let total = 0;
  let free = 0;
  for (const [stage, n] of Object.entries(stats || {})) {
    const count = Number(n) || 0;
    if (count <= 0) continue;
    total += count;
    if (!describeStage(stage).spent) free += count;
  }
  if (!total) return '这段时间没有记录到"没开口"的情况';
  if (!free) return `共 ${total} 次没开口，都花过模型钱（值得看一眼）`;
  return `共 ${total} 次没开口，其中 ${free} 次没花模型钱`;
}
