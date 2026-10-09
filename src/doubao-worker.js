#!/usr/bin/env node
// 豆包网页版 worker —— 独立进程，用 stdin/stdout 的 JSON 行协议被桥接驱动。
//
// 为什么要单独一个进程（而不是长在 bridge 里）：
//   1. **内存**。本机内存很紧（1.6GB 总、长期只剩一两百 MB 可用）。Chrome 一开就是几百 MB，
//      必须能用 cgroup（systemd-run -p MemoryMax=）把它单独关起来：真 OOM 了只死这个 worker，
//      bridge / DSH / QQ 都不受牵连。跑在 bridge 进程内就没有这层隔离。
//   2. **可重启**。网页改版、掉登录、DOM 漂移，都是「杀掉重开」比「在线修补」更靠谱。
//   3. **桥接不阻塞**。问答是慢操作（十几秒），worker 进程崩了只是这条通道降级。
//
// 协议：每行一个 JSON。
//   请求  {"id":1,"cmd":"ping"}
//   响应  {"id":1,"ok":true,"loggedIn":false,"url":"...","note":"..."}
// 命令：
//   ping            探活 + 登录态
//   login           打开登录框，截二维码返回（base64 PNG），等用户扫
//   ask   {prompt}  发一句话，等回答稳定后返回 answer
//   close           关掉浏览器并退出
//
// 登录态存在 --user-data-dir 里（默认 state/doubao-profile），扫一次能撑很久。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HOME_URL = 'https://www.doubao.com/chat/';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Chrome 的启动参数：全部是为了「少占内存、别崩」。 */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-translate',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  // 持久 profile 会继承上次没关干净的标签页（实测跑几轮后开了 12 个 about:blank 僵尸页，
  // 全是 detached frame，页面读取一直报错）。这两条 + 启动时清标签一起治它。
  '--no-restore-session-state',
  '--disable-session-crashed-bubble',
  '--js-flags=--max-old-space-size=192',
  '--renderer-process-limit=1',
  '--window-size=1280,900'
];

/** 命令行参数解析：--profile=/x --headless=0 --timeout=60000 */
function parseArgs(argv) {
  const out = { profile: path.join(ROOT, 'state', 'doubao-profile'), headless: true, navTimeoutMs: 45000 };
  for (const raw of argv) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'profile') out.profile = v;
    else if (k === 'headless') out.headless = v !== '0' && v !== 'false';
    else if (k === 'navTimeout') out.navTimeoutMs = Math.max(5000, Number(v) || out.navTimeoutMs);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

let puppeteerMod;
let browser = null;
let page = null;
let busy = false;

function log(...args) {
  process.stderr.write(`[doubao-worker] ${args.join(' ')}\n`);
}

async function loadPuppeteer() {
  if (puppeteerMod !== undefined) return puppeteerMod;
  try {
    puppeteerMod = (await import('puppeteer')).default;
  } catch {
    puppeteerMod = false;
  }
  return puppeteerMod;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个条件成立；返回是否等到。 */
async function waitFor(fn, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch { /* 页面还在导航等情况，继续等 */ }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 打开（或复用）浏览器与页面。
 * 编辑器不是马上就在的——实测有时要 5~15 秒才挂上，所以这里必须轮询等，
 * 不能写完 goto 就直接找元素（之前的探针就是栽在这一步）。
 */
async function ensurePage() {
  if (browser && browser.connected && page && !page.isClosed()) return page;
  const p = await loadPuppeteer();
  if (!p) throw new Error('无头浏览器不可用：缺少 puppeteer 或 Chromium 二进制');
  fs.mkdirSync(opts.profile, { recursive: true });
  browser = await p.launch({
    headless: opts.headless,
    userDataDir: opts.profile, // 登录态靠它持久化；扫一次码能用很久
    args: LAUNCH_ARGS,
    protocolTimeout: 120000
  });
  // 只留一个干净标签：继承来的僵尸标签会让 page.evaluate 一直撞 detached frame。
  for (const old of await browser.pages()) {
    try { await old.close(); } catch { /* 已经关掉的忽略 */ }
  }
  page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs });
  const ready = await waitFor(() => hasEditor(), { timeoutMs: 30000, intervalMs: 800 });
  if (!ready) log('警告：页面加载后 30 秒内没等到输入框（可能被反爬拦了）');
  await dismissOverlays();
  return page;
}

