// 本地 embedding 服务的客户端：起子进程、发请求、超时、崩了自动重启。
//
// 设计原则是「永远不能拖慢或拖垮 bridge」：
//   * 每次请求都有超时，超时即失败，由调用方降级（黑话注入退回按频次选词）；
//   * 子进程崩了只影响向量检索，bridge 不受影响；连续失败会退避重试，不再疯狂重启；
//   * 不做任何联网——模型只从本地 models/ 读。
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMBEDDER = path.join(ROOT, 'src', 'embedder.js');

export class EmbeddingClient {
  /**
   * @param {object} opts
   * @param {number} [opts.timeoutMs]   单次请求超时（默认 1500ms；常驻时实测 7ms）
   * @param {number} [opts.startTimeoutMs] 启动+加载模型超时（默认 30000ms）
   * @param {number} [opts.maxRestarts] 连续失败多少次后放弃自动重启（默认 5）
   * @param {string} [opts.spawnPrefix] 启动前缀，例如
   *   "systemd-run --scope -p MemoryMax=320M -p MemorySwapMax=0 --quiet"
   *   用来给 embedder 套 cgroup 内存闸门：超了只死它自己，不会把整机推进 swap。
   *   注意必须带 --quiet，否则 systemd-run 会往 stdout 打一行，污染 stdio JSON 协议。
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor(opts = {}) {
    this.timeoutMs = Number(opts.timeoutMs) || 1500;
    this.startTimeoutMs = Number(opts.startTimeoutMs) || 30000;
    this.maxRestarts = Number(opts.maxRestarts) || 5;
    this.spawnPrefix = String(opts.spawnPrefix ?? process.env.EMBED_SPAWN_PREFIX ?? '').trim();
    this.log = opts.log || (() => {});
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.readyInfo = null;
    this.stderrTail = [];
    this.startPromise = null;
    this.failures = 0;
    this.lastError = '';
    this.restartTimer = null;
    this.stopped = false;
    this.stats = { requests: 0, texts: 0, totalMs: 0, lastMs: 0, timeouts: 0, errors: 0 };
  }

  get ready() { return !!(this.child && this.readyInfo); }

  /** 最近一次就绪信息（含模型、维度、内存占用） */
  get info() { return this.readyInfo; }

  /** 启动子进程并等它自报 ready。重复调用复用同一个 promise。 */
  start() {
    if (this.ready) return Promise.resolve(this.readyInfo);
    if (this.startPromise) return this.startPromise;
    if (this.stopped) return Promise.reject(new Error('embedding 客户端已停止'));
    this.startPromise = new Promise((resolve, reject) => {
      const prefix = this.spawnPrefix;
      const argv = prefix ? [...prefix.split(/\s+/), process.execPath, EMBEDDER] : [EMBEDDER];
      const cmd = prefix ? argv.shift() : process.execPath;
      let child;
      try {
        child = spawn(cmd, argv, {
          cwd: ROOT,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env
        });
      } catch (error) {
        this.startPromise = null;
        reject(error);
        return;
      }
      this.child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.lastError = `启动超时（${this.startTimeoutMs}ms）`;
        this.log(`[embed] ${this.lastError}`);
        try { child.kill(); } catch {}
        this.startPromise = null;
        reject(new Error(this.lastError));
      }, this.startTimeoutMs);
      timer.unref?.();

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        let msg;
        try { msg = JSON.parse(text); } catch {
          this.log(`[embed] 子进程输出无法解析（已忽略）：${text.slice(0, 200)}`);
          return;
        }
        if (msg.ready === true) {
          this.readyInfo = msg;
          this.failures = 0;
          this.startPromise = null;
          this.log(`[embed] 就绪 model=${msg.model} dim=${msg.dim} 加载=${msg.loadMs}ms `
            + `批=${msg.batch} 截断=${msg.maxTokens} 常驻=${msg.mem?.rssMB}MB 峰值=${msg.mem?.peakMB}MB`);
          clearTimeout(timer);
          settled = true;
          resolve(msg);
          return;
        }
        if (msg.ready === false) {
          this.lastError = msg.error || '子进程报告启动失败';
          this.log(`[embed] ${this.lastError}${msg.hint ? `（${msg.hint}）` : ''}`);
          clearTimeout(timer);
          settled = true;
          this.startPromise = null;
          try { child.kill(); } catch {}
          reject(new Error(this.lastError));
          return;
        }
        this.#onResponse(msg);
      });

      child.stderr.on('data', (buf) => {
        const text = String(buf);
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          this.stderrTail.push(line.slice(0, 300));
          if (this.stderrTail.length > 40) this.stderrTail.shift();
        }
      });

      child.on('error', (error) => {
        this.lastError = `spawn 失败：${error?.message ?? error}`;
        this.log(`[embed] ${this.lastError}`);
        if (!settled) { settled = true; clearTimeout(timer); this.startPromise = null; reject(error); }
      });

      child.on('exit', (code, signal) => {
        const wasReady = !!this.readyInfo;
        this.child = null;
        this.readyInfo = null;
        this.startPromise = null;
        for (const [, item] of this.pending) {
          clearTimeout(item.timer);
          item.reject(new Error('embedding 子进程已退出'));
        }
        this.pending.clear();
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`子进程退出 code=${code}`)); }
        if (this.stopped) return;
        if (wasReady) this.log(`[embed] 子进程退出（code=${code} signal=${signal}）`);
        this.#scheduleRestart();
      });
    });
    return this.startPromise;
  }

  #scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    this.failures++;
    if (this.failures > this.maxRestarts) {
      this.log(`[embed] 连续失败 ${this.failures} 次，停止自动重启；向量检索已降级为按频次选词`);
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** (this.failures - 1));
    this.log(`[embed] ${delay}ms 后尝试第 ${this.failures} 次重启`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch(() => { /* 失败会在 exit 里再排重试 */ });
    }, delay);
    this.restartTimer.unref?.();
  }

  #onResponse(msg) {
    const item = this.pending.get(msg.id);
    if (!item) return;
    this.pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.error) { this.stats.errors++; item.reject(new Error(msg.error)); return; }
    item.resolve(msg);
  }

  /**
   * 编码一批文本。失败/超时一律抛错，由调用方决定降级策略。
   * @returns {Promise<number[][]>}
   */
  async embed(texts, { timeoutMs } = {}) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (!list.length) return [];
    if (!this.ready) await this.start();
    if (!this.child) throw new Error('embedding 子进程不可用');
    const id = this.nextId++;
    const budget = Number(timeoutMs) || this.timeoutMs;
    const started = Date.now();
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts++;
        reject(new Error(`embedding 超时（${budget}ms）`));
      }, budget);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, op: 'embed', texts: list })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    const ms = Date.now() - started;
    this.stats.requests++;
    this.stats.texts += list.length;
    this.stats.totalMs += ms;
    this.stats.lastMs = ms;
    if (msg.mem) this.readyInfo = { ...this.readyInfo, mem: msg.mem };
    return msg.vectors || [];
  }

  /** 查子进程状态（含内存），失败返回 null */
  async probe(timeoutMs = 2000) {
    if (!this.ready) await this.start();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: () => { clearTimeout(timer); resolve(null); },
        timer
      });
      try { this.child.stdin.write(`${JSON.stringify({ id, op: 'stats' })}\n`); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    try { this.child?.kill(); } catch {}
    this.child = null;
    this.readyInfo = null;
  }
}
