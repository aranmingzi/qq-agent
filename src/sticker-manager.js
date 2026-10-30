// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OneBotClient } from './onebot.js';
import { getConfig } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  stickerLocalCopy, rankStickerAlternatives, STICKER_FILES_DIR
} from './stickers.js';

// 本地副本大小上限：超过就只留 URL，避免把大图落盘 + base64 直传拖垮发送。
const MAX_LOCAL_BYTES = 4 * 1024 * 1024;

function extFromContentType(contentType, fileName = '') {
  const byName = String(fileName || '').match(/\.(png|jpe?g|gif|webp|bmp|apng)$/i);
  if (byName) return '.' + byName[1].toLowerCase().replace(/^jpeg$/, 'jpg');
  const t = String(contentType || '').toLowerCase();
  if (t.includes('gif')) return '.gif';
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('bmp')) return '.bmp';
  return '.jpg';
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 下载图片并落盘为本地副本（文件名取内容 md5，天然去重）。失败返回空串。 */
  async #cacheLocalCopy(url, fileName = '') {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return '';
    try {
      const { buffer, contentType } = await safeFetchBinary(target, MAX_LOCAL_BYTES);
      if (!buffer?.length) return '';
      fs.mkdirSync(STICKER_FILES_DIR, { recursive: true });
      const md5 = crypto.createHash('md5').update(buffer).digest('hex').toUpperCase();
      const file = path.join(STICKER_FILES_DIR, `${md5}${extFromContentType(contentType, fileName)}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
      return file;
    } catch {
      return '';
    }
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /** 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。 */
  async collect(messageId, { url, note = '', fileName = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }

    // 关键：消息里的图片 URL 是带 rkey 的临时地址，几小时后必然 404。
    // 收藏时就把图落到本地，之后发送走本地副本，才不会"存进去了却发不出去"。
    const localPath = await this.#cacheLocalCopy(url, fileName);
    const md5 = localPath ? path.basename(localPath).split('.')[0] : '';
    if (md5) {
      const dup = this.entries.find((e) => e.md5 && e.md5 === md5 && stickerLocalCopy(e));
      if (dup) {
        const text = String(note || '').trim();
        return text ? this.note(dup.id, { note: text }) : dup;
      }
    }

    const entry = {
      id,
      resId: id,
      url,
      localPath,
      md5,
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    return entry;
  }

  /** 发送前自愈：老条目（没有本地副本）就地补一份，失败返回 null。 */
  async ensureLocalCopy(id) {
    const entry = this.entries.find((e) => e.id === String(id ?? ''));
    if (!entry) return null;
    if (stickerLocalCopy(entry)) return entry;
    const localPath = await this.#cacheLocalCopy(entry.url);
    if (!localPath) return null;
    entry.localPath = localPath;
    if (!entry.md5) entry.md5 = path.basename(localPath).split('.')[0];
    entry.updatedAt = new Date().toISOString();
    saveStickerStore(this.entries);
    return entry;
  }

  /** 停用一条表情（失效死链）：数据保留，但不再出现在 list_stickers / 提示词里。 */
  disable(id, reason = '') {
    const entry = this.entries.find((e) => e.id === String(id ?? ''));
    if (!entry) return null;
    entry.disabled = true;
    entry.disabledReason = String(reason || '').slice(0, 200);
    entry.updatedAt = new Date().toISOString();
    saveStickerStore(this.entries);
    return entry;
  }

  /** 换发候选（发送兜底用）。 */
  alternatives(options = {}) {
    return rankStickerAlternatives(this.entries, options);
  }
}
