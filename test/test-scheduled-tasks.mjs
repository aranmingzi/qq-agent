// 定时任务自检（纯逻辑；数据目录隔离到 tmp，不碰生产的 data/scheduled-tasks.json）。
// 跑：node test/test-scheduled-tasks.mjs
//
// 守护的是 2026-10-25 的"小本本记好了"事故：
//   主人在私聊里让她"监督一星期、每天问我一句"，她嘴上答应了，但**一次 schedule_task 都没调**，
//   data/scheduled-tasks.json 里一条任务都没有 —— 第二天的提醒永远不会来。
//   落地之后才谈得上"一周"：daily 没有截止就是永久骚扰，所以 addTask 支持 until，
//   工具侧把它折成 days（连续 N 次）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import config 之前设：DATA_DIR 在 config.js 加载时就定了
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-sched-'));

const ST = await import('../src/scheduled-tasks.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e?.message ?? e)); process.exitCode = 1; }
}

const DAY = 24 * 3600 * 1000;
const H2030 = (dateStr) => new Date(`${dateStr}T20:30:00`).getTime();

console.log('\n[1] 一次性任务');

ok('到点触发一次后失效（不重复）', () => {
  ST.clearTasks();
  const at = H2030('2026-10-26');
  ST.addTask({ chatKey: 'private:1', text: '提醒交作业', at, repeat: 'none' });
  assert.equal(ST.dueTasks(at).length, 1);
  assert.equal(ST.dueTasks(at).length, 0, '第二次不该再触发');
});

console.log('\n[2] 每天重复 + 截止（"监督一星期"）');

ok('daily + until（7 次）→ 正好触发 7 次后自动停用', () => {
  ST.clearTasks();
  const start = H2030('2026-10-26');
  const until = start + 6 * DAY;      // 第 7 次（10-26 起算）
  ST.addTask({ chatKey: 'private:1', text: '问他今天有没有偷吃辣', at: start, repeat: 'daily', until });
  let fired = 0;
  for (let i = 0; i < 9; i += 1) fired += ST.dueTasks(start + i * DAY).length;
  assert.equal(fired, 7, `应该正好 7 次，实际 ${fired}`);
  assert.equal(ST.tasksOf('private:1').length, 0, '到期后应该不再挂在待触发列表里');
});

ok('daily 不带 until → 一直重复（历史行为不变）', () => {
  ST.clearTasks();
  const start = H2030('2026-10-26');
  ST.addTask({ chatKey: 'private:1', text: '每天问一句', at: start, repeat: 'daily' });
  let fired = 0;
  for (let i = 0; i < 30; i += 1) fired += ST.dueTasks(start + i * DAY).length;
  assert.equal(fired, 30, '没有截止就该一直重复');
});

ok('weekly + until（4 次）→ 4 周后停', () => {
  ST.clearTasks();
  const start = H2030('2026-10-26');
  ST.addTask({ chatKey: 'private:1', text: '每周一问你', at: start, repeat: 'weekly', until: start + 3 * 7 * DAY });
  let fired = 0;
  for (let i = 0; i < 6; i += 1) fired += ST.dueTasks(start + i * 7 * DAY).length;
  assert.equal(fired, 4);
});

console.log('\n[3] 描述里要看得见"到哪天为止"');

ok('describeTask 带截止日期', () => {
  ST.clearTasks();
  const start = H2030('2026-10-26');
  const until = start + 6 * DAY;
  const t = ST.addTask({ chatKey: 'private:1', text: '问他今天有没有偷吃辣', at: start, repeat: 'daily', until });
  const d = ST.describeTask(t, start - DAY);
  assert.match(d, /每天重复/);
  assert.match(d, /重复到 2026-11-01 为止/);
});

console.log('\n[4] 落盘：重启/换进程后还在');

ok('addTask 写进 data/scheduled-tasks.json，reload 能读回来', () => {
  ST.clearTasks();
  const at = H2030('2026-10-26');
  ST.addTask({ chatKey: 'private:9', text: '喝水', at, repeat: 'none' });
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'scheduled-tasks.json'), 'utf8'));
  assert.equal(disk.tasks.length, 1);
  assert.equal(disk.tasks[0].text, '喝水');
  assert.equal(ST.listTasks().length, 1);
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}\n`);