/**
 * 关掉挡路的浮层。
 * 豆包首屏会弹一个「下载电脑版领 30 天订阅」的推广弹窗，正好盖住右上角的登录按钮——
 * 不先关掉它，点「登录」永远点不到真的按钮（实测踩过：点完什么都没发生）。
 */
async function dismissOverlays() {
  try {
    await page.keyboard.press('Escape');
    await sleep(600);
    const n = await page.evaluate(() => {
      let hit = 0;
      document.querySelectorAll('button, [role="button"], div, span').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < 64 && r.height > 0 && r.height < 64) {
          const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
          if (/^(关闭|close|×|✕|✖)$/i.test(label)) { try { el.click(); hit += 1; } catch { /* 忽略 */ } }
        }
      });
      return hit;
    });
    if (n) log(`关掉了 ${n} 个浮层`);
    await sleep(600);
  } catch { /* 没浮层就算了 */ }
}

/** 找右上角的「登录」按钮（取最靠右的可见候选，避免选中侧栏里的同名文字）。 */
async function findLoginButton() {
  return page.evaluate(() => {
    const list = [];
    document.querySelectorAll('button, a, div, span').forEach((el) => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      if (t === '登录' && r.width > 0 && r.height > 0 && r.height < 80) {
        list.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
    });
    list.sort((a, b) => b.x - a.x);
    return list[0] ?? null;
  });
}

/**
 * 找登录二维码。
 * 实测它既不是 canvas 也不是 data: 图片，而是一个 **162×162 的 `<svg>`**，
 * 正下方有一行「打开 豆包 / 飞书 App 扫码登录」。所以按「最大的方形 svg/canvas/img」找，
 * 并且优先选位于「扫码登录」文字上方的那一个。
 */
async function findQrBox() {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('svg, canvas, img')];
    const label = [...document.querySelectorAll('*')]
      .find((e) => /扫码登录/.test((e.innerText || '').trim()) && e.children.length === 0);
    const labelRect = label ? label.getBoundingClientRect() : null;
    const cands = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 110 || r.height < 110) continue;
      const ar = r.width / r.height;
      if (ar < 0.8 || ar > 1.25) continue; // 只要接近正方形
      const above = labelRect ? (r.bottom <= labelRect.top + 8) : false;
      cands.push({ x: r.x, y: r.y, w: r.width, h: r.height, above });
    }
    // 优先「在扫码登录文字上方」，其次取最大的
    cands.sort((a, b) => (Number(b.above) - Number(a.above)) || (b.w * b.h - a.w * a.h));
    return cands[0] ?? null;
  });
}

/** 输入框在不在。豆包用的是 tiptap/ProseMirror 的 contenteditable。 */
function hasEditor() {
  return page.evaluate(() => !!document.querySelector('[contenteditable="true"], textarea'));
}

/** 登录态判定：出现「登录」按钮 = 未登录；否则看是否有头像/账号入口。 */
async function readLoginState() {
  return page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    // 未登录时右上角固定有个「登录」按钮；已登录会换成头像。
    const loginBtn = [...document.querySelectorAll('button, div, span')]
      .some((el) => (el.innerText || '').trim() === '登录' && el.getBoundingClientRect().width > 0);
    const hasEditor = !!document.querySelector('[contenteditable="true"], textarea');
    return { loginBtn, hasEditor, textLen: txt.length };
  });
}

