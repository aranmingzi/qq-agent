import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe } from './json-store.js';

const DEFAULT_MOOD = {
  score: 50,
  label: '平静',
  lastInteractionAt: 0,
  lastUpdatedAt: 0,
  decayStage: 0
};

function clamp(value) {
  return Math.max(20, Math.min(90, Math.round(Number(value) || 50)));
}

export function moodLabel(score) {
  const value = clamp(score);
  if (value <= 39) return '有点低落';
  if (value <= 59) return '平静';
  if (value <= 79) return '开心';
  return '很兴奋';
}

function normalize(raw) {
  const score = clamp(raw?.score ?? DEFAULT_MOOD.score);
  return {
    score,
    label: moodLabel(score),
    lastInteractionAt: Number(raw?.lastInteractionAt) || 0,
    lastUpdatedAt: Number(raw?.lastUpdatedAt) || 0,
    decayStage: Math.max(0, Math.min(2, Number(raw?.decayStage) || 0))
  };
}

function moodTip(label) {
  switch (label) {
    case '有点低落':
      return '语气可以轻一点、慢一点，像提不起劲的少女；但不要阴阳怪气、不要拒绝正常帮忙。';
    case '开心':
      return '可以更活泼、更爱玩，愿意多接一句、多开个玩笑，但别每条都兴奋过头。';
    case '很兴奋':
      return '语气雀跃、爱起哄、爱接梗，可以小小地手舞足蹈；表达兴奋要自然，不要刷屏。';
    default:
      return '保持古灵精怪的少女语气，正常聊天、正常帮忙，不做过度夸张的表演。';
  }
}

export class MoodStore {
  constructor(file = path.join(DATA_DIR, 'moods.json')) {
    this.file = file;
    this.cache = null;
  }

  #load() {
    if (this.cache) return this.cache;
    // 坏文件隔离留档（moods.json.corrupt-<时间戳>）后当空状态，不静默清零。
    const raw = readJsonSafe(this.file, null, { tag: 'mood' });
    this.cache = raw && typeof raw === 'object' ? raw : {};
    return this.cache;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache || {}, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, this.file);
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      try { fs.rmSync(this.file, { force: true }); } catch { /* retry below */ }
      fs.renameSync(tmp, this.file);
    }
  }

  get(chatKey, now = Date.now()) {
    const all = this.#load();
    const state = normalize(all[chatKey]);
    const decay = this.#decay(state, now);
    if (decay.changed) {
      decay.state.lastUpdatedAt = now;
      all[chatKey] = decay.state;
      this.#save();
    }
    return decay.state;
  }

  list(now = Date.now()) {
    const out = {};
    for (const key of Object.keys(this.#load())) {
      out[key] = this.get(key, now);
    }
    return out;
  }

  reset(chatKey, now = Date.now()) {
    const all = this.#load();
    const state = { ...DEFAULT_MOOD, lastInteractionAt: now, lastUpdatedAt: now };
    all[chatKey] = state;
    this.#save();
    return state;
  }

  observe(chatKey, {
    direct = false,
    freshReply = false,
    attackCount = 0,
    now = Date.now()
  } = {}) {
    const all = this.#load();
    const state = this.get(chatKey, now);
    let delta = 0;

    if (direct) delta += 3;
    if (freshReply) delta += 4;
    if (attackCount >= 2) delta -= 3;
    delta = Math.max(-6, Math.min(4, delta));

    state.score = clamp(state.score + delta);
    state.label = moodLabel(state.score);
    if (direct || freshReply || attackCount > 0) {
      state.lastInteractionAt = now;
      state.decayStage = 0;
    }
    state.lastUpdatedAt = now;
    all[chatKey] = state;
    this.#save();
    return state;
  }

  formatForPrompt(chatKey, now = Date.now()) {
    const state = this.get(chatKey, now);
    return `当前情绪：${state.label}。${moodTip(state.label)}`;
  }

  #decay(state, now) {
    const next = { ...state };
    if (!next.lastInteractionAt) return { state: next, changed: false };
    const idleMs = Math.max(0, now - next.lastInteractionAt);
    let delta = 0;
    if (idleMs >= 24 * 60 * 60 * 1000 && next.decayStage < 2) {
      delta = -6;
      next.decayStage = 2;
    } else if (idleMs >= 6 * 60 * 60 * 1000 && next.decayStage < 1) {
      delta = -2;
      next.decayStage = 1;
    }
    if (!delta) return { state: next, changed: false };
    next.score = clamp(next.score + delta);
    next.label = moodLabel(next.score);
    return { state: next, changed: true };
  }
}
