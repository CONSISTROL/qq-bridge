#!/usr/bin/env node
// 黑话积压处理器：清理噪声 → 分批触发异步研究 → 校验转正结果。
//
// 用法：
//   node scripts/process-slang-backlog.mjs [--dry-run] [--batch=6] [--timeout=180000] [--limit=0]
//
// 设计要点：
//  * 只通过控制台 HTTP API 操作，不直接改 state/slang.json，避免与 bridge 进程写冲突。
//  * 清理只删“明确不是黑话”的类别（BV 号 / URL / 纯数字 / 超短 ASCII / 纯符号 / 重复项），
//    其余一律保留并送去研究，宁可多留不可错删。
//  * 研究结果由 bridge 端自动转正（slang.autoConfirmResearched !== false）；
//    脚本只做兜底确认，保证“研究出释义”的条目最终一定能被 AI 查到。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = path.join(ROOT, 'state', 'console-token');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const DRY_RUN = args.get('dry-run') === 'true';
const BATCH = Math.max(1, Number(args.get('batch') || 6));
const TIMEOUT_MS = Math.max(10000, Number(args.get('timeout') || 180000));
const LIMIT = Math.max(0, Number(args.get('limit') || 0));
const CONFIRM = args.get('confirm') === 'true';   // 默认不代为确认（人工把关）

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const BASE = `http://127.0.0.1:3100`;

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'x-console-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 300) }; }
  if (!res.ok && json.ok !== true) throw new Error(`${pathname} → HTTP ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── 噪声判定 ───────────────────────────────────────────────────────────────
const NOISE_RULES = [
  [/^bv[0-9a-z]{10}$/i, 'BV 号'],
  [/^https?:\/\//i, 'URL'],
  [/^(av|cv|uid)\d+$/i, 'av/cv/uid 号'],
  [/^\d+$/, '纯数字'],
  [/^[\p{P}\p{S}\s]+$/u, '纯符号/表情'],
  [/^(.)\1*$/u, '单字符重复'],
  [/^[\x00-\x7f]{1,2}$/, '超短 ASCII'],
  [/^\d{4,}[-/.]\d{1,2}[-/.]\d{1,2}/, '日期'],
  [/^[0-9a-f]{16,}$/i, '十六进制串'],
  [/^(true|false|null|undefined|nan)$/i, '字面量']
];

function noiseReason(content) {
  const s = String(content || '').trim();
  if (!s) return '空';
  if (s.length > 40) return '过长';
  for (const [re, why] of NOISE_RULES) if (re.test(s)) return why;
  return null;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const { entries } = await api('/api/slang');
const candidates = entries.filter((e) => e.status === 'candidate');
log(`黑话总条目 ${entries.length}，其中候选 ${candidates.length}，已确认 ${entries.filter((e) => e.status === 'confirmed').length}`);

const seen = new Map();
const toDelete = [];
const toResearch = [];
for (const e of candidates) {
  const reason = noiseReason(e.content);
  const key = String(e.content || '').trim().toLowerCase();
  if (reason) { toDelete.push({ ...e, reason }); continue; }
  if (seen.has(key)) { toDelete.push({ ...e, reason: `与「${seen.get(key)}」重复` }); continue; }
  seen.set(key, e.content);
  if (!(e.meaning || '').trim()) toResearch.push(e);
}

log(`\n── 待删除噪声 ${toDelete.length} 条 ──`);
for (const e of toDelete) log(`   ✗ ${JSON.stringify(e.content)}  (${e.reason})`);
log(`\n── 待研究 ${toResearch.length} 条 ──`);
log('   ' + toResearch.map((e) => e.content).join('、'));

if (DRY_RUN) { log('\n[dry-run] 未做任何修改'); process.exit(0); }

if (toDelete.length) {
  const r = await api('/api/slang/batch-delete', { method: 'POST', body: { ids: toDelete.map((e) => e.id) } });
  log(`\n已删除噪声 ${r.removedCount ?? toDelete.length} 条`);
}

const queue = LIMIT ? toResearch.slice(0, LIMIT) : toResearch;
const total = queue.length;
let round = 0;
let promoted = 0;
let noMeaning = [];
const readyToConfirm = [];   // 已出释义、等待人工确认的

for (let i = 0; i < queue.length; i += BATCH) {
  const batch = queue.slice(i, i + BATCH);
  round++;
  log(`\n═══ 第 ${round} 批（${i + 1}~${i + batch.length} / ${total}）：${batch.map((e) => e.content).join('、')}`);
  try {
    const q = await api('/api/slang/research', { method: 'POST', body: { ids: batch.map((e) => e.id) } });
    log(`   已排队研究 ${q.count} 条`);
  } catch (error) {
    log(`   排队失败：${error.message}`);
    continue;
  }

  // 轮询直到本批都拿到释义，或超时。
  const deadline = Date.now() + TIMEOUT_MS;
  const ids = new Set(batch.map((e) => e.id));
  let latest = [];
  while (Date.now() < deadline) {
    await sleep(5000);
    const snap = await api('/api/slang');
    latest = snap.entries.filter((e) => ids.has(e.id));
    const done = latest.filter((e) => (e.meaning || '').trim());
    process.stdout.write(`\r   进度 ${done.length}/${batch.length} 已出释义   `);
    if (done.length === batch.length) break;
  }
  process.stdout.write('\n');

  const got = latest.filter((e) => (e.meaning || '').trim());
  const miss = latest.filter((e) => !(e.meaning || '').trim());
  // 兜底：bridge 若未开自动转正，这里补一次确认，避免“研究了却查不到”。
  // 默认只研究、不确认——与「关掉自动转正、人工把关」的策略一致。
  // 显式传 --confirm 才代为确认（脚本本身就是管理员主动跑的工具）。
  const stillCandidate = got.filter((e) => e.status === 'candidate');
  if (stillCandidate.length) {
    if (CONFIRM) {
      try {
        const c = await api('/api/slang/batch-confirm', { method: 'POST', body: { ids: stillCandidate.map((e) => e.id) } });
        log(`   代为确认 ${c.confirmedCount ?? 0} 条（--confirm）`);
      } catch (error) {
        log(`   确认失败：${error.message}`);
      }
    } else {
      readyToConfirm.push(...stillCandidate.map((e) => e.content));
    }
  }
  promoted += got.length;
  noMeaning.push(...miss.map((e) => e.content));
  log(`   本批出释义 ${got.length} 条${miss.length ? `，未出释义：${miss.map((e) => e.content).join('、')}` : ''}`);
}

const finalSnap = await api('/api/slang');
const mine = finalSnap.entries.filter((e) => queue.some((q) => q.id === e.id));
log(`\n══════ 完成 ══════`);
log(`处理 ${total} 条：出释义 ${promoted} 条，未出释义 ${noMeaning.length} 条`);
log(`最终状态：confirmed ${mine.filter((e) => e.status === 'confirmed').length} / candidate ${mine.filter((e) => e.status === 'candidate').length}`);
const all = finalSnap.entries;
log(`全库：confirmed ${all.filter((e) => e.status === 'confirmed').length}，candidate ${all.filter((e) => e.status === 'candidate').length}，总计 ${all.length}`);
if (readyToConfirm.length) {
  log(`\n已出释义、等待人工确认（控制台 08 面板点「批量确认（有含义）」，或重跑时加 --confirm）：`);
  log('  ' + readyToConfirm.join('、'));
}
if (noMeaning.length) log(`仍未出释义（可择日重试）：${noMeaning.join('、')}`);