/** 把消息打进输入框。实测 focus + 真实按键最稳（也最像真人）。 */
async function typeIntoEditor(text) {
  const sel = '[contenteditable="true"], textarea';
  const el = await page.$(sel);
  if (!el) throw new Error('找不到输入框');
  await el.focus();
  await page.keyboard.type(text, { delay: 25 });
  const wrote = await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return '';
    return e.tagName === 'TEXTAREA' ? e.value : e.innerText;
  }, sel);
  if (!String(wrote || '').trim()) {
    // 兜底：execCommand 派发真实的 beforeinput/input 事件，ProseMirror 认这个
    await page.evaluate((s, t) => {
      const e = document.querySelector(s);
      e.focus();
      document.execCommand('insertText', false, t);
    }, sel, text);
  }
  return true;
}

/**
 * 从「发送前的整页文本」和「发送后的整页文本」做差集，得到回答。
 * 为什么不靠具体 class：豆包的 DOM 每次加载都不一样（实测同一个 URL 两次加载结构都不同），
 * 选择器写得再准也会漂；内文差集只依赖「页面上多了什么字」这一件事。
 */
function extractDelta(before, after, prompt) {
  const normLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lines = (s) => normLine(s).split(/\n/).map(normLine).filter(Boolean);
  const beforeSet = new Set(lines(before));
  const echo = normLine(prompt);
  const out = [];
  for (const line of lines(after)) {
    if (echo && line === echo) continue;          // 自己的提问会被回显
    if (beforeSet.has(line)) continue;            // 发送前就有的：侧栏、推荐、历史消息
    if (line.length <= 2) continue;               // 单字/符号的界面噪声
    out.push(line);
  }
  // 同一段可能被拆成多行重复出现（流式渲染的残留），去重但保序
  return [...new Set(out)].join('\n').trim();
}

/**
 * 发送。默认回车；若回车后页面没长东西，再退回点「发送」按钮
 * （豆包有「回车换行 / 回车发送」两种偏好设置，不能只赌回车）。
 */
async function sendPrompt(prompt) {
  await typeIntoEditor(prompt);
  await page.keyboard.press('Enter');
  const grew = await waitFor(async () => (await bodyText()).length > baselineLen, { timeoutMs: 4000, intervalMs: 400 });
  if (grew) return;
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, [role="button"]')]
      .find((b) => {
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
        return /发送|send/i.test(label);
      });
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) log('回车没发出去，也没找到发送按钮');
  else log('回车没发出去，已改用发送按钮');
}

let baselineLen = 0;

async function bodyText() {
  return page.evaluate(() => (document.body ? document.body.innerText : ''));
}

/**
 * 发一句话并等回答。
 * 完成判据：页面文本不再增长且持续 quietMs（默认 2.5s）——流式输出停下来就是答完了。
 */
async function ask(prompt, { timeoutMs = 90000, quietMs = 2500 } = {}) {
  const before = await bodyText();
  baselineLen = before.length;
  await sendPrompt(prompt);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stableSince = 0;
  for (;;) {
    await sleep(1000);
    const now = await bodyText();
    if (now !== last) { last = now; stableSince = Date.now(); }
    const grew = now.length > before.length;
    if (grew && stableSince && Date.now() - stableSince >= quietMs) break;
    if (Date.now() > deadline) break;
  }
  const after = await bodyText();
  const answer = extractDelta(before, after, prompt);
  const state = await readLoginState();
  return { answer, loggedIn: !state.loginBtn, raw: after.length };
}

/** 打开登录框并截二维码。 */
async function startLogin({ timeoutMs = 40000 } = {}) {
  await dismissOverlays();
  const st = await readLoginState();
  if (!st.loginBtn) return { alreadyLoggedIn: true };
  const btn = await findLoginButton();
  if (!btn) throw new Error('找不到「登录」按钮（页面结构可能已改版）');
  // 用坐标点击而不是 el.click()：登录按钮可能被浮层部分遮挡，element.click() 会静默失效。
  await page.mouse.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  const ok = await waitFor(async () => (await findQrBox()) !== null, { timeoutMs, intervalMs: 1000 });
  if (!ok) throw new Error('点了登录但没等到二维码（可能需要短信/其他登录方式）');
  const qr = await findQrBox();
  if (!qr) throw new Error('二维码元素定位失败');
  const png = await page.screenshot({
    clip: { x: Math.max(0, qr.x), y: Math.max(0, qr.y), width: qr.w, height: qr.h },
    encoding: 'base64'
  });
  return { qr: png, size: Math.round(qr.w) };
}

