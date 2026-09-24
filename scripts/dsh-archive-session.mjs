#!/usr/bin/env node
// 通过 DSH RPC 归档一个会话（供 forget-user.sh 使用）。
//
// 为什么不直接改 ~/.dsh/storages/workspace.json：
//   DSH 的 workspace 域只在**启动时**从该文件装载一次，之后以内存态为准、并在每次
//   变更时整份回写。脚本手改文件时：① 对运行中的 DSH 不生效（GUI 列表照旧）；
//   ② 下一次任何工作区变更都会用内存态把这次手改覆盖掉（等于白改）；
//   ③ 归档集合是「注册表全局」的，手改很容易把**正在使用**的会话也顺手标进归档。
//   走 RPC 时归档直接写进运行中的 DSH，并且是它自己持久化，两边永不打架。
//
// 用法：node scripts/dsh-archive-session.mjs <sessionId>
//   --allow-offline：DSH 不可达时退回「改文件」的旧行为（并明确提示需重启 DSH）
// 退出码：0 = 已归档（或本来就在归档集合里）；2 = DSH 不可达且未允许离线；1 = 其它失败

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const args = process.argv.slice(2);
const allowOffline = args.includes('--allow-offline');
const sessionId = args.find((a) => !a.startsWith('--'));
if (!sessionId) {
  console.error('[archive] 用法：node scripts/dsh-archive-session.mjs <sessionId> [--allow-offline]');
  process.exit(1);
}

/** 离线兜底：改 workspace.json（需重启 DSH 才生效，且可能被运行中的内存态覆盖）。 */
function archiveByFile() {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json');
  if (!fs.existsSync(file)) return false;
  const ws = readJson(file, null);
  if (!ws) return false;
  const g = (ws.global = ws.global || {});
  const arch = Array.isArray(g.archivedSessionIds) ? g.archivedSessionIds : (g.archivedSessionIds = []);
  const already = arch.includes(sessionId);
  if (!already) arch.push(sessionId);
  let detached = 0;
  for (const w of Object.values((ws.tables && ws.tables.workspaces) || {})) {
    if (Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) {
      w.sessionIds = w.sessionIds.filter((x) => x !== sessionId);
      detached += 1;
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ws, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log(`[archive] 离线兜底：已写入 workspace.json（归档${already ? '集合本就有' : ' +1'}，从 ${detached} 个工作区列表移除）`);
  console.log('[archive] ⚠️ 这要等 DSH 重启才会生效；且运行中的 DSH 若发生工作区变更会覆盖它。');
  return true;
}

const dshCfg = readJson(path.join(ROOT, 'config.json'), {})?.dsh ?? {};
const baseUrl = String(dshCfg.baseUrl || 'http://127.0.0.1:3080');
const token = dshCfg.authToken || discoverDshLaunchToken();

if (!token) {
  console.error('[archive] 拿不到 DSH launch token（config.json 的 dsh.authToken 为空，guard 日志里也没发现）');
  if (allowOffline && archiveByFile()) process.exit(0);
  process.exit(2);
}

const api = new NodeApiClient(baseUrl, undefined, { token });
try {
  unwrap(await api.workspace.archiveSession({ sessionId }), 'workspace.archiveSession');
  console.log(`[archive] ✅ 运行中的 DSH 已归档 ${sessionId}（GUI 列表里不再显示，可随时在会话记录里恢复）`);
  process.exit(0);
} catch (error) {
  console.error(`[archive] RPC 归档失败：${error?.message ?? error}`);
  if (allowOffline && archiveByFile()) process.exit(0);
  process.exit(2);
}
