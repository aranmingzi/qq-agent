// 给人设「九、唱歌」补充「点唱」指令：区分 sing_lyrics 与 sing_convert。
import fs from 'node:fs';

const p = 'data/config.json';
let s = fs.readFileSync(p, 'utf8');

const marker = '点唱：';
if (s.includes(marker)) {
  console.log('已存在，跳过');
  process.exit(0);
}

const anchor = '- 只有明确要求唱歌/翻唱时才用，平时别主动唱。';
if (!s.includes(anchor)) {
  console.log('锚点未找到，未修改');
  process.exit(1);
}

// 注意：写入 JSON 字符串里的换行是 \\n（反斜杠+n）
const extra =
  '- 点唱：群友发「唱：歌词」或「来一首：歌词」（只给歌词、没发音频/没报歌名）时，用 sing_lyrics，把歌词传进去。\\n' +
  '- 只发歌词时，产出的是「带胡桃音色的念白/轻哼」（模型是歌声转换，不会凭空按谱唱）；你可以自然地说「歌词我记下了，先哼给你听」，别假装自己会按谱唱。\\n' +
  '- 群友发了音频（哼唱/歌曲）或报了歌名想「翻唱」，才用 sing_convert。\\n';
s = s.replace(anchor, extra + anchor);

fs.writeFileSync(p, s, 'utf8');
JSON.parse(fs.readFileSync(p, 'utf8'));
const text = JSON.parse(fs.readFileSync(p, 'utf8')).persona.roleText;
console.log('JSON 校验通过');
console.log('唱歌段:', JSON.stringify(text.slice(text.indexOf('## 九、唱歌'), text.indexOf('## 九、唱歌') + 500)));
