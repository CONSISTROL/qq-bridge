// 豆包网页版通道（桥接侧）—— 管 worker 进程的生命周期与 JSON 行 RPC。
//
// 设计取舍：
// - **worker 单独进程**：Chrome 吃内存，本机可用内存很小。用 systemd-run 把它关进自己的
//   cgroup（MemoryMax），真 OOM 了只死它，bridge / DSH / QQ 都不受牵连。跑在 bridge 里就没这层保护。
// - **懒启动 + 空闲自杀**：只有真要问的时候才起浏览器；问完闲置 N 分钟就关掉，
//   不常驻（和 src/browser-render.js 同一个思路）。
// - **一次只跑一条**：worker 内部就是串行的；这里再加一道，避免并发打爆内存。
// - **坏掉要能看出来**：任何失败都记 lastError + 置 available=false，让调用方降级回 B站/Bing，
//   绝不让「通道坏了」表现成「这个梗查不到」。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** systemd-run 在不在（不在就退化成普通 spawn，只是没有内存硬限）。 */
function hasSystemdRun() {
  for (const p of ['/usr/bin/systemd-run', '/bin/systemd-run']) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 继续找 */ }
  }
  return '';
}

export function createDoubaoChannel({ log = () => {}, config = {} } = {}) {
  const cfg = config;
  const workerScript = path.join(ROOT, 'src', 'doubao-worker.js');
  const profileDir = String(cfg.profileDir || path.join(ROOT, 'state', 'doubao-profile'));
  const memoryMax = String(cfg.memoryMax || '900M');
  const memorySwapMax = String(cfg.memorySwapMax || '1500M');
  const idleCloseMs = Math.max(30000, Number(cfg.idleCloseMs) || 5 * 60 * 1000);
  const defaultTimeoutMs = Math.max(5000, Number(cfg.timeoutMs) || 90000);

  let child = null;
  let buffer = '';
  let seq = 0;
  const pending = new Map();
  let idleTimer = null;
  let busy = false;
  let unitSeq = 0;

  const state = {
    running: false,
    loggedIn: null,      // null=未知
    lastOkAt: 0,
    lastErrorAt: 0,
    lastError: '',
    lastAskAt: 0,
    lastQrAt: 0,
    asks: 0,
    failures: 0
  };

  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // 有命令在飞的时候别关
      if (pending.size || busy) { touchIdle(); return; }
      log('豆包通道空闲，关闭 worker 释放内存');
      stop('idle');
    }, idleCloseMs);
    idleTimer.unref?.();
  }

  function failAllPending(reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  }

  function handleLine(line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === null || msg.id === undefined) {
      if (msg.ready) log('豆包 worker 就绪');
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === false) {
      const err = new Error(msg.error || '未知错误');
      err.doubao = msg;
      p.reject(err);
      return;
    }
    p.resolve(msg);
  }

  /** 起 worker（已在跑就复用）。 */
  function ensureWorker() {
    if (child && child.exitCode === null) return child;
    if (!fs.existsSync(workerScript)) throw new Error(`找不到 worker：${workerScript}`);
    const node = process.execPath;
    const workerArgs = [workerScript, `--profile=${profileDir}`];
    const sysrun = hasSystemdRun();
    let cmd = node;
    let args = workerArgs;
    if (sysrun) {
      unitSeq += 1;
      cmd = sysrun;
      args = [
        '--scope', '-q', '--collect',
        `-p`, `MemoryMax=${memoryMax}`,
        `-p`, `MemorySwapMax=${memorySwapMax}`,
        `--unit`, `qqbridge-doubao-${process.pid}-${unitSeq}`,
        node, ...workerArgs
      ];
    } else {
      log('警告：没有 systemd-run，豆包 worker 无法限制内存（OOM 可能牵连桥接）');
    }
    child = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    state.running = true;
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const t = line.trim();
        if (t) log(`[worker] ${t}`);
      }
    });
    child.on('exit', (code, signal) => {
      const wasRunning = state.running;
      state.running = false;
      child = null;
      failAllPending(`豆包 worker 退出（code=${code} signal=${signal}）`);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (wasRunning) log(`豆包 worker 退出：code=${code} signal=${signal}`);
    });
    child.on('error', (error) => {
      state.lastError = `worker 启动失败：${error?.message ?? error}`;
      state.lastErrorAt = Date.now();
      log(state.lastError);
      failAllPending(state.lastError);
    });
    touchIdle();
    return child;
  }

  /** 发一条命令并等回执。 */
  function request(cmd, payload = {}, { timeoutMs } = {}) {
    const c = ensureWorker();
    const id = ++seq;
    const wait = Math.max(5000, Number(timeoutMs) || defaultTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const e = new Error(`豆包通道超时（${cmd}，${Math.round(wait / 1000)}s）`);
        e.timeout = true;
        reject(e);
      }, wait);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        c.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  /** 探活：顺带刷新登录态。 */
  async function ping({ timeoutMs = 60000 } = {}) {
    try {
      const r = await request('ping', {}, { timeoutMs });
      state.loggedIn = !!r.loggedIn;
      state.lastOkAt = Date.now();
      state.lastError = '';
      return { ok: true, loggedIn: state.loggedIn, hasEditor: !!r.hasEditor, url: r.url || '' };
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      state.lastErrorAt = Date.now();
      state.failures += 1;
      return { ok: false, error: state.lastError, needLogin: false };
    }
  }

  /**
   * 问一句。未登录会抛 need_login（由调用方决定是提示登录还是直接降级）。
   */
  async function ask(prompt, { timeoutMs = defaultTimeoutMs } = {}) {
    busy = true;
    try {
      const r = await request('ask', { prompt, timeoutMs }, { timeoutMs: timeoutMs + 20000 });
      state.asks += 1;
      state.lastAskAt = Date.now();
      state.lastOkAt = Date.now();
      state.loggedIn = true;
      state.lastError = '';
      return { ok: true, answer: String(r.answer || '') };
    } catch (error) {
      const msg = String(error?.message ?? error);
      const needLogin = /need_login/.test(msg) || /未登录/.test(msg);
      state.lastError = msg;
      state.lastErrorAt = Date.now();
      state.failures += 1;
      if (needLogin) state.loggedIn = false;
      return { ok: false, error: msg, needLogin };
    } finally {
      busy = false;
      touchIdle();
    }
  }

  /** 打开登录框，拿二维码（base64 PNG）。 */
  async function startLogin({ timeoutMs = 60000 } = {}) {
    try {
      const r = await request('login', { timeoutMs }, { timeoutMs: timeoutMs + 20000 });
      if (r.alreadyLoggedIn) {
        state.loggedIn = true;
        return { ok: true, alreadyLoggedIn: true };
      }
      state.lastQrAt = Date.now();
      return { ok: true, qr: r.qr, size: r.size || 0 };
    } catch (error) {
      const msg = String(error?.message ?? error);
      state.lastError = msg;
      state.lastErrorAt = Date.now();
      return { ok: false, error: msg };
    }
  }

  /** 等用户扫码完成。 */
  async function waitLogin({ timeoutMs = 180000 } = {}) {
    try {
      const r = await request('login-wait', { timeoutMs }, { timeoutMs: timeoutMs + 20000 });
      state.loggedIn = !!r.loggedIn;
      if (state.loggedIn) state.lastOkAt = Date.now();
      return { ok: true, loggedIn: !!r.loggedIn };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), loggedIn: false };
    }
  }

  function stop(reason = 'manual') {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const c = child;
    child = null;
    state.running = false;
    if (!c) return;
    try { c.stdin.write(JSON.stringify({ id: ++seq, cmd: 'close' }) + '\n'); } catch { /* 可能已经死了 */ }
    // 给它 3 秒自己优雅退出，然后强杀：Chrome 可能挂着子进程
    const killer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000);
    killer.unref?.();
    log(`豆包通道停止（${reason}）`);
  }

  function status() {
    let profileBytes = 0;
    try {
      const walk = (dir) => {
        let total = 0;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) total += walk(p);
          else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
        }
        return total;
      };
      profileBytes = walk(profileDir);
    } catch { /* 还没建 */ }
    return {
      ...state,
      busy,
      pending: pending.size,
      profileDir,
      profileBytes,
      memoryMax,
      idleCloseMs,
      systemdRun: Boolean(hasSystemdRun())
    };
  }

  function available() {
    return Boolean(cfg.enabled !== false && fs.existsSync(workerScript));
  }

  return { available, status, ping, ask, startLogin, waitLogin, stop, request, ensureWorker };
}
