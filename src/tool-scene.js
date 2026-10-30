/**
 * 工具按场景装载 —— 让 46 个工具定义不再每轮全部铺给模型。
 *
 * 起因（2026-10-25 实测）：
 *   群里普通人触发一次调用，工具定义 18,072 字符，比整个人格提示词（9,346）还大一倍；
 *   而 1000 轮真实会话里，**只有 5 个工具做了 95% 的活**
 *   （send_message 1108 / finish 462 / get_message_images 384 / send_sticker 100 / web_search 40），
 *   其余 41 个合计不到 60 次。sing_lyrics 一个就 2,830 字符 —— 比它一辈子被调用 2 次贵得多。
 *
 * 收益不是钱（system 有前缀缓存，这部分几乎免费），是**工具选择的准确率**和首字延迟：
 * 40 多个工具摆在一起，选错、选重、被相似描述带跑的概率是实打实的。
 *
 * 设计约束：
 *   1. **只对群聊生效**。私聊是主人的一对一会话，唱歌/日记/文件都在那儿用，工具一个不动
 *      （与「连发折叠」「自己发言降采样」同样的取舍）。
 *   2. 被裁掉的包必须**随时可装载**：`load_tools` 元工具 + `ctx.enablePack()` 真的把定义
 *      加回本轮的工具数组，下一轮 round 就能调 —— 不是"告诉你有个工具但调不了"的假货。
 *   3. 关键词命中只是**加速**，不是唯一入口：没命中时模型照样能主动 load_tools。
 *   4. 装载后按包**粘住**一段时间（stickyMs），避免"唱到一半工具消失"。
 *
 * 纯函数，不碰配置、不碰网络，便于单测。
 */

/**
 * 工具 → 工具包。没登记的 = 常驻（永远挂着）。
 *
 * 判断标准不是"重不重要"，而是**"没挂着会不会当场哑巴"**：
 *   · send_message / finish / get_message_images / send_sticker / web_search / memory_*
 *     是聊天主循环的器官，常驻；
 *   · 唱歌、表情库管理、网页精读、查梗 是**被点名才用**的能力，可装载；
 *   · get_sticker_image 故意常驻（204 字符）：它是"发之前先看一眼"的安全阀，
 *     裁掉它等于让模型瞎发表情。
 */
export const PACK_OF = {
  sing_lyrics: 'song',
  sing_cover: 'song',
  sing_convert: 'song',
  play_song: 'song',
  queue_status: 'song',
  cancel_song: 'song',
  // send_voice 刻意**不**归 song 包：它是"用语音说一句"的日常表达手段，
  // 不是唱歌。归进去等于"没点歌就用不了语音" —— 那会让她在群友说"发个语音"时哑巴。
  // （791 字符 vs 一次真实的表达损失，不值。）
  list_stickers: 'stickerBox',
  sticker_note: 'stickerBox',
  collect_sticker: 'stickerBox',
  web_fetch: 'webRead',
  watch_video: 'webRead',
  search_meme: 'meme',
  propose_meme: 'meme'
};

/**
 * 包定义。
 *
 * `patterns` 只在**这一批新消息**里匹配（不含提示词、不含表情包段），
 * 否则「表情包」两个字会把 stickerBox 永久点亮 —— 那个段每轮都在。
 */
export const PACKS = {
  song: {
    label: '唱歌/点歌',
    patterns: [
      /唱|点歌|来一首|来一段|放一首|放首|翻唱|歌词|旋律|歌单|听歌|这首歌|那首歌|BGM|bgm/i,
      /什么歌|歌名|好不好听/
    ],
    // 唱歌是异步任务：唱到一半把 queue_status/cancel_song 收走 = 她要停都停不了。
    stickyMs: 15 * 60 * 1000
  },
  stickerBox: {
    label: '表情库管理',
    patterns: [/表情|斗图|梗图|贴图|收藏.*(表情|图)/],
    stickyMs: 10 * 60 * 1000
  },
  webRead: {
    label: '打开网页正文/看视频',
    patterns: [
      /https?:\/\//i,
      /链接|正文|文章|视频|看看这个|看下这个|读一下|讲了啥|讲了什么/,
      /B站|bilibili|抖音|快手|YouTube|youtube|微博/
    ],
    stickyMs: 15 * 60 * 1000
  },
  meme: {
    label: '查梗/记梗',
    patterns: [
      /什么梗|这梗|啥梗|新梗|梗是|网络用语|什么意思啊这/,
      // 没说出"梗"字、但明显是「这个词我没听懂」——这种才是真需要查的。
      // 上游实测：78% 的"梗查询"其实是这种整句话，所以别只认「梗」字。
      /听不懂|没听懂|这是啥|什么来头|啥意思|什么意思|这词|新词|黑话|缩写|谐音|出处|跟不上了|落伍/
    ],
    stickyMs: 10 * 60 * 1000
  }
};

