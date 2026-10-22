// 登录助手：在隐藏虚拟屏里开一个持久浏览器的「登录会话」，
// 主人在控制台填手机号 → 点「发送验证码」→ 收到短信后填验证码 → 点「登录」。
// 之所以这么绕：这些站点（如 DeepSeek 平台）要求短信验证码，
// 自动化没法替人收短信，但可以把「填表 + 点按钮」全自动，人只负责收码。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const SITES = {
  deepseek: {
    name: 'DeepSeek Platform',
    url: 'https://platform.deepseek.com/sign_in',
    profile: 'deepseek-profile',
    cookieHost: 'platform.deepseek.com',
    loginPath: /sign_in|login/i
  },
};

const DISPLAY = process.env.LOGIN_DISPLAY || ':44';
export const VIEW_W = 1400;
export const VIEW_H = 1000;
const sessions = new Map();   // site -> { browser, page, at, lastAction }

export function listSites() {
  return Object.entries(SITES).map(([id, s]) => ({
    id, name: s.name, url: s.url,
    active: sessions.has(id),
    loggedIn: hasProfileCookie(s.profile)
  }));
}

function profileDir(profile) { return path.join('./state', profile); }

function hasProfileCookie(profile, host) {
  try {
    const db = path.join(profileDir(profile), 'Default', 'Cookies');
    if (!fs.existsSync(db)) return false;
    const size = fs.statSync(db).size;
    return size > 8192;   // 粗略判断：有内容就当可能已登录（精确判断在 status 里做）
  } catch { return false; }
}

export async function ensureSession(siteId) {
  const site = SITES[siteId];
  if (!site) throw new Error(`未知站点：${siteId}`);
  const cur = sessions.get(siteId);
  if (cur && cur.page && !cur.page.isClosed()) return cur;
  const dir = profileDir(site.profile);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 忽略 */ }
  }
  // 确保虚拟屏存在
  try {
    const { spawn } = await import('node:child_process');
    spawn('sh', ['-c', `pgrep -f "Xvfb ${DISPLAY}" >/dev/null || (Xvfb ${DISPLAY} -screen 0 1400x1000x24 -nolisten tcp >/dev/null 2>&1 &)`], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* 忽略 */ }
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: dir,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN',
      '--window-size=1400,1000', '--window-position=0,0',
      '--disable-features=IsolateOrigins'],
    defaultViewport: { width: 1400, height: 1000 },
    env: { ...process.env, DISPLAY }
  });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  const sess = { browser, page, at: Date.now(), lastAction: '' };
  sessions.set(siteId, sess);
  return sess;
}

/** 通用：找输入框 / 点按钮（站点改版也能凑合，靠 placeholder 与文案匹配）。 */
async function typeInto(page, matchers, text) {
  const handle = await page.evaluateHandle((pats) => {
    const inputs = [...document.querySelectorAll('input, textarea')].filter((el) => el.getBoundingClientRect().width > 40);
    const score = (el) => {
      const hay = `${el.placeholder || ''} ${el.name || ''} ${el.id || ''} ${el.type || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      return pats.reduce((n, p) => n + (new RegExp(p, 'i').test(hay) ? 1 : 0), 0);
    };
    const best = inputs.map((el) => ({ el, s: score(el) })).sort((a, b) => b.s - a.s)[0];
    return best && best.s > 0 ? best.el : null;
  }, matchers);
  const el = handle.asElement();
  if (!el) return false;
  await el.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.type(String(text), { delay: 30 });
  return true;
}

async function clickText(page, re) {
  const ok = await page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const btns = [...document.querySelectorAll('button, [role="button"], a, div[tabindex]')]
      .filter((el) => {
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return t && t.length < 30 && r.width > 20 && rx.test(t);
      });
    const el = btns[0];
    if (!el) return false;
    el.click();
    return true;
  }, re.source).catch(() => false);
  return ok;
}

export async function startLogin({ site, phone }) {
  const sess = await ensureSession(site);
  const { page } = sess;
  const cfg = SITES[site];
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  if (phone) {
    const typed = await typeInto(page, ['phone', 'mobile', '手机', 'tel'], phone);
    if (!typed) sess.lastAction = '没找到手机号输入框';
    else {
      await clickText(page, /获取验证码|发送验证码|Send code|Get code|verification code/i);
      sess.lastAction = '已填手机号并尝试发送验证码';
    }
  } else {
    sess.lastAction = '已打开登录页（未填手机号）';
  }
  sess.at = Date.now();
  return { ok: true, action: sess.lastAction, url: page.url() };
}

export async function submitCode({ site, code }) {
  const sess = sessions.get(site) || (await ensureSession(site));
  const { page } = sess;
  if (!code) return { ok: false, error: '验证码不能为空' };
  const typed = await typeInto(page, ['code', 'otp', 'verification', '验证码'], code);
  if (!typed) return { ok: false, error: '没找到验证码输入框' };
  await clickText(page, /登录|登陆|Sign in|Log in|Continue|继续|验证/);
  await new Promise((r) => setTimeout(r, 4000));
  sess.lastAction = '已提交验证码';
  sess.at = Date.now();
  return { ok: true, action: sess.lastAction, url: page.url() };
}

export async function loginStatus({ site }) {
  const sess = sessions.get(site);
  const cfg = SITES[site];
  if (!cfg) return { ok: false, error: '未知站点' };
  if (!sess) return { ok: true, active: false, loggedIn: hasProfileCookie(cfg.profile), url: '' };
  const { page } = sess;
  const url = page.url();
  const loggedIn = !cfg.loginPath.test(url);
  const bodyOk = await page.evaluate(() => !/登录|sign in|log in/i.test((document.body?.innerText || '').slice(0, 300))).catch(() => true);
  return { ok: true, active: true, loggedIn: loggedIn || bodyOk, url, lastAction: sess.lastAction };
}

/** 把点击转发到登录浏览器（人工过验证码用：控制台看截图 → 点位置 → 这里转发）。 */
export async function loginClick({ site, x, y }) {
  const sess = sessions.get(site);
  if (!sess) return { ok: false, error: '没有活动会话' };
  const px = Math.max(0, Math.round(Number(x) || 0));
  const py = Math.max(0, Math.round(Number(y) || 0));
  try { await sess.page.mouse.click(px, py); return { ok: true }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

export async function loginShot({ site }) {
  const sess = sessions.get(site);
  if (!sess) return null;
  return sess.page.screenshot({ type: 'jpeg', quality: 55 });
}

export async function closeSession({ site }) {
  const sess = sessions.get(site);
  if (!sess) return { ok: true };
  await sess.browser?.close?.().catch(() => {});
  sessions.delete(site);
  return { ok: true };
}
