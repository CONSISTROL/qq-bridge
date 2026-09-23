// 无头浏览器渲染（给 web_render 用）：把前端渲染（SPA）页面渲染成 DOM 后再抽正文。
//
// 为什么单独一个模块：这东西又慢又吃内存，不能长在 web_fetch 的主路径上。
// 本机可用内存只有 ~500MB（embedding 模型常驻 186MB），所以这里的每一条设计
// 都是为了「别把桥接挤 OOM」：
// - **懒启动 + 空闲自动关闭**：渲染完 60s 没人用就关掉浏览器，不留常驻进程；
// - **同一时刻只渲染一个页面**：并发两个 SPA 就是两个 renderer 进程；
// - **可用内存闸门**：低于阈值直接拒绝，宁可这次渲染失败也不拖垮桥接；
// - **禁图/禁字体/禁媒体**：只要正文，图片对文本抽取没用，却能吃掉大部分内存与带宽；
// - **V8 堆上限 + renderer 单进程**：`--js-flags=--max-old-space-size=128`、`--renderer-process-limit=1`；
// - **出网走 src/safe-proxy.js 的过滤代理**：页面里的 JS 碰不到 127.0.0.1 上的控制台/DSH。

import fs from 'node:fs';
import os from 'node:os';
import { startSafeProxy } from './safe-proxy.js';
import { validateFetchUrl } from './safe-fetch.js';
import { extractHtmlText, extractHtmlMeta, extractJsonLd, looksLikeSpaShell, detectAccessHint, MIN_USABLE_TEXT } from './html-text.js';

/** 渲染完多久没人用就关掉浏览器（毫秒）。 */
export const IDLE_CLOSE_MS = 60000;
/** 单页导航硬超时。 */
export const NAV_TIMEOUT_MS = 25000;
/** 网络静默后额外等待（SPA 首屏后常有二次请求）。 */
export const DEFAULT_SETTLE_MS = 1200;
/** 渲染后 DOM 的最大字符数（防止超大 DOM 撑爆内存/上下文）。 */
export const MAX_HTML_CHARS = 3_000_000;
/** 可用内存低于此值直接拒绝渲染。 */
export const MIN_FREE_BYTES = 220 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let proxy = null;
let browserPromise = null;
let idleTimer = null;
let busy = false;
let puppeteerMod; // undefined=未探测 | false=不可用 | module=可用

/** 读 /proc/meminfo 的 MemAvailable（比 os.freemem 更贴近「还能用多少」）。 */
export function availableMemoryBytes() {
  try {
    const m = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch { /* 非 Linux 走 os.freemem */ }
  return os.freemem();
}

/** 探测 puppeteer + Chromium 二进制是否都在。 */
export async function loadPuppeteer() {
  if (puppeteerMod !== undefined) return puppeteerMod;
  try {
    const mod = await import('puppeteer');
    const p = mod?.default ?? mod;
    const exe = typeof p?.executablePath === 'function' ? p.executablePath() : '';
    puppeteerMod = exe && fs.existsSync(exe) ? p : false;
  } catch {
    puppeteerMod = false;
  }
  return puppeteerMod;
}

export async function browserAvailable() {
  return Boolean(await loadPuppeteer());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH_ARGS = [
  '--no-sandbox',                    // 容器内以 root 运行必须
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',         // /dev/shm 往往很小，不关会把 renderer 搞崩
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
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=128',
  '--disk-cache-size=1',
  '--blink-settings=imagesEnabled=false'
];

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void closeBrowser('idle'); }, IDLE_CLOSE_MS);
  idleTimer?.unref?.();
}

/** 关掉浏览器与代理（空闲或显式调用）。 */
export async function closeBrowser(reason = 'manual') {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const pending = browserPromise;
  browserPromise = null;
  try {
    const b = pending ? await pending : null;
    if (b) await b.close();
    if (b) process.stderr.write(`[browser-render] 浏览器已关闭（${reason}）\n`);
  } catch { /* 已经挂了 */ }
  if (proxy) {
    try { await proxy.close(); } catch { /* 忽略 */ }
    proxy = null;
  }
}

async function ensureBrowser(p, allowLocalhostForTest) {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing?.connected) return existing;
    browserPromise = null;
  }
  browserPromise = (async () => {
    if (!proxy) proxy = await startSafeProxy({ allowLocalhostForTest });
    return p.launch({
      headless: true,
      args: [...LAUNCH_ARGS, `--proxy-server=http://127.0.0.1:${proxy.port}`],
      protocolTimeout: 60000
    });
  })();
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

/**
 * 渲染一个页面并抽取正文。
 * @returns {Promise<{url, rendered, text, meta, jsonLd?, renderHint?, htmlLength, elapsedMs}>}
 */
export async function renderPage(url, opts = {}) {
  const p = await loadPuppeteer();
  if (!p) throw new Error('无头浏览器不可用：缺少 puppeteer 或 Chromium 二进制（npm i puppeteer）');
  if (busy) throw new Error('已有渲染任务在进行中；无头浏览器同一时刻只渲染一个页面（内存保护），请稍后再试');
  const allowLocalhostForTest = opts.allowLocalhostForTest === true;
  if (!allowLocalhostForTest) await validateFetchUrl(url);

  const free = availableMemoryBytes();
  if (free < MIN_FREE_BYTES) {
    throw new Error(`可用内存不足（${Math.round(free / 1048576)}MB < ${Math.round(MIN_FREE_BYTES / 1048576)}MB），已拒绝启动无头浏览器以免拖垮桥接`);
  }

  const started = Date.now();
  busy = true;
  let page = null;
  try {
    const browser = await ensureBrowser(p, allowLocalhostForTest);
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });
    // 只要正文：图片/字体/媒体一律不下载（省内存与时间）
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        req.abort().catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    });

    const navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const statusCode = navResponse?.status?.() ?? 0;
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
    await sleep(Math.max(0, Number(opts.settleMs ?? DEFAULT_SETTLE_MS) || 0));

    let html = await page.content();
    if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS);
    const text = extractHtmlText(html, { max: 20000 });
    const meta = extractHtmlMeta(html);
    const jsonLd = extractJsonLd(html);
    const finalUrl = page.url();

    const result = {
      url: finalUrl,
      rendered: true,
      text,
      meta,
      ...(jsonLd ? { jsonLd } : {}),
      htmlLength: html.length,
      elapsedMs: Date.now() - started
    };
    // 反爬/验证页优先：渲染出来仍是滑块/验证页的话，别再让模型以为「多渲染几次就有」
    const accessHint = detectAccessHint({ statusCode: statusCode || 200, text, body: html, url: finalUrl });
    if (accessHint) {
      result.accessHint = accessHint;
    } else {
      // 渲染完还是没有正文：也得说清楚，别让模型以为「渲染一下总有」
      const visible = text.replace(/\s/g, '').length;
      if (looksLikeSpaShell(html) && visible < MIN_USABLE_TEXT) {
        result.renderHint = `即使执行 JS 渲染后正文仍然只有 ${visible} 字：内容可能需要登录/交互，或这条链接本身就没有正文（只有标题/封面）。建议请对方截图或复制正文文字。`;
      }
    }
    return result;
  } finally {
    if (page) { try { await page.close(); } catch { /* 忽略 */ } }
    busy = false;
    scheduleIdleClose();
  }
}
