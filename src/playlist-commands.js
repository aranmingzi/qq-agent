// 点歌指令：群友用一句话点播歌单里的歌。
//
// 为什么走「确定性指令」而不是交给模型
// ----------------------------------
// 模型很适合闲聊，但不适合做「精确播放第 7 首」这种事：
//   * 它可能把「#点歌 7」理解成让你唱第七首歌，或者干脆不回；
//   * 每次都要多花一次模型调用（还有 token 成本）；
//   * 点播需要「立刻、稳定、可预期」——命中就发，没命中就报候选。
// 所以带前缀的指令在 app.js 里被这一层直接截获，根本不进模型。
// 自然语言（「放首青花瓷听听」）仍然由 play_song 工具兜底，两条路共用同一套检索/交付。
//
// 指令设计原则：前缀可选但推荐；裸词只放行「点歌/点播」这种没有歧义的动词。

import { getConfig } from './config.js';
import {
  playlistConfig, ensureLibrary, buildLibrary, formatLibraryPage, formatCandidates,
  resolvePlayQuery, searchTracks,
} from './playlist.js';
import { playTrack, isAudioCached } from './playback.js';

let senderRef = null;
let logFn = () => {};

export function initPlaylistCommands({ sender, log = null } = {}) {
  if (sender) senderRef = sender;
  if (log) logFn = log;
}

const HELP = [
  '🎵 点歌台用法',
  '#点歌 歌名 / #点歌 序号 —— 播这首歌',
  '#歌单 [页码] —— 看看都有什么',
  '#搜歌 关键词 —— 找歌（不直接播）',
  '#随机 —— 随便来一首',
  '#点歌帮助 —— 再看一遍',
  '（想让角色翻唱，直接说「唱XX」）',
].join('\n');

/**
 * 解析一条消息是不是点歌指令。
 * @returns {{cmd:string, arg:string, prefixed:boolean}|null}
 */
