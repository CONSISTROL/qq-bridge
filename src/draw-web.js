// 画图（web 版免费豆包）：用真浏览器跑一遍「发一句话 → 等出图 → 取图」。
//
// 为什么不用接口重放：实测直接 POST /chat/completion 会被风控拦下
// （error_code 710022004 "rate limited"，decision 里 verify_scene=doubao_message_web），
// 因为 a_bogus/fp 是浏览器端算的签名，重放不通过。真浏览器跑就没这个问题。
//
// 依赖：puppeteer + 已登录的 profile（scripts/doubao-login.mjs 扫码一次）。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const PROFILE = (stateDir) => path.join(stateDir, 'chrome-profile');
const LOCKED = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function clearLocks(stateDir) {
  for (const f of LOCKED) { try { fs.rmSync(path.join(PROFILE(stateDir), f), { force: true }); } catch { /* 忽略 */ } }
}

/** 用浏览器生成一张图，返回 { ok, buffer, mime } 或 { ok:false, error }。串行执行，避免多个浏览器抢 profile。 */
let queue = Promise.resolve();
export function generateImageWeb({ stateDir, prompt, timeoutMs = 150000 } = {}) {
  const run = () => doGenerate({ stateDir, prompt, timeoutMs });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

async function doGenerate({ stateDir, prompt, timeoutMs }) {
  const text = String(prompt ?? '').trim().slice(0, 500);
  if (!text) return { ok: false, error: 'prompt 不能为空' };
  if (!fs.existsSync(PROFILE(stateDir))) return { ok: false, error: '没有登录态，先跑 scripts/doubao-login.mjs 扫码' };
  clearLocks(stateDir);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      userDataDir: PROFILE(stateDir),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', '--window-size=1280,900'],
      defaultViewport: { width: 1280, height: 900 }
    });
    const page = await browser.newPage();
    await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 未登录就明确报错（避免白等）
    const needLogin = await page.evaluate(() => [...document.querySelectorAll('button,div,a,span')]
      .some((el) => (el.innerText || '').trim() === '登录')).catch(() => false);
    if (needLogin) return { ok: false, error: '豆包未登录（需要重新扫码）' };

    // 先记下页面原有的图片，只认「发送之后新出现的」那张（否则会抓到首页插画）
    const baseline = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.src)).catch(() => []);

    const sel = 'textarea, [contenteditable="true"]';
    await page.waitForSelector(sel, { timeout: 20000 });
    await page.click(sel);
    await page.keyboard.type(text, { delay: 15 });
    await page.keyboard.press('Enter');

    const deadline = Date.now() + timeoutMs;
    let src = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      src = await page.evaluate((seen) => {
        const imgs = [...document.querySelectorAll('img')]
          .filter((i) => !seen.includes(i.src) && i.naturalWidth >= 400 && i.naturalHeight >= 400)
          .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
        return imgs[0]?.src || '';
      }, baseline).catch(() => '');
      if (src) break;
    }
    if (!src) return { ok: false, error: '等不到出图（可能被限流/需要验证）' };

    // 直接在页面里取像素，避免再走一次网络（图片可能带鉴权/防盗链）
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(u);
      const b = await r.blob();
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); });
    }, src).catch(() => '');
    if (!b64 || !b64.startsWith('data:image/')) return { ok: false, error: '取图失败（页面里拿不到图片数据）' };
    const buffer = Buffer.from(b64.split(',')[1] || '', 'base64');
    if (!buffer.length) return { ok: false, error: '图片数据为空' };
    const mime = /^data:(image\/[a-z+]+);/i.exec(b64)?.[1] || 'image/png';
    return { ok: true, buffer, mime, url: src };
  } catch (error) {
    return { ok: false, error: `浏览器出图失败：${error?.message ?? error}` };
  } finally {
    await browser?.close?.().catch(() => {});
  }
}