/** 二维码还在不在（用来判断是否已扫码登录成功）。 */
async function qrStillThere() {
  return (await findQrBox()) !== null;
}

async function closeBrowser() {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  browser = null;
  page = null;
}

/** 处理一条命令。 */
async function handle(req) {
  const cmd = String(req?.cmd || '');
  if (cmd === 'ping') {
    await ensurePage();
    const st = await readLoginState();
    return { ok: true, loggedIn: !st.loginBtn, hasEditor: st.hasEditor, url: page.url() };
  }
  if (cmd === 'login') {
    await ensurePage();
    const r = await startLogin({ timeoutMs: Number(req.timeoutMs) || 40000 });
    return { ok: true, ...r };
  }
  if (cmd === 'login-wait') {
    // 用户扫码后二维码会消失、页面切成已登录态。轮询它，控制台就能显示「等待扫码」→「已登录」。
    await ensurePage();
    const timeoutMs = Math.max(5000, Number(req.timeoutMs) || 180000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await readLoginState();
      if (!st.loginBtn) return { ok: true, loggedIn: true };
      if (!(await qrStillThere())) {
        // 二维码没了但还没出现头像：可能正在跳转，给它一点时间
        await sleep(2000);
        const st2 = await readLoginState();
        if (!st2.loginBtn) return { ok: true, loggedIn: true };
      }
      if (Date.now() > deadline) return { ok: true, loggedIn: false, error: 'login_timeout' };
      await sleep(2000);
    }
  }
  if (cmd === 'login-check') {
    await ensurePage();
    const st = await readLoginState();
    return { ok: true, loggedIn: !st.loginBtn };
  }
  if (cmd === 'ask') {
    const prompt = String(req.prompt || '').trim();
    if (!prompt) return { ok: false, error: 'prompt 不能为空' };
    await ensurePage();
    const st = await readLoginState();
    if (st.loginBtn) return { ok: false, error: 'need_login', note: '豆包未登录，请先在控制台扫码登录' };
    const r = await ask(prompt, { timeoutMs: Number(req.timeoutMs) || 90000 });
    if (!r.answer) return { ok: false, error: 'empty_answer', note: '等了很久没等到回答（可能触发风控或结构改版）' };
    return { ok: true, answer: r.answer };
  }
  if (cmd === 'close') {
    await closeBrowser();
    return { ok: true, closing: true };
  }
  return { ok: false, error: `未知命令：${cmd}` };
}

// ── stdio 主循环：一次只处理一条，串行 ────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
const queue = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const line = queue.shift();
    let req = null;
    try { req = JSON.parse(line); } catch { continue; }
    let res;
    try {
      res = await handle(req);
    } catch (error) {
      res = { ok: false, error: String(error?.message ?? error) };
    }
    process.stdout.write(JSON.stringify({ id: req?.id ?? null, ...res }) + '\n');
    if (res.closing) { running = false; await closeBrowser(); process.exit(0); }
  }
  running = false;
}

rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  queue.push(t);
  pump();
});
// 注意：stdin 结束不等于「活干完了」。从文件喂输入时 'close' 会立刻触发，
// 如果这时直接 exit，正在跑的命令（比如 ask）就被腰斩、父进程永远等不到回执。
// 所以这里必须等队列排空再退。
rl.on('close', async () => {
  while (running || queue.length) await sleep(50);
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
process.on('uncaughtException', (e) => { log('未捕获异常:', e?.message ?? e); });
process.on('unhandledRejection', (e) => { log('未处理的 Promise 拒绝:', e?.message ?? e); });

log(`启动：profile=${opts.profile} headless=${opts.headless}`);
process.stdout.write(JSON.stringify({ id: null, ready: true }) + '\n');
