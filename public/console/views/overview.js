// 总览：01 运行模式 + 02 会话映射 + 03 挂起审批 + 04 活动日志
import { api } from '../core/api.js';
import { $, esc, toast, delegate, confirmDanger, setMsg } from '../core/dom.js';
import { every } from '../core/poll.js';
import { mountFragment } from '../core/fragments.js';
import { getStatus, getPending, refreshStatus } from '../core/status.js';

export const id = 'overview';
export const title = '总览';
export const desc = '运行说明 · 会话映射 · 挂起审批 · 活动日志';
export const icon = 'overview';
export const group = '总览';
export const order = 1;
export const badge = 'navPending';

// 活动日志：默认停在最新一条；用户往上翻时暂停自动跟随，并给出「回到最新」。
function createActivityLog(view) {
  const el = $('#activity', view);
  const jump = $('#activityJump', view);
  if (!el) return { render() {}, destroy() {} };
  const STICK_PX = 28;
  let follow = true;
  let initialized = false;
  const atBottom = () => el.scrollTop + el.clientHeight >= el.scrollHeight - STICK_PX;
  const syncJump = () => {
    if (!jump) return;
    jump.hidden = follow || el.scrollHeight <= el.clientHeight + 2;
  };
  const onScroll = () => { follow = atBottom(); syncJump(); };
  const onResize = () => {
    if (follow) el.scrollTop = el.scrollHeight;
    syncJump();
  };
  const toBottom = () => {
    follow = true;
    el.scrollTop = el.scrollHeight;
    syncJump();
  };
  const onJump = () => toBottom();
  el.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  jump?.addEventListener('click', onJump);
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; syncJump(); });
  return {
    render(text) {
      const next = String(text ?? '（空）');
      if (el.textContent === next) {
        if (follow) el.scrollTop = el.scrollHeight;
        syncJump();
        return;
      }
      const stick = follow || !initialized;
      const prevTop = el.scrollTop;
      el.textContent = next;
      initialized = true;
      requestAnimationFrame(() => {
        if (stick) toBottom();
        else {
          el.scrollTop = Math.min(prevTop, Math.max(0, el.scrollHeight - el.clientHeight));
          syncJump();
        }
      });
    },
    destroy() {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      jump?.removeEventListener('click', onJump);
    }
  };
}

function renderPending(view, list) {
  const box = $('#pendingList', view);
  if (!box) return; // 片段里缺这块时不要让整个视图崩掉
  if (!list.length) { box.innerHTML = '<div class="empty">无挂起请求</div>'; return; }
  let html = '<div class="table-wrap table-wide"><table><tr><th>会话</th><th>类型</th><th>详情</th></tr>';
  for (const x of list) {
    const kind = x.kind === 'approval' ? '<span class="pill r">审批</span>' : '<span class="pill b">提问</span>';
    let detail = '';
    if (x.kind === 'approval') detail = `${esc(x.toolName)}${x.reason ? '：' + esc(x.reason) : ''}`;
    else if (x.questions) detail = x.questions.map((q) => esc(q.question)).join(' / ');
    html += `<tr><td>${esc(x.key)}</td><td>${kind}</td><td>${detail}</td></tr>`;
  }
  box.innerHTML = html + '</table></div>';
}

async function refreshSessions(view) {
  const s = await api('/api/sessions').catch(() => null);
  if (!s) return;
  const box = $('#sessionList', view);
  if (!box) return;
  if (!s.sessions.length) { box.innerHTML = '<div class="empty">暂无会话<br><b>收到 QQ 消息后这里会出现</b></div>'; return; }
  let html = '<div class="session-list">';
  for (const x of s.sessions) {
    const isPrivate = x.key.startsWith('private:');
    const type = isPrivate ? '<span class="pill b">私聊</span>' : '<span class="pill g">群</span>';
    const ownerTag = x.owner ? ' <span class="pill r">管理员</span>' : '';
    const sid = typeof x.sessionId === 'string' ? x.sessionId : (x.sessionId?.sessionId || '');
    html += `<div class="session-row"><div class="session-main"><span class="session-key">${esc(x.key)}</span>${type}${ownerTag}</div>`
      + `<code class="session-sid" title="${esc(sid)}">${esc(sid || '—')}</code>`
      + `<button class="small" data-reset-key="${esc(x.key)}">清除上下文</button></div>`;
  }
  box.innerHTML = html + '</div>';
}

