// 人设补充：高音质唱歌选项
import fs from 'node:fs';

const p = 'data/config.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
let t = cfg.persona.roleText;

if (t.includes('hq=true')) {
  console.log('已有说明，跳过');
  process.exit(0);
}

const anchor = '- 只有明确要求唱歌/翻唱时才用，平时别主动唱。';
if (!t.includes(anchor)) {
  console.log('锚点未找到');
  process.exit(1);
}

const extra = [
  '- 音质：默认发语音条（会被压成 16kHz，听起来发闷）。群友说「高音质/发文件/音质好点」时，sing_lyrics 传 hq=true 发 44.1kHz 音频文件。',
  '- 如果群友抱怨音质，就主动说「发个高音质的给你」然后传 hq=true。',
].join('\n');

t = t.replace(anchor, extra + '\n' + anchor);
cfg.persona.roleText = t;
fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('人设已补高音质说明');
