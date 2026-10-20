// 找 bridge.js 里声明了但从未被引用的顶层/模块级函数与变量（死代码候选）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? path.join(ROOT, 'src', 'bridge.js');
const source = fs.readFileSync(file, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true });
const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });

const moduleScope = sm.globalScope.childScopes.find((s) => s.type === 'module') ?? sm.globalScope;

function report(scope, label) {
  const dead = [];
  for (const v of scope.variables) {
    if (v.name === 'arguments') continue;
    const def = v.defs[0];
    if (!def) continue;
    if (def.type === 'ImportBinding') continue;
    if (['FunctionName', 'ClassName'].includes(def.type) && def.node.id?.name?.startsWith('_')) continue;
    if (v.references.length === 0) {
      dead.push({ name: v.name, line: def.name?.loc?.start.line ?? def.node?.loc?.start.line, kind: def.type });
    }
  }
  if (dead.length) {
    console.log(`\n## ${label}：${dead.length} 个无引用声明`);
    for (const d of dead.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) console.log(`  ${String(d.line ?? '?').padStart(6)}  ${d.kind.padEnd(14)} ${d.name}`);
  }
}

report(moduleScope, '模块级');

// main() 内部顶层绑定
const mainNode = ast.body.find((s) => s.type === 'FunctionDeclaration' && s.id.name === 'main');
if (mainNode) {
  const mainScope = sm.acquire(mainNode);
  report(mainScope, 'main() 顶层');
}
