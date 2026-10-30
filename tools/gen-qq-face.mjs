/**
 * 生成 QQ 内置表情映射表（id → 名称 + 表情图片码）。
 *
 * 数据来源：NapCat WebUI 自带的 qface 表
 *   snowluma/static/assets/qface-*.js  里的 JSON.parse('[{"QSid":..,"QDes":"/微笑","EMCode":"100"}...]')
 * 其中 QSid 就是 OneBot 消息段 { type:"face", data:{ id } } 里的 id，
 * QDes 是 QQ 里的名字（带前导斜杠），EMCode 是 QQ 表情图 e{EMCode}.gif 的图号。
 *
 * 用法：node tools/gen-qq-face.mjs
 * 产物：src/data/qq-face.json   形如 { "14": { "n": "微笑", "e": "100" }, ... }
 *
 * 为什么要生成而不是手写：200+ 条，手抄必错，且 NapCat 升级后重新跑一次即可对齐。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assetsDir = path.join(root, 'snowluma', 'static', 'assets');
const outFile = path.join(root, 'src', 'data', 'qq-face.json');

const asset = fs
  .readdirSync(assetsDir)
  .find((name) => /^qface-.*\.js$/.test(name));
if (!asset) {
  console.error('没找到 snowluma/static/assets/qface-*.js，无法生成表情表');
  process.exit(1);
}

const source = fs.readFileSync(path.join(assetsDir, asset), 'utf8');
const match = source.match(/JSON\.parse\('(\[.*?\])'\)/s);
if (!match) {
  console.error(`${asset} 里没有找到 JSON.parse('[...]') 表情表`);
  process.exit(1);
}

// 资产里是单引号包着的 JSON（内部用双引号，不需要转义），直接解析；
// 少量打包版本会转义成 \" / \uXXXX，那就按 JSON 字符串再解一层。
let rows;
try {
  rows = JSON.parse(match[1]);
} catch {
  rows = JSON.parse(JSON.parse(`"${match[1]}"`));
}

const table = {};
for (const row of rows) {
  const id = String(row.QSid ?? '').trim();
  if (!/^\d+$/.test(id)) continue;
  const name = String(row.QDes ?? '').replace(/^\//, '').trim();
  if (!name) continue;
  table[id] = { n: name };
  const em = String(row.EMCode ?? '').trim();
  if (/^\d+$/.test(em)) table[id].e = em;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(table, null, 0)}\n`, 'utf8');
const withImg = Object.values(table).filter((item) => item.e).length;
console.log(`已生成 ${path.relative(root, outFile)}：${Object.keys(table).length} 个表情（${withImg} 个带图号），来源 ${asset}`);
