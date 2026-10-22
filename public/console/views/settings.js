// 设置：登录助手（给需要短信验证码的站点用）
import { api } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'settings';
export const title = '设置';
export const desc = '登录助手：填手机号收发验证码，完成需要短信登录的站点';
export const icon = 'tools';   // 图标集中没有齿轮，用工具图标代替
export const group = '系统';
export const order = 4;

function siteCard(site) {
  return `
  <section class="card span-all" data-site="${esc(site.id)}">
    <h2>${esc(site.name)} <span class="meta" data-role="status">${site.loggedIn ? '已登录 ✅' : '未登录'}</span></h2>
    <div class="meta" style="margin-bottom:8px">${esc(site.url)}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
      <input class="w-md" data-role="phone" placeholder="手机号（如 13800138000）" autocomplete="tel">
      <button class="small primary" data-act="start" type="button">发送验证码</button>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <input class="w-sm" data-role="code" placeholder="短信验证码" inputmode="numeric" autocomplete="one-time-code">
      <button class="small primary" data-act="code" type="button">登录</button>
      <button class="small" data-act="status" type="button">刷新状态</button>
      <button class="small" data-act="close" type="button">结束会话</button>
    </div>
    <div class="meta mt-8" data-role="msg"></div>
  </section>`;
}

export async function mount(root) {
  const view = await mountFragment(root, 'settings');
  const box = $('#loginSites', view);
  const r = await api('/api/login/sites').catch(() => null);
  if (!r || r.ok === false) { box.textContent = '读取站点失败'; return; }
  box.innerHTML = (r.sites || []).map(siteCard).join('');

  const setMsg = (card, text, ok = true) => {
    const m = card.querySelector('[data-role="msg"]');
    if (m) { m.textContent = text; m.className = 'meta mt-8' + (ok ? '' : ' warn'); }
  };
  const setStatus = (card, text) => {
    const s = card.querySelector('[data-role="status"]');
    if (s) s.textContent = text;
  };

  box.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-site]');
    const site = card.dataset.site;
    const act = btn.dataset.act;
    const phone = card.querySelector('[data-role="phone"]')?.value.trim() || '';
    const code = card.querySelector('[data-role="code"]')?.value.trim() || '';
    setMsg(card, '执行中…');
    if (act === 'start') {
      const res = await api('/api/login/start', 'POST', { site, phone }).catch((e) => ({ ok: false, error: e.message }));
      setMsg(card, res.ok ? (res.action || '已发送') : ('失败：' + (res.error || '')), res.ok);
    } else if (act === 'code') {
      const res = await api('/api/login/code', 'POST', { site, code }).catch((e) => ({ ok: false, error: e.message }));
      setMsg(card, res.ok ? ('已提交验证码：' + (res.url || '')) : ('失败：' + (res.error || '')), res.ok);
      if (res.ok) setStatus(card, '检查中…');
    } else if (act === 'status') {
      const res = await api('/api/login/status', 'POST', { site }).catch(() => null);
      if (res?.ok) {
        setStatus(card, res.loggedIn ? '已登录 ✅' : '未登录');
        setMsg(card, `当前页面：${res.url || '-'}${res.lastAction ? ' · ' + res.lastAction : ''}`);
      } else setMsg(card, '查询失败', false);
    } else if (act === 'close') {
      await api('/api/login/close', 'POST', { site }).catch(() => {});
      setStatus(card, '会话已关闭');
      setMsg(card, '已关闭浏览器会话（登录态已保存）');
    }
  });

  // ── 画图浏览器（豆包）：截图 + 点击转发（过验证码用）──────────────────
  const drawBox = $('#drawShotBox', view);
  const loadDrawShot = async () => {
    if (!drawBox) return;
    const r = await fetch('/api/draw/browser/shot?t=' + Date.now(), { headers: { 'x-console-token': localStorage.getItem('consoleToken') || '' } }).catch(() => null);
    if (!r || !r.ok) { drawBox.innerHTML = '<span class="meta">没有画面（先点「打开」）</span>'; return; }
    const blob = await r.blob();
    drawBox.innerHTML = '';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.style.cssText = 'max-width:100%;border-radius:8px;border:1px solid #30363d;cursor:crosshair';
    img.addEventListener('click', async (ev) => {
      const rect = img.getBoundingClientRect();
      const x = Math.round((ev.clientX - rect.left) * (1280 / rect.width));
      const y = Math.round((ev.clientY - rect.top) * (1000 / rect.height));
      await api('/api/draw/browser/click', 'POST', { x, y }).catch(() => {});
      setTimeout(loadDrawShot, 400);
    });
    drawBox.appendChild(img);
    $('#drawState', view) && ($('#drawState', view).textContent = '运行中');
  };
  $('#drawOpen', view)?.addEventListener('click', async () => {
    await api('/api/draw/browser/open', 'POST', {}).catch(() => {});
    setTimeout(loadDrawShot, 1500);
  });
  $('#drawShotBtn', view)?.addEventListener('click', loadDrawShot);
  $('#drawClose', view)?.addEventListener('click', async () => {
    await api('/api/draw/browser/close', 'POST', {}).catch(() => {});
    if ($('#drawState', view)) $('#drawState', view).textContent = '未打开';
    if (drawBox) drawBox.innerHTML = '<span class="meta">已关闭</span>';
  });

  $('#lgShot', view)?.addEventListener('click', async () => {
    const site = $('#lgShotSite', view)?.value.trim() || 'deepseek';
    const out = $('#lgShotBox', view);
    const r2 = await fetch(`/api/login/shot?site=${encodeURIComponent(site)}`, { headers: { 'x-console-token': localStorage.getItem('consoleToken') || '' } }).catch(() => null);
    if (!r2 || !r2.ok) { out.textContent = '没有活动会话（先点上面的「发送验证码」打开浏览器）'; return; }
    const blob = await r2.blob();
    out.innerHTML = '';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.style.cssText = 'max-width:100%;border-radius:8px;border:1px solid #30363d';
    out.appendChild(img);
  });
}
