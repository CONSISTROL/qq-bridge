// 远程点选会话：一个"看得见、点得着"的浏览器，主人通过网页看画面、过验证码、抓图。
//
// 为什么需要：豆包 web 对自动化浏览器每次都弹语义验证码（实测 0/3），
// 自动过验证不可行；但让人在网页上点几下就可以——这个模块负责：
//   启动 chrome（xvfb + 远程调试端口）→ 截图给页面 → 转发点击 → 抓生成的图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const PORT = 9333;
const W = 1280;
const H = 900;

let browser = null;
let page = null;
let child = null;
let lastError = '';
let baseline = [];

const profileDir = (stateDir) => path.join(stateDir, 'chrome-profile');

function clearLocks(stateDir) {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(profileDir(stateDir), f), { force: true }); } catch { /* 忽略 */ }
  }
}

export function liveStatus() {
  return { alive: !!page, url: page ? page.url() : '', error: lastError, port: PORT };
}

export async function startLive({ stateDir }) {
  if (page) return { ok: true, reused: true };
  clearLocks(stateDir);
  // 起一个虚拟显示（有头 Chrome 必须），已存在就复用
  // 用 :99 —— 专属虚拟屏（x11vnc 5902 → websockify 6083 → 桥接 /vnc/），避免和 :98 上的 Clash 抢画面
  const DISPLAY = process.env.DRAW_DISPLAY || ':99';
  try {
    const probe = spawn('sh', ['-c', `pgrep -f "Xvfb ${DISPLAY}" >/dev/null || Xvfb ${DISPLAY} -screen 0 1280x900x24 >/dev/null 2>&1 &`], { detached: true, stdio: 'ignore' });
    probe.unref();
  } catch { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: profileDir(stateDir),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN', `--window-size=${W},${H}`],
      defaultViewport: { width: W, height: H },
      env: { ...process.env, DISPLAY }
    });
  } catch (error) {
    lastError = String(error?.message ?? error);
    return { ok: false, error: `chrome 启动失败：${lastError}` };
  }
  const pages = await browser.pages().catch(() => []);
  page = pages[0] || (await browser.newPage());
  await page.setViewport({ width: W, height: H }).catch(() => {});
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  baseline = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.src)).catch(() => []);
  return { ok: true };
}

export async function liveShot() {
  if (!page) return null;
  return page.screenshot({ type: 'jpeg', quality: 60 });
}

export async function liveClick({ x, y }) {
  if (!page) return { ok: false, error: '没有活动会话' };
  const px = Math.max(0, Math.min(W - 1, Math.round(Number(x) || 0)));
  const py = Math.max(0, Math.min(H - 1, Math.round(Number(y) || 0)));
  await page.mouse.click(px, py);
  return { ok: true };
}

/** 指针事件：支持按下/移动/抬起，才能把「拖拽」转发到真实浏览器。 */
export async function livePointer({ type, x, y }) {
  if (!page) return { ok: false, error: '没有活动会话' };
  const px = Math.max(0, Math.min(W - 1, Math.round(Number(x) || 0)));
  const py = Math.max(0, Math.min(H - 1, Math.round(Number(y) || 0)));
  try {
    if (type === 'down') await page.mouse.move(px, py), await page.mouse.down();
    else if (type === 'move') await page.mouse.move(px, py, { steps: 2 });
    else if (type === 'up') await page.mouse.up();
    else return { ok: false, error: 'type 只能是 down/move/up' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 切到「图像生成」并发送提示词。 */
export async function livePrompt({ prompt }) {
  if (!page) return { ok: false, error: '没有活动会话' };
  await page.waitForSelector('button[data-testid^="skill_bar_button"]', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button[data-testid^="skill_bar_button"]')]
      .find((e) => (e.innerText || '').trim() === '图像生成');
    if (el) el.click();
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2200));
  const box = await page.evaluateHandle(() => [...document.querySelectorAll('[contenteditable="true"], textarea')]
    .filter((e) => e.getBoundingClientRect().width > 200)[0]);
  const el = box.asElement();
  if (!el) return { ok: false, error: '找不到输入框' };
  await el.click();
  await page.keyboard.type(String(prompt || '').slice(0, 500), { delay: 40 });
  await page.keyboard.press('Enter');
  return { ok: true };
}

/** 抓「发送之后新出现的图」。不在新图里就返回失败（页面上可以人工重试）。 */
export async function liveGrab() {
  if (!page) return { ok: false, error: '没有活动会话' };
  const got = await page.evaluate((seen) => {
    const imgs = [...document.querySelectorAll('img')]
      .filter((i) => !seen.includes(i.src) && i.naturalWidth >= 400 && i.naturalHeight >= 400)
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return imgs[0]?.src || '';
  }, baseline).catch(() => '');
  if (!got) return { ok: false, error: '页面里还没有新图（可能还在生成/没过验证）' };
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u); const b = await r.blob();
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); });
  }, got).catch(() => '');
  if (!b64?.startsWith('data:image/')) return { ok: false, error: '取图失败' };
  const buffer = Buffer.from(b64.split(',')[1] || '', 'base64');
  baseline = [...baseline, got];
  return { ok: buffer.length > 0, buffer, mime: /^data:(image\/[a-z+]+);/i.exec(b64)?.[1] || 'image/png', url: got };
}

export async function stopLive() {
  try { await browser?.close?.(); } catch { /* 忽略 */ }
  try { if (child?.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* 忽略 */ }
  browser = null; page = null; child = null; baseline = [];
  return { ok: true };
}
