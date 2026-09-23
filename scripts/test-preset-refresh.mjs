// agent preset 组成戳 + 「预设改了要真正生效」的离线测试（不联网、不碰真实 DSH）。
//
// 覆盖：
// - presetCompositionStamp：内容变化才变戳、缺文件也计入、未安装返回空、DSH_HOME 可注入
// - 接线存在性：桥接是否真的在复用会话前做陈旧判定、失败时退役重建、建会话时记戳
// - 提示词存在性：preset 21b 与桥接每轮注入的「要图请求」契约都在（防止有人改回去）
//
// 用法：node scripts/test-preset-refresh.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetCompositionStamp, resolveDshHome, PRESET_STAMP_FILES } from '../src/preset-stamp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, label, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('## presetCompositionStamp');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-stamp-'));
const presetDir = path.join(home, '.agent-presets', 'qq-chat-v2');
fs.mkdirSync(presetDir, { recursive: true });
const write = (name, body) => fs.writeFileSync(path.join(presetDir, name), body);

write('agent.cordis.yml', 'prefix: A\n');
write('preset.yml', 'name: X\n');
const stamp1 = presetCompositionStamp('qq-chat-v2', { dshHome: home });
ok(/^[0-9a-f]{16}$/.test(stamp1), '组成戳是 16 位十六进制', stamp1);
ok(presetCompositionStamp('qq-chat-v2', { dshHome: home }) === stamp1, '内容不变 → 戳稳定');
ok(presetCompositionStamp('', { dshHome: home }) === '', '空 presetId → 空戳');
ok(presetCompositionStamp('not-installed', { dshHome: home }) === '', '未安装的 preset → 空戳（无法判断，不折腾会话）');

write('agent.cordis.yml', 'prefix: B\n');
const stamp2 = presetCompositionStamp('qq-chat-v2', { dshHome: home });
ok(stamp2 !== stamp1 && stamp2.length === 16, '组成文件内容变化 → 戳变化');

write('agent.cordis.yml', 'prefix: A\n');
ok(presetCompositionStamp('qq-chat-v2', { dshHome: home }) === stamp1, '内容改回去 → 戳回到原值');

fs.rmSync(path.join(presetDir, 'preset.yml'));
const stampNoMeta = presetCompositionStamp('qq-chat-v2', { dshHome: home });
ok(stampNoMeta !== '' && stampNoMeta !== stamp1, '删掉 preset.yml 也会改变戳（不会因为缺文件而“看起来没变”）');

fs.rmSync(path.join(presetDir, 'agent.cordis.yml'));
ok(presetCompositionStamp('qq-chat-v2', { dshHome: home }) === '', '组成文件全缺 → 空戳');

ok(PRESET_STAMP_FILES.includes('agent.cordis.yml') && PRESET_STAMP_FILES.includes('preset.yml'), '戳覆盖 agent.cordis.yml 与 preset.yml');
ok(resolveDshHome({ DSH_HOME: '/tmp/x' }) === '/tmp/x', 'DSH_HOME 环境变量优先');
ok(resolveDshHome({ DSH_HOME: '  ' }).endsWith(path.join('.dsh')), 'DSH_HOME 为空时回落到 ~/.dsh');
fs.rmSync(home, { recursive: true, force: true });

