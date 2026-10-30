// 人设十维体检（命令行）。学自《酒馆十维》。
//
// 用法：
//   node tools/persona-audit.mjs                 # 体检当前 config.json 里的人设
//   node tools/persona-audit.mjs xiaojingyu     # 体检内置人设（PERSONAS 的 key）
//   node tools/persona-audit.mjs --json          # 输出 JSON（给面板/脚本消费）
//
// 它只读不写：不改配置、不改人设。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getConfig } from '../src/config.js';
import { auditPersona, formatAuditReport, personaByKey } from '../src/persona-audit.js';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const key = args.find((a) => !a.startsWith('--')) || '';

let target;
if (key) {
  const hit = personaByKey(key);
  if (!hit) {
    console.error(`找不到人设「${key}」。可选：${Object.keys((await import('../src/personas.js')).PERSONAS).join(' / ')}`);
    process.exit(1);
  }
  target = { name: hit.name, persona: hit.persona };
} else {
  const persona = getConfig().persona || {};
  target = { name: `${persona.botName || '当前人设'}（config.json）`, persona };
}

const audit = auditPersona(target.persona);

if (wantJson) {
  console.log(JSON.stringify({ name: target.name, ...audit }, null, 2));
} else {
  console.log(formatAuditReport(audit, { name: target.name }));
  // 顺手提示一句：人设是从哪个文件读的（排查"我改的怎么没生效"）
  const cfgFile = path.join(ROOT, 'config.json');
  if (!key && fs.existsSync(cfgFile)) {
    console.log(`\n（来源：${cfgFile} 的 persona.roleText）`);
  }
}
