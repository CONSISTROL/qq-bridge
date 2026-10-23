// 画图（HTML 渲染）：AI 自己写一段 HTML/CSS/SVG，桥接用无头浏览器渲染成 PNG。
//
// 为什么用这个方案：不依赖任何外部出图服务（豆包/ChatGPT 都会撞验证码或限额），
// 只要模型会写 HTML，就能画海报/梗图/图表/示意图/分镜，且完全本地、可复现。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const DISPLAY = process.env.DRAW_DISPLAY || ':44';
let browser = null;

async function ensureBrowser() {
  if (browser && browser.connected) return browser;
  try {
    const { spawn } = await import('node:child_process');
    spawn('sh', ['-c', `pgrep -f "Xvfb ${DISPLAY}" >/dev/null || (Xvfb ${DISPLAY} -screen 0 1400x1200x24 -nolisten tcp >/dev/null 2>&1 &)`], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* 忽略 */ }
  browser = await puppeteer.launch({
    headless: 'new',   // 渲染不需要给人看，headless 更快
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', '--font-render-hinting=none'],
    defaultViewport: { width: 1080, height: 1080 }
  });
  return browser;
}

const CLAMP = (n, def, min, max) => {
  const v = Math.round(Number(n) || 0);
  return v >= min && v <= max ? v : def;
};

/**
 * 把 HTML 渲染成 PNG。
 * @returns {Promise<{ok:true, buffer:Buffer, mime:string, width:number, height:number}|{ok:false,error:string}>}
 */
export async function renderHtmlToImage({ html, width, height, scale = 1, stateDir = './state', waitMs = 700 } = {}) {
  const body = String(html ?? '').trim();
  if (!body) return { ok: false, error: 'html 不能为空' };
  if (body.length > 400 * 1024) return { ok: false, error: 'html 太大（上限 400KB）' };
  const w = CLAMP(width, 1080, 200, 2400);
  const h = CLAMP(height, 1080, 200, 2400);
  const dpr = Math.min(2, Math.max(1, Number(scale) || 1));
  let page;
  try {
    const b = await ensureBrowser();
    page = await b.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
    // 只允许内联内容加载远程图片/字体；页面脚本**禁掉**（避免渲染期跑任意 JS 拖慢/出错）
    await page.setJavaScriptEnabled(false);
    await page.setContent(body, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    // 等图片（远程图/字体）解码完
    await page.evaluate(async () => {
      const imgs = [...document.images];
      await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((res) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      }))));
      if (document.fonts?.ready) await document.fonts.ready;
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5000, Number(waitMs) || 0))));
    const buffer = await page.screenshot({ type: 'png', fullPage: false, clip: { x: 0, y: 0, width: w, height: h } });
    if (!buffer?.length) return { ok: false, error: '渲染出来是空图' };
    return { ok: true, buffer: Buffer.from(buffer), mime: 'image/png', width: w * dpr, height: h * dpr };
  } catch (error) {
    return { ok: false, error: `HTML 渲染失败：${error?.message ?? error}` };
  } finally {
    await page?.close?.().catch(() => {});
  }
}

export async function closeHtmlRenderer() {
  try { await browser?.close?.(); } catch { /* 忽略 */ }
  browser = null;
  return { ok: true };
}