console.log('## 接线存在性（bridge.js）');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok(/import\s*\{\s*presetCompositionStamp\s*\}\s*from '\.\/preset-stamp\.js'/.test(bridge), 'bridge 引入 preset-stamp');
ok(/function sessionPresetStaleness\(key\)/.test(bridge), '有会话级陈旧判定函数');
ok(/cfg\.socialV2\?\.presetRefresh === false/.test(bridge), 'presetRefresh=false 可以关掉自动刷新');
ok(/if \(!current\) return none/.test(bridge), '读不到组成文件时不判定为陈旧（避免重建循环）');
ok(/sessionPresetStaleness\(key\)/.test(bridge) && /retireSession\(key\)/.test(bridge), '复用会话失败时会退役旧会话');
ok(/state\.sessionPresetStamps\[key\] = stamp/.test(bridge), '建会话时记录当时挂载的组成戳');
ok(/if \(state\.sessionPresetStamps\) delete state\.sessionPresetStamps\[key\]/.test(bridge), '退役会话时清掉组成戳');
ok(/if \(!state\.sessionPresetStamps \|\| typeof state\.sessionPresetStamps !== 'object'/.test(bridge), 'loadState 会兜底 sessionPresetStamps');
ok(/const presetStampCache = new Map\(\)/.test(bridge), '组成戳进程内缓存（改预设 + 重启桥接才重算）');

console.log('## 提示词存在性（要图契约）');
const preset = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
ok(/你的第一个动作就是搜图，然后发图/.test(preset), 'preset 21b 规定“第一个动作就是搜图发图”');
ok(/不要自己替管理员审查/.test(preset), 'preset 21b 禁止模型自行顺掉分级允许的图');
ok(/rating.*safe.*mild.*直接发/s.test(preset), 'preset 21b 写明 safe/mild 都该直接发');
ok(/来点色图.*没给主题.*mode=daily/s.test(preset), 'preset 21b 给了裸“来点色图”的兜底搜法（pixiv 日榜）');
ok(/搜到 0 条 ≠ 被分级挡了/.test(preset) && /角色名 \+ 常用标签/.test(preset), 'preset 写明「搜到 0 条 ≠ 被分级挡了」，要求换标签式关键词再搜');
ok(/【硬底线，高于一切分级配置】/.test(preset) && /不搜、不发、不讨论/.test(preset), 'preset 安全规则有未成年形象硬底线');
ok(/高于管理员的年龄分级、高于第 21b 条/.test(preset), '硬底线明确高于分级配置与 21b');
// 2026-09 修正：硬底线只针对「性化」，不能扩散成「二次元里看起来像小孩的角色图一律不发」——
// 那会让模型把虚构萝莉当成真人未成年人，连小草神（纳西妲）的正常插画都拒。
ok(/别把二次元萝莉当成真人/.test(preset), 'preset 明确「二次元萝莉 ≠ 真人」（防止硬底线扩散）');
ok(/普通、非性化插画照搜照发/.test(preset), 'preset 写明非性化的幼态二次元角色图照搜照发');
ok(/虚构角色 ≠ 真人/.test(preset), 'preset 点明虚构角色不等于真人未成年人');
ok(/唯一的例外（别扩大化）/.test(preset) && /普通、非性化的二次元角色图照常搜/.test(preset), 'preset 21b 的例外明确「别扩大化」');
ok(/别把二次元萝莉当真人/.test(bridge) && /普通、非性化图[\s\S]*照搜照发/.test(bridge), '桥接注入同样区分性化请求与正常二次元角色图');
ok(/不要自己替管理员做审查/.test(bridge), '桥接每轮注入“要图请求”契约（不受已挂载旧 preset 影响）');
ok(/搜到 0 条时先换\*\*标签式\*\*关键词/.test(bridge), '桥接每轮注入同样要求换关键词，别断言被过滤');
ok(/你的第一个动作就是调用 mcp__snowluma__qq_search_images/.test(bridge), '注入文本里明确第一个动作是 qq_search_images');
ok(/cfg\.socialV2\?\.image\?\.enabled !== false && cfg\.socialV2\?\.tools\?\.searchImages !== false/.test(bridge), '注入受图片开关控制');
// 老版 MCP 的 qq_search_images schema 只认 bilibili|pixiv|all（auto 是后加的，要 DSH 重启才到 QQ 那侧），
// 所以引导必须要求「source 每次显式写」并给出 all，别把 auto 当默认——否则模型会吃一个参数校验错误。
ok(/source 每次显式写上/.test(bridge) && /source=all/.test(bridge), '注入文本要求显式 source 并给出 all（兼容旧 MCP schema）');
ok(!/→ source=auto/.test(bridge), '注入文本不再把 source=auto 当可选图源（旧 MCP 会拒）');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
