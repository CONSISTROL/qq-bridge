// 控制台前端结构自检（不需要桥接在跑、不需要浏览器）。
//
// 拆分之后最容易出的错不是语法错误，而是「引用了不存在的元素 / 分区 / 配置分区」——
// 旧控制台就是因为在顶层写了几十个 getElementById(...).addEventListener，
// 任何一个 id 写错都会让后面所有绑定静默失效。这个脚本把这类错挡在提交前：
//
//   1. 所有前端 .js 语法可解析（node --check）；
//   2. import 的相对路径都真实存在（没有拆错文件名/路径）；
//   3. 每个 view 模块都导出 id/title/mount，且有同名 .html 片段；
//   4. app.js 的 VIEWS 与 views/ 目录一一对应（不漏也不多）；
//   5. view 里静态引用的 #id 必须能在它自己的片段里找到；
//   6. data-v2-cfg / data-slang-tab 这类「字符串开关」在对应的 JS 表里都有定义。
//
// 用法：node scripts/test-console-views.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_DIR = path.join(ROOT, 'public', 'console');
const VIEWS_DIR = path.join(CONSOLE_DIR, 'views');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

function listJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJs(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
}

const jsFiles = [path.join(CONSOLE_DIR, 'app.js'), ...listJs(path.join(CONSOLE_DIR, 'core')), ...listJs(VIEWS_DIR)];
const read = (file) => fs.readFileSync(file, 'utf8');
const rel = (file) => path.relative(ROOT, file);

console.log('控制台前端结构自检\n');

// ── 1. 语法 ──────────────────────────────────────────────────────────
check('所有前端模块语法可解析（node --check）', () => {
  const bad = [];
  for (const file of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${rel(file)}: ${(r.stderr || '').split('\n')[0]}`);
  }
  assert(bad.length === 0, bad.join('\n    '));
  return `${jsFiles.length} 个文件`;
});

// ── 2. import 路径都存在 ─────────────────────────────────────────────
check('相对 import 都指向真实文件', () => {
  const missing = [];
  for (const file of jsFiles) {
    for (const m of read(file).matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(target)) missing.push(`${rel(file)} → ${m[1]}`);
    }
  }
  assert(missing.length === 0, `找不到：\n    ${missing.join('\n    ')}`);
});

// ── 3. view 契约：id/title/mount + 同名片段 ──────────────────────────
const viewFiles = fs.readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.js')).sort();
const viewMeta = new Map();
check('每个 view 都导出 id/title/mount 且有同名 .html', () => {
  const problems = [];
  for (const name of viewFiles) {
    const code = read(path.join(VIEWS_DIR, name));
    const id = /^export const id = '([^']+)'/m.exec(code)?.[1];
    const title = /^export const title = '([^']+)'/m.exec(code)?.[1];
    const hasMount = /^export async function mount\(/m.test(code);
    if (!id) problems.push(`${name} 缺 export const id`);
    if (!title) problems.push(`${name} 缺 export const title`);
    if (!hasMount) problems.push(`${name} 缺 export async function mount`);
    if (!id) continue;
    if (id !== name.replace(/\.js$/, '')) problems.push(`${name} 的 id (${id}) 与文件名不一致`);
    const frag = path.join(VIEWS_DIR, `${id}.html`);
    if (!fs.existsSync(frag)) problems.push(`${name} 缺片段 ${id}.html`);
    viewMeta.set(id, { js: path.join(VIEWS_DIR, name), html: frag, code });
  }
  assert(problems.length === 0, problems.join('\n    '));
  return viewMeta.size + ' 个分区';
});

check('view id 不重复', () => {
  const ids = [...viewMeta.keys()];
  assert(new Set(ids).size === ids.length, '有重复 id');
  return ids.join(', ');
});

// ── 4. app.js 的 VIEWS 与 views/ 目录一一对应 ────────────────────────
const appCode = read(path.join(CONSOLE_DIR, 'app.js'));
check('app.js 注册的分区与 views/ 一一对应', () => {
  const imported = new Map([...appCode.matchAll(/import \* as (\w+) from '\.\/views\/([\w-]+)\.js'/g)]
    .map((m) => [m[2], m[1]]));
  const listed = (appCode.match(/const VIEWS = \[([^\]]+)\]/)?.[1] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const problems = [];
  for (const [id, alias] of imported) {
    if (!listed.includes(alias)) problems.push(`views/${id}.js 已 import（${alias}）但没进 VIEWS`);
    if (!viewMeta.has(id)) problems.push(`views/${id}.js 不存在或不符合 view 契约`);
  }
  for (const alias of listed) {
    if (![...imported.values()].includes(alias)) problems.push(`VIEWS 里的 ${alias} 没有对应 import`);
  }
  for (const id of viewMeta.keys()) {
    if (!imported.has(id)) problems.push(`views/${id}.js 没有在 app.js 里注册`);
  }
  assert(problems.length === 0, problems.join('\n    '));
  return `${listed.length} 个分区`;
});

// ── 5. view 里静态引用的 #id 必须存在于自己的片段 ────────────────────
check('view 引用的 #id 都能在自己的片段里找到', () => {
  const problems = [];
  for (const [id, meta] of viewMeta) {
    const htmlIds = new Set([...read(meta.html).matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...meta.code.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
    for (const usedId of used) {
      if (!htmlIds.has(usedId)) problems.push(`${id}.js 引用了 #${usedId}，但 ${id}.html 里没有`);
    }
  }
  assert(problems.length === 0, problems.join('\n    '));
});

// ── 6. 字符串开关（data-*）在对应 JS 表里有定义 ──────────────────────
check('data-v2-cfg 指向的工具配置分区都已定义', () => {
  const html = read(viewMeta.get('social2').html);
  const wanted = new Set([...html.matchAll(/data-v2-cfg="([^"]+)"/g)].map((m) => m[1]));
  const code = viewMeta.get('social2').code;
  const missing = [...wanted].filter((key) => !new RegExp(`^  ${key}: \\{`, 'm').test(code));
  assert(missing.length === 0, `social2.js 的 CFG_SCHEMA 缺少：${missing.join(', ')}`);
  return [...wanted].join(', ');
});

check('data-slang-tab 指向的标签页都已定义', () => {
  const html = read(viewMeta.get('slang').html);
  const wanted = new Set([...html.matchAll(/data-slang-tab="([^"]+)"/g)].map((m) => m[1]));
  const code = viewMeta.get('slang').code;
  const missing = [...wanted].filter((key) => !new RegExp(`${key}: \\{ list:`).test(code));
  assert(missing.length === 0, `slang.js 的 TAB_INFO 缺少：${missing.join(', ')}`);
  return [...wanted].join(', ');
});

check('TAB_INFO 的每个面板 id 都存在于片段', () => {
  const html = read(viewMeta.get('slang').html);
  const code = viewMeta.get('slang').code;
  const ids = ['list', 'search', 'limit', 'selectAll']
    .flatMap((field) => [...code.matchAll(new RegExp(`${field}: '([\\w]+)'`, 'g'))].map((m) => m[1]));
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert(missing.length === 0, `片段里缺少：${missing.join(', ')}`);
  return `${ids.length} 个控件`;
});

// ── 7. 每个分区片段都被 shell 的样式/路由体系覆盖 ────────────────────
check('每个片段都至少有内容（不是空文件）', () => {
  const empty = [...viewMeta.values()].filter((m) => read(m.html).trim().length < 100).map((m) => rel(m.html));
  assert(empty.length === 0, `片段过短：${empty.join(', ')}`);
});

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败 ❌` : '，全部通过 ✅'}`);
if (failed) process.exit(1);
