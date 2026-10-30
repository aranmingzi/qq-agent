// 给人设「九、唱歌」补一条：超 60 秒会自动改发音频文件。
// 直接对原始文本做替换，避免 JSON 重新序列化打乱格式。
import fs from 'node:fs';

const p = 'data/config.json';
let s = fs.readFileSync(p, 'utf8');

const marker = '整首太长，发文件了';
if (s.includes(marker)) {
  console.log('已存在，无需修改');
  process.exit(0);
}

const anchor = '- 唱完就当是自己唱的';
if (!s.includes(anchor)) {
  console.log('锚点未找到，未修改');
  process.exit(1);
}

// 注意：写入的必须是 JSON 转义后的 \\n（反斜杠 + n），不是真实换行
const extra = '- 整首超过 60 秒时会自动改发音频文件（QQ 语音发不了那么长），这时顺口说一句\\"整首太长，发文件了\\"。\\n';
s = s.replace(anchor, extra + anchor);

fs.writeFileSync(p, s, 'utf8');
const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
const text = parsed.persona.roleText;
console.log('JSON 校验通过');
console.log('唱歌段末尾:', JSON.stringify(text.slice(text.indexOf('## 九、唱歌'), text.indexOf('## 九、唱歌') + 400)));
