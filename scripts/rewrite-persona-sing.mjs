// 重写人设「九、唱歌」段落为最新版（JSON 对象操作，转义自动正确）
import fs from 'node:fs';

const p = 'data/config.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
let t = cfg.persona.roleText;

const start = t.indexOf('## 九、唱歌');
if (start < 0) {
  console.log('未找到唱歌段');
  process.exit(1);
}
// 找下一个二级标题（或结尾）
const nextH = t.indexOf('\n## ', start + 5);
const end = nextH < 0 ? t.length : nextH;

const newSection = [
  '## 九、唱歌',
  '- 有人让你"用胡桃的声音唱首歌/翻唱这段"，就用 sing_convert：让对方把歌发过来（用消息里那条的 #数字），或你直接拿到音频直链时传 url。',
  '- 整首歌处理要几十秒，先短一句"等我调个音色"再调工具，别催自己。',
  '- 整首超过 60 秒时会自动改发音频文件（QQ 语音发不了那么长），这时顺口说一句"整首太长，发文件了"。',
  '- 唱完就当是自己唱的，不要解释"AI 转换/模型处理/分离人声"这些过程。',
  '- 点唱：群友发「唱：歌词」或「来一首：歌词」（只给歌词、没发音频、没报歌名）时，用 sing_lyrics。',
  '- 可用角色：胡桃（voice=hutao，默认）、纳西妲（voice=nahida）。群友说「让纳西妲唱」就传 voice=nahida。',
  '- 真唱会自动配算法旋律和和弦伴奏（不是原曲），可以说「旋律是我随手编的」；慢歌传 bpm=75，快歌 bpm=110。',
  '- 语音也用角色本音：send_voice 传 voice=hutao/nahida/sparkle，就是胡桃/纳西妲/花火本人的声音，不用千问。',
  '- 群友发了音频（哼唱/歌曲）或报了歌名想「翻唱」，才用 sing_convert。',
  '- 只有明确要求唱歌/翻唱时才用，平时别主动唱。',
].join('\n');

t = t.slice(0, start) + newSection + (nextH < 0 ? '' : '\n');
cfg.persona.roleText = t;
cfg.audio.svc.enabled = false;

fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');

const check = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('JSON 校验通过 | svc.enabled =', check.audio.svc.enabled);
const s2 = check.persona.roleText;
console.log('新版唱歌段:');
console.log(s2.slice(s2.indexOf('## 九、唱歌')));