export const PACK_NAMES = Object.keys(PACKS);

/** 某个工具属于哪个包；null = 常驻。 */
export function packOfTool(name) {
  return PACK_OF[String(name ?? '')] || null;
}

/**
 * 从这批新消息里推断该装载哪些包。
 *
 * @param {object}   o
 * @param {string}   o.text   这一批新消息的纯文本（触发器 + 用户原话）。
 * @param {object}   o.prev   上一次的装载状态 { song: 时间戳, ... }（只用到命中时刻）
 * @param {number}   o.now    当前时间戳（注入以便测试）
 * @returns {{ active: Set<string>, matched: string[], kept: string[], text: string }}
 */
export function selectPacks({ text = '', prev = {}, now = Date.now() } = {}) {
  const src = String(text ?? '');
  const matched = [];
  for (const name of PACK_NAMES) {
    const def = PACKS[name];
    if ((def.patterns || []).some((re) => re.test(src))) matched.push(name);
  }
  const active = new Set(matched);
  const kept = [];
  // 粘住：上一轮装过的包，在 stickyMs 内继续保持，避免"唱着唱着工具没了"。
  for (const name of PACK_NAMES) {
    if (active.has(name)) continue;
    const at = Number(prev?.[name]) || 0;
    if (!at) continue;
    const ttl = Number(PACKS[name].stickyMs) || 0;
    if (now - at < ttl) { active.add(name); kept.push(name); }
  }
  return { active, matched, kept, text: src };
}

/** 把一次装载记进状态（命中时刻 = now），返回新状态对象。 */
export function stampPacks(prev, names, now = Date.now()) {
  const out = { ...(prev || {}) };
  for (const name of names || []) {
    if (PACKS[name]) out[name] = now;
  }
  // 清掉过期项，别让状态无限长
  for (const name of Object.keys(out)) {
    const ttl = Number(PACKS[name]?.stickyMs) || 0;
    if (!ttl || now - out[name] >= ttl) delete out[name];
  }
  return out;
}

/**
 * 哪些包**当前没装载**（要写进提示词告诉模型"缺什么就去 load_tools"）。
 * @returns {string[]} 例如 ['唱歌/点歌/语音', '表情库管理']
 */
export function omittedLabels(active) {
  const on = active instanceof Set ? active : new Set(active || []);
  return PACK_NAMES.filter((n) => !on.has(n)).map((n) => PACKS[n].label);
}

/** 一句话给提示词用；全都装着时返回空串（整段不出现）。 */
export function describeOmitted(active) {
  const labels = omittedLabels(active);
  if (!labels.length) return '';
  return `【按需工具】唱歌/点歌、表情库、网页正文、查梗这些重工具平时不挂着（省上下文）。真要用的时候先调 load_tools 装载（pack 填 song / stickerBox / webRead / meme），装载后下一轮就能调。目前没装：${labels.join('、')}。`;
}

/**
 * 把工具定义按包过滤。
 *
 * @param {Array}  defs     全部工具定义（buildToolDefs 的结果）
 * @param {object} o
 * @param {Set|Array} o.active  已装载的包
 * @param {boolean} o.enabled   false = 不裁剪（全部保留）
 * @returns {{ defs: Array, removed: string[], keep: function }}
 */
export function selectToolDefs(defs, { active = new Set(), enabled = true } = {}) {
  const list = Array.isArray(defs) ? defs : [];
  if (!enabled) return { defs: list, removed: [], keep: () => true };
  const on = active instanceof Set ? active : new Set(active || []);
  const keep = (d) => {
    const pack = packOfTool(d?.name);
    return !pack || on.has(pack);
  };
  const kept = list.filter(keep);
  const removed = list.filter((d) => !keep(d)).map((d) => d.name);
  return { defs: kept, removed, keep };
}
