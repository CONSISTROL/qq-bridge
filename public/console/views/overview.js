// 总览：01 运行模式 + 02 会话映射 + 03 挂起审批 + 04 活动日志
import { api } from '../core/api.js';
import { $, esc, toast, delegate, confirmDanger } from '../core/dom.js';
import { every } from '../core/poll.js';
import { mountFragment } from '../core/fragments.js';
import { getStatus, getPending, refreshStatus } from '../core/status.js';

export const id = 'overview';
export const title = '总览';
export const desc = '运行模式 · 会话映射 · 挂起审批 · 活动日志';
export const icon = 'overview';
export const group = '总览';
export const order = 1;
export const badge = 'navPending';

function renderStatus(view, s) {
  if (!s) return;
  $('#activity', view).textContent = s.activity || '（空）';
}

function renderPending(view, list) {
  const box = $('#pendingList', view);
  if (!box) return; // 总览已移除「挂起审批」卡
  if (!list.length) { box.innerHTML = '<div class="empty">无挂起请求</div>'; return; }
  let html = '<table><tr><th>会话</th><th>类型</th><th>详情</th></tr>';
  for (const x of list) {
    const kind = x.kind === 'approval' ? '<span class="pill r">审批</span>' : '<span class="pill b">提问</span>';
    let detail = '';
    if (x.kind === 'approval') detail = `${esc(x.toolName)}${x.reason ? '：' + esc(x.reason) : ''}`;
    else if (x.questions) detail = x.questions.map((q) => esc(q.question)).join(' / ');
    html += `<tr><td>${esc(x.key)}</td><td>${kind}</td><td>${detail}</td></tr>`;
  }
  box.innerHTML = html + '</table>';
}

async function refreshSessions(view) {
  if (!$('#sessionList', view)) return; // 总览已移除「会话映射」卡
  const s = await api('/api/sessions').catch(() => null);
  if (!s) return;
  const box = $('#sessionList', view);
  if (!s.sessions.length) { box.innerHTML = '<div class="empty">暂无会话<br><b>收到 QQ 消息后这里会出现</b>。</div>'; return; }
  let html = '<table><tr><th>QQ 会话</th><th>DSH 会话 ID</th><th>类型</th><th></th></tr>';
  for (const x of s.sessions) {
    const isPrivate = x.key.startsWith('private:');
    const type = isPrivate ? '<span class="pill b">私聊</span>' : '<span class="pill g">群</span>';
    const ownerTag = x.owner ? ' <span class="pill r">管理员</span>' : '';
    html += `<tr><td>${esc(x.key)}${ownerTag}</td><td><code>${esc(x.sessionId)}</code></td><td>${type}</td>`
      + `<td><button class="small" data-reset-key="${esc(x.key)}">清除上下文</button></td></tr>`;
  }
  box.innerHTML = html + '</table>';
}

export async function mount(root) {
  const view = await mountFragment(root, 'overview');

  const onStatus = (ev) => renderStatus(view, ev.detail);
  const onPending = (ev) => renderPending(view, ev.detail || []);
  document.addEventListener('console:status', onStatus);
  document.addEventListener('console:pending', onPending);
  renderStatus(view, getStatus());
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
    document.removeEventListener('console:status', onStatus);
    document.removeEventListener('console:pending', onPending);
  };
}
