import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, DEFAULT_CONFIG } from '../src/config.js';
import { PERSONAS } from '../src/personas.js';

const configFile = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configFile)) {
  throw new Error(`找不到配置文件：${configFile}`);
}

const raw = fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '');
const current = JSON.parse(raw);
const backupDir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `config-before-tsundere-${stamp}.json`);
fs.copyFileSync(configFile, backupFile);

const next = structuredClone(current);
next.api = {
  ...(next.api || {}),
  model: (!next.api?.model || next.api.model === 'ds') ? 'deepseek-flash' : next.api.model,
  complexModel: String(next.api?.complexModel || 'deepseek-v4-pro'),
  maxRounds: 6,
  maxOutputTokens: Number(next.api?.maxOutputTokens) || DEFAULT_CONFIG.api.maxOutputTokens,
  complexMaxOutputTokens: Number(next.api?.complexMaxOutputTokens) || DEFAULT_CONFIG.api.complexMaxOutputTokens,
  routing: {
    ...(DEFAULT_CONFIG.api.routing || {}),
    ...(next.api?.routing || {}),
    enabled: true,
    auto: true,
    allowModelEscalation: true
  }
};
next.persona = {
  ...(next.persona || {}),
  botName: next.persona?.botName || '小鲸鱼',
  roleText: PERSONAS.xiaojingyu_tsundere_v1.text,
  customRules: String(next.persona?.customRules || ''),
  masterQQ: '10000001'
};
next.wakeDelayMs = 1800;
next.directWakeDelayMs = 500;
next.drainDelayMs = 800;
next.store = {
  ...(next.store || {}),
  pastStateLimit: 24,
  pastStateMaxChars: 2400
};
next.mood = {
  ...(DEFAULT_CONFIG.mood || {}),
  ...(next.mood || {}),
  enabled: true
};

const tmp = `${configFile}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
try {
  fs.renameSync(tmp, configFile);
} catch (error) {
  if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
  try { fs.rmSync(configFile, { force: true }); } catch { /* retry below */ }
  fs.renameSync(tmp, configFile);
}

console.log(JSON.stringify({
  ok: true,
  backupFile,
  appRoot: ROOT,
  persona: '小鲸鱼（傲娇改版）',
  complexModel: next.api.complexModel
}, null, 2));
