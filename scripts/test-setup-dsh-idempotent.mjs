// setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次，
// 断言不会产生重复的 MCP 条目 id（DSH 遇到重复 loader entry id 会启动崩溃）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpHome = path.join(ROOT, 'state', 'setup-dsh-test-home');
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, 'profiles', 'web'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

// 预置一个「历史版本」patch：无 BEGIN/END 标记、含空的 [] 根节点、只挂了 2 个 MCP
const legacyPatch = `# legacy profile patch
[]
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-snowluma-safe.js'

- insert:
    - id: mcp-snowluma-host
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma-host
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-host-server.js'
`;
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), legacyPatch, 'utf8');
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-approval-toast': 'file:C:/x/dsh-approval-toast' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-approval-toast'] } },
}, null, 2), 'utf8');

// 用指向本仓库插件的 junction 冒充上一轮已安装的插件链接（与真实安装形态一致），
// 这样脚本会走「已存在且指向本仓库 → 跳过」的正常分支。
fs.symlinkSync(path.join(ROOT, 'plugins', 'qq-mode-console'), path.join(tmpHome, 'plugins', 'qq-mode-console'), 'junction');

function runSetup(label) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web'], {
    // 保留最小 PATH（进程启动需要），但把 dsh CLI 排除在外 → 跳过自动 pnpm 安装那一步
    // preset 安装方式固定为 modern：本用例的 DSH_HOME 落在仓库内，自动探测可能反查到仓库自身的 node_modules。
    env: { ...process.env, DSH_HOME: tmpHome, PATH: path.dirname(process.execPath), QQ_BRIDGE_DSH_PRESET_FORMAT: 'modern' },
    encoding: 'utf8',
    cwd: ROOT,
  });
  console.log(`\n--- ${label} (exit=${r.status}${r.error ? ' err=' + r.error.message : ''}) ---`);
  console.log((r.stdout || '').trim() || '(no stdout)');
  if (r.stderr?.trim()) console.log('STDERR:', r.stderr.trim());
  return r;
}

runSetup('第 1 次运行');
runSetup('第 2 次运行');

const finalPatch = fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');

// 断言 1：每个托管 id 恰好出现一次
let failed = 0;
for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe', 'preset-qq-chat', 'preset-qq-chat-v2']) {
  const n = finalPatch.split('\n').filter((l) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(l)).length;
  const ok = n === 1;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} id ${id} 出现 ${n} 次（期望 1）`);
}

// 断言 2：旧路径已被替换为本仓库路径
const hasOldPath = finalPatch.includes('old/path/');
console.log(`${hasOldPath ? '❌' : '✅'} 旧脚本路径已清除（old/path 出现=${hasOldPath}）`);
if (hasOldPath) failed += 1;

// 断言 3：独立成行的 [] 已被剥离
const hasBareArray = /^[ \t]*\[\][ \t]*$/m.test(finalPatch);
console.log(`${hasBareArray ? '❌' : '✅'} 无独立成行的空数组 []`);
if (hasBareArray) failed += 1;

// 断言 4：YAML 可解析且顶层是数组
const YAML = await import(pathToFileURL(path.join(dshModulesDir(), 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;
let doc;
try { doc = yaml.load(finalPatch); } catch (e) {
  console.log(`❌ YAML 解析失败: ${e.message}`); failed += 1;
}
if (doc) {
  const ok = Array.isArray(doc);
  console.log(`${ok ? '✅' : '❌'} YAML 顶层为数组（${Array.isArray(doc) ? doc.length + ' 项' : typeof doc}）`);
  if (!ok) failed += 1;
  const ids = doc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
  console.log(`   解析出的 MCP id: ${ids.join(', ')}`);
}

// 断言 5：profile package.json 含 qq-mode-console bundle，且未破坏其他 bundle
const pkg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), 'utf8'));
const bundles = pkg.dsh.profile.bundles;
const okBundle = bundles.includes('qq-mode-console') && bundles.includes('dsh-approval-toast');
console.log(`${okBundle ? '✅' : '❌'} profile bundles 正确: ${bundles.join(', ')}`);
if (!okBundle) failed += 1;

// 断言 6：preset 已安装
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const f = path.join(tmpHome, '.agent-presets', p, 'agent.cordis.yml');
  const ok = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('prefix:');
  console.log(`${ok ? '✅' : '❌'} preset ${p} 已安装且使用 prefix 字段`);
  if (!ok) failed += 1;
}

// 断言 7：modern 行携带完整 preset 组成（与仓库源文件往返一致），且相对插件已落到 profile 内
const unstaged = (rows) => rows.map((r) => {
  const copy = { ...r };
  if (typeof copy.name === 'string' && copy.name.startsWith('./qq-bridge-presets/')) {
    copy.name = `./${copy.name.split('/').slice(3).join('/')}`;
  }
  if (Array.isArray(copy.config)) copy.config = unstaged(copy.config);
  return copy;
});
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const row = (doc || []).flatMap((e) => e?.insert || []).find((x) => x.id === `preset-${p}`);
  const source = yaml.load(fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', p, 'agent.cordis.yml'), 'utf8').replace(/^\uFEFF/, ''));
  const same = row !== undefined && JSON.stringify(unstaged(row.config.plugins)) === JSON.stringify(source);
  console.log(`${same ? '✅' : '❌'} preset 行 ${p} 组成与仓库源文件一致`);
  if (!same) failed += 1;
  const staged = path.join(tmpHome, 'profiles', 'web', 'qq-bridge-presets', p, 'qq-tool-restrict.mjs');
  const stagedOk = row !== undefined && fs.existsSync(staged)
    && fs.readFileSync(staged).equals(fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', p, 'qq-tool-restrict.mjs')));
  console.log(`${stagedOk ? '✅' : '❌'} preset ${p} 的相对插件已复制到 profile`);
  if (!stagedOk) failed += 1;
  // 断言 8：暂存目录自带 name+version 的 package.json——否则 DSH 0.2 的
  // dsh_plugin_packages 会向上找到 profile 的清单（有 name 无 version）并抛错，
  // 每个回合都失败为「DeepSeek request extension preparation failed」。
  const manifestPath = path.join(tmpHome, 'profiles', 'web', 'qq-bridge-presets', p, 'package.json');
  let identity = null;
  try { identity = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 缺失或损坏 */ }
  const identityOk = identity !== null
    && typeof identity.name === 'string' && identity.name.length > 0
    && typeof identity.version === 'string' && identity.version.length > 0;
  console.log(`${identityOk ? '✅' : '❌'} preset ${p} 暂存目录的 package.json 有非空 name+version`);
  if (!identityOk) failed += 1;
}

console.log(failed === 0 ? '\n✅ setup-dsh.mjs 幂等性测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