export function parsePlaylistCommand(raw) {
  let text = String(raw || '').trim();
  // 群里 @ 机器人时，segmentsToText 会写成 "@我 #点歌 xxx"
  text = text.replace(/^(\[@我\]|@我)\s*/, '').trim();
  const prefixed = /^[#!！]/.test(text);
  if (prefixed) text = text.replace(/^[#!！]\s*/, '').trim();
  if (!text) return null;

  let m;

  // 帮助必须放在「点歌」前面：否则 #点歌帮助 会被当成「点播一首叫《帮助》的歌」
  if (/^(点歌帮助|歌单帮助|点歌说明|点歌台帮助|点点歌|点歌指南)$/.test(text)) {
    return { cmd: 'help', arg: '', prefixed };
  }

  // 「点歌姬」不是指令；「点歌」「点播」既可以带前缀也可以裸用
  if ((m = /^(点歌|点播)(?!台|姬|机)\s*(.*)$/.exec(text))) {
    const arg = m[2].trim();
    if (!arg && !prefixed) return null;          // 裸「点歌」两个字可能是随口一说
    return { cmd: 'play', arg, prefixed };
  }
  // 这几个动词只在带前缀时才认，避免「放歌了」「来一首？」被误判
  if (prefixed && (m = /^(放歌|播放|来一首|来首)\s*(.+)$/.exec(text))) {
    return { cmd: 'play', arg: m[2].trim(), prefixed };
  }
  if ((m = /^(歌曲?单|点歌台|点播台)\s*(.*)$/.exec(text))) {
    const arg = m[2].trim();
    if (!arg && !prefixed) return null;
    return { cmd: 'list', arg, prefixed };
  }
  if ((m = /^(搜歌|找歌|查歌|搜索歌)\s*(.*)$/.exec(text))) {
    const arg = m[2].trim();
    if (!arg) return { cmd: 'help', arg: '', prefixed };
    return { cmd: 'search', arg, prefixed };
  }
  if (/^(随机点歌|随机一首|随机来一首|来首随机|来一首随机)$/.test(text)) {
    return { cmd: 'random', arg: '', prefixed };
  }
  if (prefixed && /^随机$/.test(text)) return { cmd: 'random', arg: '', prefixed };
  if (/^(重扫歌单|刷新歌单|重建歌单|更新歌单|扫描歌单)$/.test(text)) {
    return { cmd: 'rebuild', arg: '', prefixed };
  }
  if (/^(点歌帮助|歌单帮助|点歌说明|点歌台帮助|点点歌)$/.test(text)) {
    return { cmd: 'help', arg: '', prefixed };
  }
  return null;
}

function isMaster(senderId) {
  const master = String(getConfig()?.persona?.masterQQ || '').trim();
  return Boolean(master) && String(senderId || '').trim() === master;
}

// 同一个人在同会话里的点播冷却（防止连点十几首刷屏）
const lastPlayAt = new Map();

/**
 * 处理一条可能是指令的消息。
 * @returns {Promise<boolean>} true = 已处理（调用方不要再交给模型）
 */
export async function handlePlaylistCommand({
  chatKey, text, senderId = '', senderName = '', messageId = null,
}) {
  const cfg = playlistConfig();
  if (!cfg.enabled) return false;
  if (!senderRef) return false;

  const pc = parsePlaylistCommand(text);
  if (!pc) return false;

  const sender = senderRef;
  const reply = (msg) => sender.sendTextBatch(chatKey, [msg], { replyToMessageId: messageId ?? null });

  if (pc.cmd === 'help') {
    await reply(HELP);
    return true;
  }

  if (pc.cmd === 'rebuild') {
    if (!isMaster(senderId)) {
      await reply('重扫歌单只有主人能做～');
      return true;
    }
    await reply('正在扫描 B站缓存…');
    try {
      const lib = await buildLibrary({ log: logFn });
      await reply(`歌单已更新：${lib.stats.playable} 首可点播，${lib.stats.collections} 个合集（${Math.round(lib.buildMs / 100) / 10}s）`);
    } catch (error) {
      await reply(`重扫失败：${error?.message ?? error}`);
    }
    return true;
  }

  // 以下都要歌单
  let lib;
  try {
    lib = await ensureLibrary({ log: logFn });
  } catch (error) {
    await reply(`点歌台还没准备好：${error?.message ?? error}`);
    return true;
  }
  if (!lib) {
    await reply('点歌台还没建好，让主人先发一次 #重扫歌单。');
    return true;
  }

  if (pc.cmd === 'list') {
    const arg = pc.arg;
    const page = /^\d{1,3}$/.test(arg) ? Number(arg) : 1;
    const filter = arg && !/^\d{1,3}$/.test(arg) ? arg : '';
    await reply(formatLibraryPage(page, { lib, filter }));
    return true;
  }

  if (pc.cmd === 'search') {
    const cands = searchTracks(pc.arg, { lib, limit: 8 });
    await reply(formatCandidates(cands, { keyword: pc.arg }));
    return true;
  }

  // play / random
  const query = pc.cmd === 'random' ? '随机' : pc.arg;
  if (!query) {
    // 空指令只是「看看有什么」，不该被冷却拦住
    await reply(`${formatLibraryPage(1, { lib })}\n\n点歌： #点歌 歌名 或 #点歌 序号`);
    return true;
  }

  const cooldownKey = `${chatKey}|${senderId}`;
  const cd = cfg.cooldownSec * 1000;
  if (cd > 0) {
    const last = lastPlayAt.get(cooldownKey) || 0;
    if (Date.now() - last < cd) {
      await reply(`刚点过，${Math.ceil((cd - (Date.now() - last)) / 1000)} 秒后再点～`);
      return true;
    }
  }

  const r = resolvePlayQuery(query, { lib });
  if (!r.track) {
    if (r.reason === 'ambiguous') await reply(formatCandidates(r.candidates, { keyword: query }));
    else if (r.reason === 'notCached') {
      await reply(`这个 BV 号（${r.bvid}）还没缓存，点不了原曲。\n先在 B站客户端缓存下来，再让主人 #重扫歌单。`);
    } else if (r.reason === 'collection') {
      const t = r.candidates[0].track;
      await reply(`《${t.title}》是合集/语音包（${Math.round(t.duration / 60)} 分钟），整段发太大。\n确实要听就回 #点歌 ${t.no}`);
    } else await reply(`歌单里没找到「${query}」。\n试试 #搜歌 ${query}，或 #歌单 看看都有什么。`);
    return true;
  }

  const track = r.track;
  if (track.status !== 'ok') {
    await reply(`《${track.title}》的缓存不完整（可能还没下完），换一首吧。`);
    return true;
  }

  lastPlayAt.set(cooldownKey, Date.now());

  // 首次点播要转码（3~6 秒），先说一声；命中缓存就直接发，不啰嗦
  if (!isAudioCached(track) && track.duration > 20) {
    await reply(`🎵 收到，正在准备《${track.title}》（首次点播要转码，约几秒）`);
  }

  try {
    const out = await playTrack(sender, chatKey, track, {
      requester: senderName,
      replyToMessageId: messageId ?? null,
    });
    logFn(`[playlist] ${chatKey} 点播《${track.title}》→ ${out.mode} ${Math.round(out.totalMs / 100) / 10}s`);
    return true;
  } catch (error) {
    await reply(`《${track.title}》没发出去：${error?.message ?? error}`);
    return true;
  }
}
