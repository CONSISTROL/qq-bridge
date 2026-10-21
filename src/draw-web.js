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

    // 关键一步：先切到「图像生成」模式（豆包首页的对话/图像生成/视频生成 是不同入口）。
    // 不切的话它会用普通对话回答，永远等不到图。
    const switched = await page.evaluate(() => {
      const cand = [...document.querySelectorAll('button,div,span,a')]
        .filter((el) => (el.innerText || '').trim() === '图像生成' && el.getBoundingClientRect().width > 0);
      const el = cand[cand.length - 1];
      if (!el) return false;
      el.click();
      return true;
    }).catch(() => false);
    if (switched) await new Promise((r) => setTimeout(r, 2500));

    // 先记下页面原有的图片，只认「发送之后新出现的」那张（否则会抓到首页插画）
    const baseline = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.src)).catch(() => []);

    const sel = 'textarea, [contenteditable="true"]';
    await page.waitForSelector(sel, { timeout: 20000 });
    await page.click(sel);
    await page.keyboard.type(text, { delay: 15 });
    await page.keyboard.press('Enter');

    const deadline = Date.now() + timeoutMs;
    let src = '';
    let canvasData = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const got = await page.evaluate((seen) => {
        // 只在「助手消息」容器里找：豆包的回复气泡通常带 message / receive / assistant 语义
        const scopes = [
          ...document.querySelectorAll('[data-testid*="message"], [class*="message"], [class*="receive"], [class*="assistant"]')
        ];
        const pick = (root) => [...root.querySelectorAll('img')]
          .filter((i) => !seen.includes(i.src) && i.naturalWidth >= 480 && i.naturalHeight >= 480)
          .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
        for (const sc of scopes) { const hit = pick(sc); if (hit) return { src: hit.src }; }
        // 兜底：整页里出现的新大图
        const any = [...document.querySelectorAll('img')]
          .filter((i) => !seen.includes(i.src) && i.naturalWidth >= 480 && i.naturalHeight >= 480)
          .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
        if (any) return { src: any.src };
        // 再兜底：canvas 画布（有些实现把图渲进 canvas）
        const cv = [...document.querySelectorAll('canvas')].find((c) => c.width >= 480 && c.height >= 480);
        if (cv) { try { return { canvas: cv.toDataURL('image/png') }; } catch { /* 跨域画布取不到 */ } }
        return null;
      }, baseline).catch(() => null);
      if (got?.src) { src = got.src; break; }
      if (got?.canvas) { canvasData = got.canvas; break; }
    }
    if (!src && canvasData) {
      const buffer = Buffer.from(canvasData.split(',')[1] || '', 'base64');
      if (buffer.length) return { ok: true, buffer, mime: 'image/png', url: 'canvas' };
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
