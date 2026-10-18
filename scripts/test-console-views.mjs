// 控制台视图契约自检：VIEWS 里每个视图都必须导出 id + title + mount（还有 html 片段）。
// 为什么需要它：线上真事——新加的「相册」视图漏了 `export const id`，浏览器直接抛
// `Uncaught Error: view 必须有 id 和 mount()`，整站停在「加载中…」（模块图崩了）。
// 这类错误纯前端、审计跑不到，所以在这里做静态契约检查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public/console');
const appSrc = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const m = /const VIEWS = \[([^\]]+)\]/.exec(appSrc);
if (!m) throw new Error('app.js 里找不到 VIEWS 列表');
const views = m[1].split(',').map((x) => x.trim()).filter(Boolean);

let fail = 0;
console.log(`VIEWS: ${views.join(', ')}`);
for (const name of views) {
  const js = path.join(dir, 'views', `${name}.js`);
  const html = path.join(dir, 'views', `${name}.html`);
  const problems = [];
  let src = '';
  try { src = fs.readFileSync(js, 'utf8'); } catch { problems.push('缺少 .js'); }
  if (src && !/export const id\s*=/.test(src)) problems.push('缺少 export const id');
  if (src && !/export const title\s*=/.test(src)) problems.push('缺少 export const title');
  if (src && !/export (async )?function mount\s*\(/.test(src)) problems.push('缺少 export mount()');
  if (!fs.existsSync(html)) problems.push('缺少 .html 片段');
  if (problems.length) { fail++; console.error(`❌ ${name}: ${problems.join('；')}`); }
  else console.log(`✅ ${name}`);
}
// 反向检查：app.js 不能 import 已被删掉的视图文件
for (const imp of [...appSrc.matchAll(/from '\.\/views\/([^']+)\.js'/g)].map((x) => x[1])) {
  if (!fs.existsSync(path.join(dir, 'views', `${imp}.js`))) { fail++; console.error(`❌ app.js 仍然 import 了不存在的视图：${imp}`); }
}
console.log(`\n结果：${views.length - fail} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
