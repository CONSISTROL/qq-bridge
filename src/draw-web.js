// 画图（豆包 web 版）：真浏览器跑一遍「切图像生成 → 发一句话 → 等出图 → 取字节」。
//
// 为什么是 web：owner 要求用网页版、且不要兜底（失败就如实报错）。
// 豆包会对自动化浏览器弹语义验证码（"点击最小的绿色金字塔"），所以：
//   · 浏览器会话保持常驻（单例），主人在控制台点一下验证码后，后续请求继续用这个会话；
//   · 撞验证码时返回 { ok:false, captcha:true }，并把画面截图留给控制台。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const DISPLAY = process.env.DRAW_DISPLAY || ':44';
const PROFILE = (stateDir) => path.join(stateDir, 'chrome-profile');   // 沿用之前登录过豆包的 profile
const LOCKED = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const W = 1280;
const H = 1000;

let queue = Promise.resolve();
let browser = null;
let page = null;

function clearLocks(stateDir) {
  for (const f of LOCKED) { try { fs.rmSync(path.join(PROFILE(stateDir), f), { force: true }); } catch { /* 忽略 */ } }
}

/** 打开/复用画图用的浏览器（常驻，主人可以在控制台里点验证码）。 */
export async function openDrawBrowser({ stateDir = './state' } = {}) {
  if (page && !page.isClosed()) return { ok: true, reused: true };
  clearLocks(stateDir);
  try {
    const { spawn } = await import('node:child_process');
    spawn('sh', ['-c', `pgrep -f "Xvfb ${DISPLAY}" >/dev/null || (Xvfb ${DISPLAY} -screen 0 ${W}x${H}x24 -nolisten tcp >/dev/null 2>&1 &)`], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* 忽略 */ }
  browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE(stateDir),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', `--window-size=${W},${H}`, '--window-position=0,0', '--start-maximized'],
    defaultViewport: { width: W, height: H },
    env: { ...process.env, DISPLAY }
  });
  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return { ok: true };
}

export async function drawShot({ stateDir = './state' } = {}) {
  if (!page || page.isClosed()) await openDrawBrowser({ stateDir });
  return page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => null);
}

export async function drawClick({ x, y, stateDir = './state' } = {}) {
  if (!page || page.isClosed()) return { ok: false, error: '浏览器没开' };
  const px = Math.max(0, Math.min(W - 1, Math.round(Number(x) || 0)));
  const py = Math.max(0, Math.min(H - 1, Math.round(Number(y) || 0)));
  await page.mouse.click(px, py);
  return { ok: true };
}

export async function closeDrawBrowser() {
  try { await browser?.close?.(); } catch { /* 忽略 */ }
  browser = null; page = null;
  return { ok: true };
}

async function looksLikeCaptcha(p) {
  return p.evaluate(() => /点击|请选择|拖拽|verify you are human|Click on the/i.test((document.body?.innerText || '').slice(0, 1200))).catch(() => false);
}

export function generateImageWeb({ stateDir = './state', prompt, timeoutMs = 240000 } = {}) {
  const run = () => doGenerate({ stateDir, prompt, timeoutMs });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

async function doGenerate({ stateDir, prompt, timeoutMs }) {
  const text = String(prompt ?? '').trim().slice(0, 800);
  if (!text) return { ok: false, error: 'prompt 不能为空' };
  try {
    await openDrawBrowser({ stateDir });
    // 切到「图像生成」
    await page.waitForSelector('button[data-testid^="skill_bar_button"], [contenteditable="true"]', { timeout: 30000 }).catch(() => {});
    const switched = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button[data-testid^="skill_bar_button"], button')]
        .find((e) => (e.innerText || '').trim() === '图像生成' && e.getBoundingClientRect().width > 0);
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => false);
    if (switched) await new Promise((r) => setTimeout(r, 2500));

    if (await looksLikeCaptcha(page)) {
      await page.screenshot({ path: path.join(stateDir, 'draw-captcha.png') }).catch(() => {});
      return { ok: false, captcha: true, error: '豆包弹了人机验证：请在控制台「设置 → 画图浏览器」里看画面点掉，再重试' };
    }

    const box = await page.evaluateHandle(() => [...document.querySelectorAll('[contenteditable="true"], textarea')]
      .filter((e) => e.getBoundingClientRect().width > 200)[0]);
    const el = box.asElement();
    if (!el) return { ok: false, error: '找不到输入框（豆包可能改版了）' };
    await el.click();
    await page.keyboard.type(text, { delay: 25 });
    await new Promise((r) => setTimeout(r, 600));
    await page.keyboard.press('Enter');

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await looksLikeCaptcha(page)) {
        await page.screenshot({ path: path.join(stateDir, 'draw-captcha.png') }).catch(() => {});
        return { ok: false, captcha: true, error: '豆包弹了人机验证：请在控制台「设置 → 画图浏览器」里点掉后重试' };
      }
      // 取「最新一张 >=512 的图」，并按字节校验（图标只有 1KB 左右）
      const src = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 512 && i.naturalHeight >= 512);
        const last = imgs[imgs.length - 1];
        return last ? (last.currentSrc || last.src || '') : '';
      }).catch(() => '');
      if (!src) continue;
      const b64 = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u); const b = await r.blob();
          if (b.size < 20000) return '';
          return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); });
        } catch { return ''; }
      }, src).catch(() => '');
      if (!b64 || !/^data:image\//.test(b64)) continue;
      const buf = Buffer.from(b64.split(',')[1] || '', 'base64');
      if (buf.length >= 20000) {
        return { ok: true, buffer: buf, mime: /^data:(image\/[a-z+]+);/i.exec(b64)?.[1] || 'image/png', model: 'doubao-web', size: 'auto' };
      }
    }
    await page.screenshot({ path: path.join(stateDir, 'draw-captcha.png') }).catch(() => {});
    return { ok: false, error: '等不到出图（豆包可能还在生成或限流），已留截图 state/draw-captcha.png' };
  } catch (error) {
    return { ok: false, error: `豆包网页出图失败：${error?.message ?? error}` };
  }
}
