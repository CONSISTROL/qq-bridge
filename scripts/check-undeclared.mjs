// 检查一组 JS 文件里「引用但未声明」的标识符（排除标准全局）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNOWN_GLOBALS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Symbol', 'BigInt', 'Intl', 'Infinity', 'NaN', 'undefined',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'Buffer', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'structuredClone',
  'process', 'console', 'globalThis', 'fetch', 'FormData', 'Blob', 'File', 'atob', 'btoa', 'crypto', 'performance',
  'WebSocket', 'Headers', 'Request', 'Response', 'ReadableStream', 'WritableStream', 'TransformStream',
  'MessageChannel', 'MessagePort', 'BroadcastChannel',
  // 浏览器上下文（puppeteer 的 page.evaluate 回调里会用到，代码实际在页面里执行）
  'document', 'window', 'location', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element'
]);

let problems = 0;
const files = process.argv.slice(2);
for (const rel of files) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const source = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const missing = new Map();
  for (const scope of sm.scopes) {
    for (const ref of scope.references) {
      if (ref.resolved) continue;
      const name = ref.identifier.name;
      if (KNOWN_GLOBALS.has(name)) continue;
      if (!missing.has(name)) missing.set(name, ref.identifier.loc.start.line);
    }
  }
  if (missing.size) {
    problems += missing.size;
    console.log(`\n${rel}:`);
    for (const [name, line] of missing) console.log(`  line ${line}: ${name}`);
  }
}
console.log(problems ? `\n共 ${problems} 个未声明标识符` : '\n没有未声明标识符');
process.exitCode = problems ? 1 : 0;
