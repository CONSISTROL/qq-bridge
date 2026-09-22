// 总览：01 运行模式 + 02 会话映射 + 03 挂起审批 + 04 活动日志
import { api } from '../core/api.js';
import { $, esc, toast, delegate, confirmDanger } from '../core/dom.js';
import { every } from '../core/poll.js';
import { mountFragment } from '../core/fragments.js';
import { getStatus, getPending, refreshStatus } from '../core/status.js';

export const id = 'overview';
export const title = '总览';
export const desc = '运行模式 · 会话映射 · 挂起审批 · 活动日志';
export const icon = '📊';
export const group = '总览';
export const order = 1;
export const badge = 'navPending';

function renderStatus(view, s) {
  if (!s) return;
  for (const btn of view.querySelectorAll('#modeRow button')) {
    btn.classList.toggle('active', btn.dataset.mode === s.mode);
  }
  const sel = $('#closedPreset', view);
  if (sel && document.activeElement !== sel) sel.value = s.closedAgentPreset || '';
  $('#activity', view).textContent = s.activity || '（空）';
}

function renderPending(view, list) {
  const box = $('#pendingList', view);
  if (!list.length) { box.innerHTML = '<span class="meta">无挂起请求</span>'; return; }
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
  const s = await api('/api/sessions').catch(() => null);
  if (!s) return;
  const box = $('#sessionList', view);
  if (!s.sessions.length) { box.innerHTML = '<span class="meta">暂无会话</span>'; return; }
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

async function refreshPresets(view) {
  const r = await api('/api/presets').catch(() => null);
  if (!r) return;
  const sel = $('#closedPreset', view);
  const current = sel.value;
  sel.textContent = '';
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = '（DSH 默认 preset）';
  sel.appendChild(defOpt);
  for (const p of r.presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.id + (p.trust === 'user' ? '（用户）' : '');
    sel.appendChild(opt);
  }
  sel.value = current;
}

async function saveMode(view, mode) {
  // 不再硬编码 'router-standard'（DSH 0.1.5 已无此 preset）；
  // 留空表示让桥接使用 DSH 自己声明的默认 preset。
  const preset = $('#closedPreset', view).value || '';
  const r = await api('/api/mode', 'POST', { mode, closedAgentPreset: preset }).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) {
    await refreshStatus();
    // 桥接会把模式写穿到 DSH 设置；写穿失败时本地值会在下一次轮询被覆盖回滚。
    // 不提示的话用户只会看到「刚切过去又自己变回来了」，无从判断原因。
    if (r.dshSynced === false) {
      toast('模式已写入本地，但未能同步到 DSH 设置（DSH 未运行？）——\n下一次轮询（约 5 秒）会把模式改回去。请检查 DSH 与桥接日志。', 'err', 9000);
    } else {
      toast('模式已切换：' + mode, 'ok');
    }
  } else {
    toast(r.error || '切换失败', 'err');
  }
}

export async function mount(root) {
  const view = await mountFragment(root, 'overview');

  const onStatus = (ev) => renderStatus(view, ev.detail);
  const onPending = (ev) => renderPending(view, ev.detail || []);
  document.addEventListener('console:status', onStatus);
  document.addEventListener('console:pending', onPending);
  renderStatus(view, getStatus());
  renderPending(view, getPending());

  delegate($('#modeRow', view), 'click', 'button[data-mode]', (_ev, btn) => {
    if (btn.disabled) return;
    saveMode(view, btn.dataset.mode);
  });
  $('#closedPreset', view).addEventListener('change', () => {
    const active = view.querySelector('#modeRow button.active');
    saveMode(view, active ? active.dataset.mode : 'chat');
  });
  delegate($('#sessionList', view), 'click', '[data-reset-key]', async (_ev, btn) => {
    if (!confirmDanger('确定清除该会话的上下文？下次消息将开新会话。')) return;
    const r = await api('/api/session/reset', 'POST', { key: btn.dataset.resetKey }).catch((e) => ({ ok: false, error: e.message }));
    toast(r.ok ? '✅ 已清除上下文' : ('❌ ' + (r.error || '失败')), r.ok ? 'ok' : 'err');
    refreshSessions(view);
  });

  refreshPresets(view);
  refreshSessions(view);
  const stopSessions = every(10000, () => refreshSessions(view));

  return () => {
    stopSessions();
    document.removeEventListener('console:status', onStatus);
    document.removeEventListener('console:pending', onPending);
  };
}
