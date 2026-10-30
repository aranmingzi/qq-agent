// gsv-state 自测：快照读写（注入式文件路径，不碰真实 data/voice）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot, writeSnapshot, snapshotVoice } from '../src/gsv-state.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsv-state-'));
const file = path.join(tmp, 'gsv-active.json');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name); throw e; }
}

console.log('[gsv-state]');

ok('① 缺失快照 = null / voice 为空串', () => {
  assert.strictEqual(readSnapshot(file), null);
  assert.strictEqual(snapshotVoice(file), null);
});

ok('② 写入后能读回 voice/s1/s2/applied', () => {
  assert.strictEqual(writeSnapshot({ voice: 'xiaoyu', s1: 'GPT_weights_v2/小鱼_s1_e7.ckpt', s2: 'SoVITS_weights_v2/小鱼_clean.pth' }, file), true);
  const s = readSnapshot(file);
  assert.strictEqual(s.voice, 'xiaoyu');
  assert.strictEqual(s.mode, 'finetuned');
  assert.ok(s.applied);
  assert.strictEqual(snapshotVoice(file), 'xiaoyu');
});

ok('③ 损坏 JSON = null（快照是优化项，不是事实源）', () => {
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.strictEqual(readSnapshot(file), null);
});

ok('④ voice 缺失的快照 = null', () => {
  fs.writeFileSync(file, JSON.stringify({ mode: 'finetuned' }), 'utf8');
  assert.strictEqual(readSnapshot(file), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n[gsv-state] ${pass} passed`);