export async function mount(root) {
  const view = await mountFragment(root, 'overview');

  // 睡眠时段显示真实配置（socialData.sleepHours）
  (async () => {
    const r = await api('/api/socialData/config', 'GET').catch(() => null);
    const win = (r?.config || r)?.sleepHours;
    const el = $('#sleepWindowText', view);
    if (el && Array.isArray(win) && win.length === 2) {
      const fmt = (h) => String(Math.max(0, Math.min(23, Number(h)))).padStart(2, '0') + ':00';
      el.textContent = `${fmt(win[0])}–${fmt(win[1])}`;
    }
  })();

  // 服务状态（DeepSeek status page）
  const refreshDsStatus = async () => {
    const el = $('#dsStatusSummary', view);
    const box = $('#dsStatusRecent', view);
    if (!el) return;
    el.textContent = '加载中…';
    const r = await api('/api/status/deepseek').catch(() => null);   // 用 core/api 统一处理反代前缀
    if (!r || r.ok === false) { el.textContent = '读取失败'; if (box) box.textContent = r?.error || ''; return; }
    el.textContent = r.healthy ? '全部正常' : `有 ${r.activeCount} 个进行中的事件`;
    el.className = 'meta ' + (r.healthy ? '' : 'warn');
    if (box) {
      const items = (r.recent || []).slice(0, 3).map((c) => {
        const d = c.at ? new Date(c.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        return `${d} ${c.title}`;
      });
      box.textContent = items.length ? ('最近事件：' + items.join(' ｜ ')) : '';
    }
  };
  refreshDsStatus();
  $('#dsStatusRefresh', view)?.addEventListener('click', () => {
    const f = $('#dsStatusFrame', view); if (f) f.src = f.src;
    refreshDsStatus();
  });

  // 重启桥接（按钮从已删除的「运维」页搬到这里）
  delegate(view, 'click', '#restartBtn', async () => {
    if (!confirmDanger('确定重启桥接？\n\n守护模式下退出后 5 秒自动拉起；重启期间群消息会排队。')) return;
    const r = await api('/api/restart', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#restartMsg', view), r.message || r.error || '正在重启…', r.ok !== false);
  });

  const activityLog = createActivityLog(view);
  const onStatus = (ev) => { if (ev.detail) activityLog.render(ev.detail.activity); };
  const onPending = (ev) => renderPending(view, ev.detail || []);
  document.addEventListener('console:status', onStatus);
  document.addEventListener('console:pending', onPending);
  activityLog.render(getStatus()?.activity);
  renderPending(view, getPending());

  const sessionBox = $('#sessionList', view);
  if (sessionBox) {
    delegate(sessionBox, 'click', '[data-reset-key]', async (_ev, btn) => {
      if (!confirmDanger('确定清除该会话的上下文？下次消息将开新会话。')) return;
      const r = await api('/api/session/reset', 'POST', { key: btn.dataset.resetKey }).catch((e) => ({ ok: false, error: e.message }));
      toast(r.ok ? '✅ 已清除上下文' : ('❌ ' + (r.error || '失败')), r.ok ? 'ok' : 'err');
      refreshSessions(view);
    });
  }

  refreshSessions(view);
  const stopSessions = every(10000, () => refreshSessions(view));

  return () => {
    stopSessions();
    activityLog.destroy();
    document.removeEventListener('console:status', onStatus);
    document.removeEventListener('console:pending', onPending);
  };
}
