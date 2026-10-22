// 画图（网页版 ChatGPT）：用真浏览器发一句话，等它出图，再把图截下来。
//
// 为什么不走 API：owner 要求用网页版（免费）。网页版的图由 ChatGPT 自己生成，
// 返回的是带鉴权的 oaiusercontent 链接，直接下载会 401；所以这里用「截元素」的方式
// 拿像素（page.screenshot({clip})），不依赖下载权限。
//
// 需要：一个已登录 chatgpt.com 的 Chrome profile（state/chatgpt-profile）。
// 登录用 scripts/chatgpt-login.mjs（配 noVNC 让主人自己登录）。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const PROFILE = (stateDir) => path.join(stateDir, 'chatgpt-profile');
const LOCKED = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const DISPLAY = process.env.DRAW_DISPLAY || ':42';

let queue = Promise.resolve();

function clearLocks(stateDir) {
  for (const f of LOCKED) { try { fs.rmSync(path.join(PROFILE(stateDir), f), { force: true }); } catch { /* 忽略 */ } }
}

export function chatgptProfileReady(stateDir) {
  try { return fs.existsSync(path.join(PROFILE(stateDir), 'Default', 'Cookies')); } catch { return false; }
}

async function launch(stateDir, headless = false) {
  clearLocks(stateDir);
  return puppeteer.launch({
    headless,
    userDataDir: PROFILE(stateDir),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', '--window-size=1280,1000', '--window-position=0,0', '--start-maximized'],
    defaultViewport: { width: 1280, height: 1000 },
    env: { ...process.env, DISPLAY }
  });
}

/** 交给外部（登录脚本）复用：起一个可见的浏览器并返回 page。 */
export async function openChatgptForLogin({ stateDir } = {}) {
  const browser = await launch(stateDir, false);
  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return { browser, page };
}

/** 生成一张图，返回 { ok, buffer, mime } 或 { ok:false, error }。串行执行，避免抢 profile。 */
export function generateImageChatgpt({ stateDir, prompt, timeoutMs = 180000 } = {}) {
  const run = () => doGenerate({ stateDir, prompt, timeoutMs });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

async function doGenerate({ stateDir, prompt, timeoutMs }) {
  const text = String(prompt ?? '').trim().slice(0, 800);
  if (!text) return { ok: false, error: 'prompt 不能为空' };
  if (!chatgptProfileReady(stateDir)) return { ok: false, error: '还没有登录 ChatGPT（先跑 scripts/chatgpt-login.mjs 登录一次）' };

  let browser;
  try {
    browser = await launch(stateDir, false);
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 未登录会被重定向到 auth；检测一下，别白等
    const needLogin = await page.evaluate(() => /log in|登录/i.test(document.body?.innerText?.slice(0, 2000) || '')).catch(() => false);
    if (needLogin) return { ok: false, error: 'ChatGPT 未登录（需要重新登录）' };

    const baseline = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.src)).catch(() => []);

    const box = await page.evaluateHandle(() => {
      const cands = [...document.querySelectorAll('div[contenteditable="true"], textarea')]
        .filter((e) => e.getBoundingClientRect().width > 200);
      return cands[cands.length - 1];
    });
    const el = box.asElement();
    if (!el) return { ok: false, error: '找不到输入框' };
    await el.click();
    await page.keyboard.type(text, { delay: 20 });
    await page.keyboard.press('Enter');

    const deadline = Date.now() + timeoutMs;
    let handle = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      handle = await page.evaluateHandle((seen) => {
        const imgs = [...document.querySelectorAll('img')]
          .filter((i) => !seen.includes(i.src) && i.naturalWidth >= 256 && i.naturalHeight >= 256);
        return imgs[imgs.length - 1] || null;
      }, baseline).catch(() => null);
      const isEl = handle && await handle.asElement();
      if (isEl) {
        const size = await page.evaluate((node) => ({ w: node.naturalWidth, h: node.naturalHeight }), isEl).catch(() => null);
        if (size && size.w >= 256) break;
      }
      handle = null;
    }
    if (!handle || !(await handle.asElement())) {
      await page.screenshot({ path: path.join(stateDir, 'chatgpt-draw-last.png') }).catch(() => {});
      return { ok: false, error: '等不到出图（可能还在生成/被拦），已留截图 state/chatgpt-draw-last.png' };
    }
    const node = await handle.asElement();
    const buffer = Buffer.from(await node.screenshot({ type: 'png' }));
    if (!buffer.length) return { ok: false, error: '截图取图为空' };
    return { ok: true, buffer, mime: 'image/png', model: 'chatgpt-web', size: 'auto' };
  } catch (error) {
    return { ok: false, error: `ChatGPT 网页出图失败：${error?.message ?? error}` };
  } finally {
    await browser?.close?.().catch(() => {});
  }
}
