#!/usr/bin/env node
// 本地 embedding 服务（长驻子进程，stdio + 换行分隔 JSON 协议）。
//
// 为什么单独起一个进程、而不是塞进 bridge：
//   1. 内存隔离——ONNX Runtime 常驻约 176MB（实测），单独进程才能用 cgroup 给它套硬限额，
//      万一有突发也只杀它自己，不会把整台机器推进 swap；
//   2. 崩溃隔离——模型加载失败或 OOM 只影响检索，bridge 照常跑（调用方降级为按频次选词）；
//   3. 依赖隔离——@xenova/transformers 属于 optionalDependencies，缺了也不影响主程序启动。
//
// 协议（每行一个 JSON）：
//   请求  {"id":1,"op":"embed","texts":["..."]}
//   响应  {"id":1,"vectors":[[...]]} / {"id":1,"error":"..."}
//   请求  {"id":2,"op":"stats"}  → {"id":2,"dim":512,"mem":{...}}
//   请求  {"id":3,"op":"ping"}   → {"id":3,"ok":true}
// 启动完成后先输出一行 {"ready":true,...}，调用方据此判断可用。
//
// 实测出来的两条硬约束（详见 docs）：
//   * 批量必须小：一次性丢 104 条会在注意力张量上被 OOM 杀掉（>250MB），8 条一批峰值 227MB；
//   * 序列要截断：默认 512 tokens 会显著抬高峰值，256 够用。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// stdout 是协议通道，任何库的 console 输出都必须改道，否则会污染 JSON 行。
for (const k of ['log', 'info', 'warn', 'debug']) {
  console[k] = (...args) => console.error('[embedder]', ...args);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = process.env.EMBED_MODEL || 'Xenova/bge-small-zh-v1.5';
const BATCH = Math.max(1, Math.min(32, Number(process.env.EMBED_BATCH) || 8));
const MAX_TOKENS = Math.max(32, Math.min(512, Number(process.env.EMBED_MAX_TOKENS) || 256));

function mem() {
  try {
    const s = fs.readFileSync('/proc/self/status', 'utf8');
    const g = (k) => Number((s.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    return { rssMB: +(g('VmRSS') / 1024).toFixed(1), peakMB: +(g('VmHWM') / 1024).toFixed(1) };
  } catch { return { rssMB: 0, peakMB: 0 }; }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// ── 加载模型 ──────────────────────────────────────────────────────────
let extract = null;
let dim = 0;
let loadMs = 0;
try {
  const { pipeline, env } = await import('@xenova/transformers');
  env.localModelPath = path.join(ROOT, 'models');
  env.allowRemoteModels = false;   // 只认本地模型，绝不在回复路径上去联网
  env.allowLocalModels = true;
  const t0 = Date.now();
  extract = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
  loadMs = Date.now() - t0;
} catch (error) {
  send({ ready: false, error: `加载模型失败：${error?.message ?? error}`, hint: '先运行 node scripts/fetch-embed-model.mjs' });
  process.exit(1);
}

// 分批编码。批内取最长序列做 padding，所以批越大峰值越高——这是实测出来的主要风险点。
async function embedRaw(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH).map((t) => String(t ?? '').slice(0, 2000));
    const res = await extract(chunk, {
      pooling: 'cls',       // BGE 用 CLS 池化
      normalize: true,      // 归一化后余弦 = 点积
      padding: true,
      truncation: true,
      max_length: MAX_TOKENS
    });
    out.push(...res.tolist());
    if (!dim) dim = out[0]?.length ?? 0;
  }
  return out;
}

// 预热：把首次推理的惰性初始化开销留在启动阶段，别落到第一条群消息上。
try {
  const warm = await embedRaw(['预热']);
  dim = warm[0]?.length ?? 0;
} catch (error) {
  send({ ready: false, error: `预热失败：${error?.message ?? error}` });
  process.exit(1);
}

send({
  ready: true, model: MODEL_ID, dim, loadMs, batch: BATCH, maxTokens: MAX_TOKENS,
  mem: mem(), pid: process.pid
});

// ── 请求循环 ──────────────────────────────────────────────────────────
let inflight = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch { send({ error: '请求行不是合法 JSON' }); return; }
  const { id, op } = req;
  if (op === 'ping') { send({ id, ok: true }); return; }
  if (op === 'stats') { send({ id, ok: true, model: MODEL_ID, dim, batch: BATCH, maxTokens: MAX_TOKENS, loadMs, inflight, mem: mem() }); return; }
  if (op !== 'embed') { send({ id, error: `未知 op：${op}` }); return; }
  const texts = Array.isArray(req.texts) ? req.texts : [];
  if (!texts.length) { send({ id, vectors: [] }); return; }
  inflight++;
  try {
    const vectors = await embedRaw(texts);
    send({ id, vectors, mem: mem() });
  } catch (error) {
    send({ id, error: `编码失败：${error?.message ?? error}` });
  } finally {
    inflight--;
  }
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
