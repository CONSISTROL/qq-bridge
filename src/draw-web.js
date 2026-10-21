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
      headless: false, // 有头模式（配合 xvfb-run）：headless 更容易被判定为机器人
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

    // 关键一步：点技能栏里的「图像生成」（实测按钮是 button[data-testid^="skill_bar_button"]，
    // 文本命中「图像生成」）。不切模式的话它只回文字，永远等不到图。
    await page.waitForSelector('button[data-testid^="skill_bar_button"]', { timeout: 20000 }).catch(() => {});
    const switched = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button[data-testid^="skill_bar_button"], button')]
        .filter((el) => (el.innerText || '').trim() === '图像生成' && el.getBoundingClientRect().width > 0);
      const el = btns[0];
      if (!el) return false;
      el.click();
      return true;
    }).catch(() => false);
    if (!switched) return { ok: false, error: '找不到「图像生成」入口（页面可能改版）' };
    await new Promise((r) => setTimeout(r, 2500));

    // 先记下页面原有的图片，只认「发送之后新出现的」那张（否则会抓到首页插画）
    const baseline = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.src)).catch(() => []);

    // 切到图像模式后输入框是可见的 contenteditable（不是 textarea），只点可见的那个
    const sel = '[contenteditable="true"], textarea';
    await page.waitForSelector(sel, { timeout: 20000 });
    const box = await page.evaluateHandle((q) => [...document.querySelectorAll(q)]
      .filter((e) => e.getBoundingClientRect().width > 200)[0], sel);
    await box.asElement()?.click?.();
    await new Promise((r) => setTimeout(r, 300));
    // 真人节奏：逐字 70~140ms，末尾停顿一下再回车（一口气打完会被判定为机器输入）
    for (const ch of text) {
      await page.keyboard.type(ch);
      await new Promise((r) => setTimeout(r, 70 + Math.random() * 70));
    }
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
    await page.keyboard.press('Enter');

    const deadline = Date.now() + timeoutMs;
    let src = '';
    let canvasData = '';
    // 注意：轮询里只做「一次 querySelectorAll('img')」这种廉价操作。
    // 之前在一次 evaluate 里扫 message 容器 + 全页 div 的 computedStyle，单次调用要十几秒，
    // 超时后 catch 吞掉错误 → 永远检测不到（踩过）。
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const got = await page.evaluate((seen) => {
        const imgs = [...document.querySelectorAll('img')]
          .filter((i) => !seen.includes(i.src) && i.naturalWidth >= 400 && i.naturalHeight >= 400)
          .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
        if (imgs[0]) return { src: imgs[0].src };
        const cv = [...document.querySelectorAll('canvas')].find((c) => c.width >= 400 && c.height >= 400);
        if (cv) { try { return { canvas: cv.toDataURL('image/png') }; } catch { /* 跨域 */ } }
        return null;
      }, baseline).catch(() => null);
      // 验证码（语义九宫格）：一旦出现就直接报出来，别白等
      const captcha = await page.evaluate(() => /请选择所有|拖拽到下方|拖拽到这里|验证您|人机验证/.test(document.body.innerText || '')).catch(() => false);
      if (captcha) {
        await page.screenshot({ path: path.join(stateDir, 'draw-web-captcha.png') }).catch(() => {});
        return { ok: false, captcha: true, error: '触发了人机验证（语义九宫格），需要人工过' };
      }
      if (got?.src) { src = got.src; break; }
      if (got?.canvas) { canvasData = got.canvas; break; }
    }
    if (!src && canvasData) {
      const buffer = Buffer.from(canvasData.split(',')[1] || '', 'base64');
      if (buffer.length) return { ok: true, buffer, mime: 'image/png', url: 'canvas' };
    }
    if (!src) {
      await page.screenshot({ path: path.join(stateDir, 'draw-web-last.png') }).catch(() => {});
      return { ok: false, error: '等不到出图（可能还在排队/被限流），已留截图 state/draw-web-last.png' };
    }

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
