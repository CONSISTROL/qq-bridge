#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//      - DSH 0.2+：在 profile 的 cordis.patch.yml 里声明成 @deepseek-ai/dsh-agent-preset
//        插件行（0.2 的 preset registry 不再扫描 ~/.dsh/.agent-presets/ 目录）
//      - DSH 0.1.x：仍按老办法复制到 ~/.dsh/.agent-presets/<id>/
//      两条路都保留；用 QQ_BRIDGE_DSH_PRESET_FORMAT=auto|modern|legacy 可强制。
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 在 profile package.json 中注册 qq-mode-console 插件
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { dshModulesDir } from './dsh-modules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

// A profile is a directory name, never a path (same boundary as DSH itself).
if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`invalid profile name: ${JSON.stringify(PROFILE)}`);
}

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyPreset(name) {
  const src = path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
  const dest = path.join(DSH_HOME, '.agent-presets', name);
  if (!fs.existsSync(src)) fatal(`preset source not found: ${src}`);
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
  log(`preset installed: ${name}`);
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 由桥接托管的 MCP 条目 id：脚本对这三个 id 拥有所有权，可安全地按 id 增删。
const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];

// 由桥接托管的 agent preset：仓库 dsh/agent-presets/<id>/ 是唯一真源，
// profile patch 里的行 id 固定为 preset-<id>，脚本对它们拥有所有权。
const PRESET_IDS = Object.freeze(['qq-chat', 'qq-chat-v2']);
const MANAGED_PRESET_IDS = Object.freeze(PRESET_IDS.map((id) => `preset-${id}`));
const DSH_AGENT_PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset';
const PRESET_STAGE_DIR = 'qq-bridge-presets';

/** preset 在仓库里的源目录。 */
function presetSourceDir(id) {
  return path.join(REPO_ROOT, 'dsh', 'agent-presets', id);
}

/**
 * 选择 preset 安装方式。
 *
 * - `modern`（DSH 0.2+）：preset 必须声明为 @deepseek-ai/dsh-agent-preset 插件行；
 *   0.2 的 registry 明确「既不扫描目录也不接受 preset 路径」。
 * - `legacy`（DSH 0.1.x）：复制到 ~/.dsh/.agent-presets/<id>/。
 *
 * 判定顺序：环境变量强制 → DSH 安装目录里有没有 dsh-agent-preset 包 →
 * 定位不到安装目录时按 modern 走（宁可报错显眼，也不要静默装成 0.1.x 的样子）。
 */
function detectPresetFormat() {
  const requested = String(process.env.QQ_BRIDGE_DSH_PRESET_FORMAT ?? 'auto').trim().toLowerCase() || 'auto';
  if (requested === 'modern' || requested === 'legacy') {
    log(`preset 安装方式：${requested}（QQ_BRIDGE_DSH_PRESET_FORMAT 指定）`);
    return requested;
  }
  if (requested !== 'auto') {
    fatal(`QQ_BRIDGE_DSH_PRESET_FORMAT 只接受 auto/modern/legacy，收到 ${JSON.stringify(requested)}`);
  }
  try {
    const modules = dshModulesDir();
    const marker = path.join(modules, ...DSH_AGENT_PRESET_PACKAGE.split('/'), 'package.json');
    if (fs.existsSync(marker)) {
      log(`preset 安装方式：modern（DSH 提供 ${DSH_AGENT_PRESET_PACKAGE}）`);
      return 'modern';
    }
    // 只有确认「这确实是 DSH 安装目录」时才敢判定 legacy：dshModulesDir() 在
    // DSH_HOME 落在别的工程目录下时可能反查到无关的 node_modules。
    const looksLikeDsh = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-agent-preset-registry']
      .some((name) => fs.existsSync(path.join(modules, ...name.split('/'), 'package.json')));
    if (looksLikeDsh) {
      log(`preset 安装方式：legacy（DSH ${path.dirname(modules)} 未提供 ${DSH_AGENT_PRESET_PACKAGE}，按 0.2 之前处理）`);
      return 'legacy';
    }
    log(`preset 安装方式：modern（${modules} 不像 DSH 安装目录，无法判定版本）`);
    log('  若目标设备仍是 DSH 0.1.x，请改用：QQ_BRIDGE_DSH_PRESET_FORMAT=legacy node scripts/setup-dsh.mjs');
    return 'modern';
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0];
    log(`preset 安装方式：modern（定位不到 DSH 安装目录：${reason}）`);
    log('  若目标设备仍是 DSH 0.1.x，请改用：QQ_BRIDGE_DSH_PRESET_FORMAT=legacy node scripts/setup-dsh.mjs');
    return 'modern';
  }
}

