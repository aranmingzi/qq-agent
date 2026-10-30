// 更新人设：加入多角色点唱（胡桃/纳西妲）+ 说明自动伴奏
import fs from 'node:fs';

const p = 'data/config.json';
let s = fs.readFileSync(p, 'utf8');

const marker = '可用角色：';
if (s.includes(marker)) {
  console.log('已存在，跳过');
  process.exit(0);
}

const anchor = '- 群友发了音频（哼唱/歌曲）或报了歌名想「翻唱」，才用 sing_convert。';
if (!s.includes(anchor)) {
  console.log('锚点未找到');
  process.exit(1);
}

const extra =
  '- 可用角色：胡桃（voice=hutao，默认）、纳西妲（voice=nahida）。群友说「让纳西妲唱」就传 voice=nahida。\\n' +
  '- 点唱会自动配旋律和和弦伴奏（算法生成，不是原曲），所以可以说「旋律是我编的」；慢歌传 bpm=75，快歌 bpm=110。\\n';

s = s.replace(anchor, extra + anchor);
fs.writeFileSync(p, s, 'utf8');
const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
const t = parsed.persona.roleText;
const i = t.indexOf('## 九、唱歌');
console.log('JSON OK');
console.log(t.slice(i, i + 700));
