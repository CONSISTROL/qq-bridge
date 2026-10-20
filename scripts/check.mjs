// 全仓库静态检查（不依赖 eslint）：
//   1) 每个源文件都能通过语法检查；
//   2) 没有「引用但未声明」的标识符（ESM 严格模式下这会直接 ReferenceError）；
//   3) 顺带报告疑似死代码（不判失败，只提示）。
//
// 用法：node scripts/check.mjs [--dead]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const targets = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'public', 'console')),
  ...walk(path.join(ROOT, 'scripts')).filter((f) => path.basename(f) !== path.basename(fileURLToPath(import.meta.url)))
];

let failed = 0;
for (const file of targets) {
  const rel = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ 语法错误 ${rel}\n${result.stderr}`);
  }
}
console.log(`语法检查：${targets.length - failed}/${targets.length} 通过`);

// 未声明标识符（只查 src，scripts 里允许一些运行时注入的全局）
const srcFiles = walk(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f));
const undeclared = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-undeclared.mjs'), ...srcFiles], { encoding: 'utf8' });
process.stdout.write(undeclared.stdout || '');
if (undeclared.status !== 0) { failed += 1; process.stderr.write(undeclared.stderr || ''); }

// import 解析：bridge.js 里每个相对 import 的具名导出必须真实存在。
// （线上踩过：mc-control 少了 getWhitelist/whitelistAction 的导出，ESM 启动即崩。）
{
  const { pathToFileURL } = await import('node:url');
  const bridgeSource = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  // 先匹配所有 import 语句（不管来源），再只校验相对路径。
  // 不能把「相对路径」写进正则：中间夹着 node:xxx 的 import 会被整段吞掉、张冠李戴。
  const importRe = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm;
  let checked = 0;
  const missing = [];
  for (const match of bridgeSource.matchAll(importRe)) {
    const clause = match[1];
    const spec = match[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(ROOT, 'src', spec);
    let mod = {};
    try { mod = await import(pathToFileURL(target).href); }
    catch (error) { missing.push(`${spec}: 无法加载（${error?.message ?? error}）`); continue; }
    const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.trim());
    if (defaultMatch && !('default' in mod)) missing.push(`${spec}: 缺少默认导出 ${defaultMatch[1]}`);
    const namedMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const imported = piece.split(/\s+as\s+/)[0].trim();
        checked += 1;
        if (!(imported in mod)) missing.push(`${spec}: 缺少导出 ${imported}`);
      }
    }
  }
  if (missing.length) {
    failed += 1;
    console.error('import 解析失败：');
    for (const line of missing) console.error('  ✗ ' + line);
  } else {
    console.log(`import 解析：${checked} 个具名导入全部存在`);
  }
}

if (process.argv.includes('--dead')) {
  const dead = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'find-dead-code.mjs')], { encoding: 'utf8' });
  process.stdout.write(dead.stdout || '');
}

process.exitCode = failed ? 1 : 0;
