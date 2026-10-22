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
// 生成用独立虚拟屏（不在主人 VNC 的 :42 上），避免每画一次就弹一个窗口/标签
const DISPLAY = process.env.DRAW_GEN_DISPLAY || ':44';

let queue = Promise.resolve();
let genBrowser = null;
let genPage = null;

async function ensureGenPage(stateDir) {
  if (genPage && !genPage.isClosed()) return genPage;
  // 确保虚拟屏存在
  try {
    const { spawn } = await import('node:child_process');
    spawn('sh', ['-c', `pgrep -f "Xvfb ${DISPLAY}" >/dev/null || (Xvfb ${DISPLAY} -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &)`], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* 忽略 */ }
  clearLocks(stateDir);
  genBrowser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE(stateDir),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', '--window-size=1280,1000',
      `--proxy-server=${process.env.DRAW_PROXY || 'http://127.0.0.1:7897'}`],
    defaultViewport: { width: 1280, height: 1000 },
    env: { ...process.env, DISPLAY }
  });
  const pages = await genBrowser.pages();
  genPage = pages[0] || (await genBrowser.newPage());
  return genPage;
}

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
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', '--window-size=1280,1000', '--window-position=0,0', '--start-maximized',
      `--proxy-server=${process.env.DRAW_PROXY || 'http://127.0.0.1:7897'}`],
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
export function generateImageChatgpt({ stateDir, prompt, projectUrl = '', timeoutMs = 240000 } = {}) {
  const run = () => doGenerate({ stateDir, prompt, projectUrl, timeoutMs });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

async function doGenerate({ stateDir, prompt, projectUrl, timeoutMs }) {
  const text = String(prompt ?? '').trim().slice(0, 800);
  if (!text) return { ok: false, error: 'prompt 不能为空' };
  if (!chatgptProfileReady(stateDir)) return { ok: false, error: '还没有登录 ChatGPT（先跑 scripts/chatgpt-login.mjs 登录一次）' };

  let browser = null;
  try {
    browser = await launch(stateDir, false);   // launch 用的 DISPLAY 已是 :44（隐藏屏）
    const page = (await browser.pages())[0] || (await browser.newPage());
    const target = String(projectUrl || '').trim() || 'https://chatgpt.com/';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 未登录会被重定向到 auth；检测一下，别白等
    const needLogin = await page.evaluate(() => /log in|登录/i.test(document.body?.innerText?.slice(0, 2000) || '')).catch(() => false);
    if (needLogin) return { ok: false, error: 'ChatGPT 未登录（需要重新登录）' };

    const baseline = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.src)).catch(() => []);
    const baselineBlobCount = baseline.filter((u) => String(u).startsWith('blob:')).length;

    // ChatGPT 的输入框是 #prompt-textarea（ProseMirror），项目页/新会话页都可能有可见延迟
    await page.waitForSelector('#prompt-textarea, div[contenteditable="true"], textarea', { timeout: 45000 }).catch(() => {});
    const el = await page.evaluateHandle(() => {
      const pick = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 10; });
      return pick[pick.length - 1] || null;
    });
    if (!el || !(await el.asElement())) {
      await page.screenshot({ path: path.join(stateDir, 'chatgpt-draw-last.png') }).catch(() => {});
      return { ok: false, error: '找不到输入框（已留截图 state/chatgpt-draw-last.png）' };
    }
    await el.asElement().click();
    await page.keyboard.type(text, { delay: 20 });
    await page.keyboard.press('Enter');

    // 等这一轮真正跑完：生成中会出现 stop 按钮 / 发送按钮消失；结束后反过来。
    const deadline = Date.now() + timeoutMs;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const st = await page.evaluate(() => ({
        stop: !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]'),
        send: !!document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]'),
        len: (document.body.innerText || '').length
      })).catch(() => null);
      if (st && !st.stop && st.send) { done = true; break; }
    }
    if (!done) {
      await page.screenshot({ path: path.join(stateDir, 'chatgpt-draw-last.png') }).catch(() => {});
      return { ok: false, error: '这一轮没跑完（超时），已留截图 state/chatgpt-draw-last.png' };
    }
    // 完成后：取 DOM 里**最后一张**大图（最新消息在最下面），再按字节校验
    const lastSrc = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 512 && i.naturalHeight >= 512);
      const last = imgs[imgs.length - 1];
      return last ? (last.currentSrc || last.src || '') : '';
    }).catch(() => '');
    if (!lastSrc) {
      await page.screenshot({ path: path.join(stateDir, 'chatgpt-draw-last.png') }).catch(() => {});
      return { ok: false, error: '这一轮没有生成图片，已留截图 state/chatgpt-draw-last.png' };
    }
    const b64 = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u); const b = await r.blob();
        return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); });
      } catch { return ''; }
    }, lastSrc).catch(() => '');
    if (!b64 || !/^data:image\//.test(b64)) return { ok: false, error: '取图失败（dataURL 为空）' };
    const buffer = Buffer.from(b64.split(',')[1] || '', 'base64');
    if (!buffer.length) return { ok: false, error: '图片数据为空' };
    const mime = /^data:(image\/[a-z+]+);/i.exec(b64)?.[1] || 'image/png';
    return { ok: true, buffer, mime, model: 'chatgpt-web', size: 'auto' };
  } catch (error) {
    return { ok: false, error: `ChatGPT 网页出图失败：${error?.message ?? error}` };
  } finally {
    await browser?.close?.().catch(() => {});   // 每个任务结束时关掉，不留窗口
  }
}
