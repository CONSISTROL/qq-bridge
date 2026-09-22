// 人格（05 角色扮演）与静默开关（11）
import { api } from '../core/api.js';
import { $, esc, toast, delegate, setMsg } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';
import { getStatus, refreshStatus } from '../core/status.js';

export const id = 'persona';
export const title = '人格与静默';
export const desc = '当前角色、人格库、静默开关';
export const icon = '🎭';
export const group = '运行';
export const order = 2;

function renderRoleState(view, s) {
  if (!s) return;
  $('#roleText', view).textContent = s.role || '无';
  $('#roleModeText', view).textContent = s.roleMode === 'silent' ? '静默' : '正常';
}

async function refreshRoles(view) {
  const r = await api('/api/roles').catch(() => null);
  const box = $('#roleList', view);
  if (!r) { box.textContent = '加载失败'; return; }
  box.textContent = '';
  if (!r.roles.length) {
    const hint = document.createElement('span');
    hint.className = 'meta';
    hint.textContent = '暂无角色，可在下方新建';
    box.appendChild(hint);
    return;
  }
  for (const name of r.roles) {
    const tag = document.createElement('span');
    tag.className = 'tag' + (name === r.current ? ' active' : '');
    tag.textContent = name;
    tag.dataset.role = name;
    box.appendChild(tag);
  }
}

async function applyRole(view, role) {
  const r = await api('/api/role', 'POST', { role }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) toast(r.error || '设置失败', 'err');
  await refreshRoles(view);
  await refreshStatus();
}

export async function mount(root) {
  const view = await mountFragment(root, 'persona');

  const onStatus = (ev) => renderRoleState(view, ev.detail);
  document.addEventListener('console:status', onStatus);
  renderRoleState(view, getStatus());
  await refreshRoles(view);

  delegate($('#roleList', view), 'click', '[data-role]', (_ev, tag) => applyRole(view, tag.dataset.role));
  $('#roleSet', view).addEventListener('click', () => {
    const name = $('#roleInput', view).value.trim();
    if (!name) { toast('先填角色名', 'err'); return; }
    applyRole(view, name);
  });
  $('#roleClear', view).addEventListener('click', () => applyRole(view, null));
  $('#roleCreate', view).addEventListener('click', async () => {
    const name = $('#newRoleName', view).value.trim();
    const content = $('#newRoleContent', view).value.trim();
    const r = await api('/api/roles/create', 'POST', { name, content }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#roleCreateMsg', view), r.ok ? '✅ 已创建' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) {
      $('#newRoleName', view).value = '';
      $('#newRoleContent', view).value = '';
      refreshRoles(view);
    }
  });

  const setSilent = async (mode) => {
    const r = await api('/api/role-mode', 'POST', { mode }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) toast(r.error || '切换失败', 'err');
    await refreshStatus();
  };
  $('#silentOn', view).addEventListener('click', () => setSilent('silent'));
  $('#silentOff', view).addEventListener('click', () => setSilent('active'));

  return () => document.removeEventListener('console:status', onStatus);
}
