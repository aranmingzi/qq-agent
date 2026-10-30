// 安全修改配置：关闭 so-vits-svc（省显存）+ 人设补角色语音说明
// 用脚本文件避免 shell 转义把 \n 变成真实换行
import fs from 'node:fs';

const p = 'data/config.json';

// ① 关闭 svc（唱歌已改 DiffSinger；svc 只用于 TTS→SVC 降级，先关掉腾显存）
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
cfg.audio.svc.enabled = false;
fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
console.log('svc.enabled -> false');

// ② 人设补角色语音说明（对原始文本替换，不重新序列化）
let s = fs.readFileSync(p, 'utf8');
const marker = 'send_voice 传 voice';
if (!s.includes(marker)) {
  const anchor = '- 可用角色：胡桃（voice=hutao，默认）、纳西妲（voice=nahida）。';
  if (!s.includes(anchor)) {
    console.log('人设锚点未找到');
    process.exit(1);
  }
  // 注意：这里必须是 JSON 转义的 \\n（反斜杠+n）
  const line = '- 语音也用角色本音：send_voice 传 voice=hutao/nahida/sparkle，就是胡桃/纳西妲/花火本人的声音，不用千问。\\n';
  s = s.replace(anchor, line + anchor);
  fs.writeFileSync(p, s, 'utf8');
  console.log('人设已补语音说明');
} else {
  console.log('人设已有语音说明，跳过');
}

const check = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('JSON 校验通过 | svc.enabled =', check.audio.svc.enabled);
const t = check.persona.roleText;
console.log('唱歌段含语音说明:', t.includes('send_voice 传 voice'));
