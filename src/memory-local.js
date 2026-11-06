// 本地 Qwen 向量 + 重排服务客户端（stdio JSON lines，进程常驻）。
// 模型：/root/mem-models/Qwen3-Embedding-0.6B（GPU fp16）+ Qwen3-Reranker-0.6B（默认 CPU，省显存给 RVC）。
import { spawn } from 'node:child_process';

const PY = process.env.MEM_PY || '/root/memvenv/bin/python';
const SCRIPT = process.env.MEM_SCRIPT || '/root/mem-svc/serve.py';

let child = null;
let seq = 0;
const pending = new Map();
let ready = false;
let starting = null;

function start({ timeoutMs = 300000 } = {}) {
  if (child && ready) return Promise.resolve(true);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    child = spawn(PY, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let buf = '';
    const timer = setTimeout(() => { reject(new Error('本地记忆服务启动超时')); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += String(d);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) { ready = true; clearTimeout(timer); resolve(true); continue; }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg); }
      }
    });
    child.stderr.on('data', () => { /* 只用于排错，不打扰日志 */ });
    child.on('exit', () => { ready = false; child = null; starting = null; for (const p of pending.values()) p.reject(new Error('本地记忆服务退出')); pending.clear(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  }).finally(() => { starting = null; });
  return starting;
}

function call(payload, { timeoutMs = 120000 } = {}) {
  return new Promise(async (resolve, reject) => {
    try { await start(); } catch (e) { reject(e); return; }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('本地记忆服务超时')); } }, timeoutMs);
  });
}

export const localMemory = {
  get ready() { return ready; },
  start,
  async embed(texts, opts) { const r = await call({ op: 'embed', texts }, opts); return r.vectors; },
  async rerank(query, documents, topN = 3, opts) { const r = await call({ op: 'rerank', query, documents, topN }, opts); return r.results; },
  async stats() { return call({ op: 'stats' }, { timeoutMs: 15000 }); },
  stop() { try { child?.kill('SIGTERM'); } catch { /* 忽略 */ } child = null; ready = false; }
};