/** 读 preset 的展示元数据（preset.yml 的 name/description/order），缺失即忽略。 */
function readPresetMeta(id) {
  const file = path.join(presetSourceDir(id), 'preset.yml');
  const meta = {};
  if (!fs.existsSync(file)) return meta;
  let doc;
  try { doc = yaml.load(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { fatal(`failed to parse ${file}: ${error.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return meta;
  if (typeof doc.name === 'string' && doc.name) meta.name = doc.name;
  if (typeof doc.description === 'string' && doc.description) meta.description = doc.description;
  if (doc.order !== undefined && doc.order !== null) meta.order = doc.order;
  return meta;
}

/** 读 preset 的组成（agent.cordis.yml 的顶层插件行数组）。 */
function loadPresetComposition(id) {
  const file = path.join(presetSourceDir(id), 'agent.cordis.yml');
  if (!fs.existsSync(file)) fatal(`preset composition not found: ${file}`);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  // !!js 是 Loader 的表达式节点，YAML 解析/再序列化会丢语义，所以显式拒绝而不是静默改写。
  if (/!!js\b/.test(raw)) {
    fatal(`${file} 含 !!js 表达式，内联进 profile patch 会丢失语义；请改写为普通 YAML，或改用 legacy 安装`);
  }
  let rows;
  try { rows = yaml.load(raw); }
  catch (error) { fatal(`failed to parse ${file}: ${error.message}`); }
  if (!Array.isArray(rows) || rows.length === 0) fatal(`${file} 必须是顶层插件行数组（非空）`);
  return rows;
}

/**
 * 把 preset 里 `./xxx.mjs` 形式的相对插件复制到 profile 目录下并改写路径。
 *
 * 插件行被内联进 profile 的 cordis.patch.yml 后，Loader 以该 patch 文件所在目录
 * 为 baseUrl 解析 `./`，所以相对文件必须真的躺在 profile 目录里。
 */
function stageRelativePlugins(rows, id, profileDir) {
  const stageRoot = path.join(profileDir, PRESET_STAGE_DIR, id);
  let staged = 0;
  const walk = (list) => {
    for (const row of list) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (typeof row.name === 'string' && row.name.startsWith('./')) {
        const rel = row.name.slice(2).replace(/\\/g, '/');
        if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
          fatal(`preset ${id} 引用了非法插件路径：${row.name}`);
        }
        const from = path.join(presetSourceDir(id), ...rel.split('/'));
        if (!fs.existsSync(from)) fatal(`preset ${id} 引用的插件不存在：${from}`);
        const to = path.join(stageRoot, ...rel.split('/'));
        ensureDir(path.dirname(to));
        fs.copyFileSync(from, to);
        row.name = `./${PRESET_STAGE_DIR}/${id}/${rel}`;
        staged++;
        log(`preset 插件已复制到 profile：${to}`);
      }
      // group 行把子插件放在 config 数组里，同样要处理。
      if (Array.isArray(row.config)) walk(row.config);
    }
  };
  walk(rows);
  if (staged > 0) writeStageManifest(stageRoot, id);
}

/**
 * 给暂存目录写一个带 name + version 的 package.json。
 *
 * DSH 0.2 的 `dsh_plugin_packages` 请求扩展（@deepseek-ai/dsh-plugin-package-inventory-deepseek）
 * 会给每个生效插件推导包身份：相对路径插件会向上找「最近的 package.json」，只要有 name 就必须
 * 同时有**非空 version**，否则它抛错 → `REQUEST_EXTENSION` → 每个回合都以
 * 「DeepSeek request extension preparation failed」失败。若不写这个文件，向上找到的会是
 * profile 自己的 package.json（DSH 生成，只有 name 没有 version），正好踩中。
 */
function writeStageManifest(stageRoot, id) {
  ensureDir(stageRoot);
  let version = '0.0.0';
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    if (typeof repo.version === 'string' && repo.version) version = repo.version;
  } catch { /* 仓库 package.json 不可读时用占位版本，非空即可 */ }
  const text = `${JSON.stringify({ name: `qq-bridge-agent-preset-${id}`, version, private: true }, null, 2)}\n`;
  const manifestPath = path.join(stageRoot, 'package.json');
  let current = '';
  try { current = fs.readFileSync(manifestPath, 'utf8'); } catch { /* 首次写入 */ }
  if (current === text) return;
  fs.writeFileSync(manifestPath, text, 'utf8');
  log(`preset 暂存目录已写入 package.json（DSH 推导插件包身份要求 name+version）：${manifestPath}`);
}

/** 生成 profile patch 里的 preset 托管区块（legacy 方式下不写入）。 */
function presetEntries(profileDir, format) {
  if (format !== 'modern') return '';
  const inserts = [];
  for (const id of PRESET_IDS) {
    const plugins = loadPresetComposition(id);
    stageRelativePlugins(plugins, id, profileDir);
    inserts.push({
      insert: [{
        id: `preset-${id}`,
        name: DSH_AGENT_PRESET_PACKAGE,
        config: { id, ...readPresetMeta(id), plugins },
      }],
    });
  }
  let out = '# === qq-bridge agent preset BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  out += `# DSH 0.2 起 preset 必须声明为 ${DSH_AGENT_PRESET_PACKAGE} 行；本区块由 ${path.join('dsh', 'agent-presets')}/<id>/agent.cordis.yml 生成。\n`;
  out += yaml.dump(inserts, { lineWidth: -1, noRefs: true });
  out += '# === qq-bridge agent preset END ===\n';
  return out;
}

function mcpEntries() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const [id, s] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(s.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function prepareCordisPatch(format) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removedMcp = 0;
  let removedPreset = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (MANAGED_MCP_IDS.includes(entry?.id)) { removedMcp++; return false; }
      if (MANAGED_PRESET_IDS.includes(entry?.id)) { removedPreset++; return false; }
      return true;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  // preset 区块在 mcp 区块之前：先声明 preset，再挂 MCP。
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '')
    + presetEntries(profileDir, format)
    + mcpEntries();
  return { patchFile, original, text, removedMcp, removedPreset };
}

function patchCordis({ patchFile, original, text, removedMcp, removedPreset }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    try { fs.writeFileSync(`${patchFile}.qq-bridge.bak`, original, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removedMcp} 条，写入 ${MANAGED_MCP_IDS.length} 条）`);
  if (removedPreset > 0) log(`cordis.patch.yml: preset 条目已清理 ${removedPreset} 条`);
}

function ensurePluginLink() {
  const repoPlugin = path.join(REPO_ROOT, 'plugins', 'qq-mode-console');
  const pluginLink = path.join(DSH_HOME, 'plugins', 'qq-mode-console');
  if (!fs.existsSync(repoPlugin)) fatal(`plugin not found: ${repoPlugin}`);
  ensureDir(path.dirname(pluginLink));

  let existing = null;
  try {
    existing = fs.lstatSync(pluginLink);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect plugin link: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`plugin path already exists and is not a symlink/junction: ${pluginLink}. Please remove it manually or move it out of the way, then rerun.`);
    }
    // 符号链接/junction 存在时，校验是否指向当前仓库；指向旧路径/失效时自动重建。
    let sameTarget = false;
    try {
      const target = fs.realpathSync(pluginLink);
      const expected = fs.realpathSync(repoPlugin);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`plugin link already exists and points to this repo: ${pluginLink}`);
      return pluginLink;
    }
    log(`plugin link exists but points elsewhere/broken, recreating: ${pluginLink}`);
    fs.rmSync(pluginLink, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(repoPlugin, pluginLink, 'junction');
    } else {
      fs.symlinkSync(repoPlugin, pluginLink, 'dir');
    }
    log(`plugin link created: ${pluginLink}`);
  } catch (e) {
    fatal(`failed to create plugin link: ${e.message}`);
  }
  return pluginLink;
}

function patchProfilePackage(pluginLink) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  const linkVal = `link:${pluginLink.replace(/\\/g, '/')}`;
  if (pkg.dependencies['qq-mode-console'] !== linkVal) {
    pkg.dependencies['qq-mode-console'] = linkVal;
    log(`package.json dependency qq-mode-console -> ${linkVal}`);
  }
  if (!pkg.dsh.profile.bundles.includes('qq-mode-console')) {
    pkg.dsh.profile.bundles.push('qq-mode-console');
    log(`package.json bundle added: qq-mode-console`);
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console 以 link: 依赖注册进 profile package.json 后，DSH 首次启动需要先安装一次
// 才能解析该 bundle（否则 cold start 报 "cannot resolve profile bundle"）。dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return;
  }
  const windows = process.platform === 'win32';
  // Node cannot spawn npm's .cmd shim directly. Keep the shell command constant;
  // the validated (no quotes/control chars) profile travels through one quoted
  // environment expansion, with delayed expansion disabled to preserve '!'.
  const cmd = windows ? (process.env.ComSpec || 'cmd.exe') : 'dsh';
  const args = windows
    ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install']
    : ['plugin', '--profile', PROFILE, 'install'];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    windowsVerbatimArguments: windows,
    ...(windows ? { env: { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE } } : {}),
  });
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle \\"qq-mode-console\\"”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

// Validate the existing YAML before changing any presets or configuration.
const presetFormat = detectPresetFormat();
const cordisPatch = prepareCordisPatch(presetFormat);
// 老式目录复制始终保留：DSH 0.1.x 靠它加载 preset，0.2+ 靠它给桥接的 preset 组成戳
// （src/preset-stamp.js 以 .agent-presets/<id>/ 的文件哈希判断会话是否要重建）当基准。
copyPreset('qq-chat');
copyPreset('qq-chat-v2');
patchCordis(cordisPatch);
const pluginLink = ensurePluginLink();
patchProfilePackage(pluginLink);
ensureLocalModeFile();
autoInstallProfileBundles();
if (presetFormat === 'modern') {
  log('Done. profile patch 已更新；DSH 的 HMR 会监听 cordis.patch.yml 并热加载，若未生效请重启 DSH。');
} else {
  log('Done. Please restart DSH (or reload the profile) for the new presets/MCP to take effect.');
}
