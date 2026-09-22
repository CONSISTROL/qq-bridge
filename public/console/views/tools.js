// DSH 侧 MCP 工具（09）+ 后台控制端引导（15）
import { api } from '../core/api.js';
import { $, toast, setMsg } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'tools';
export const title = 'MCP 工具';
export const desc = 'DSH 侧工具清单、后台控制端引导（向某个会话的 agent 投递提醒）';
export const icon = '🧰';
export const group = '系统';
export const order = 5;

export async function mount(root) {
  const view = await mountFragment(root, 'tools');

  $('#aiNotifySend', view).addEventListener('click', async () => {
    const kind = $('#aiNotifyKind', view).value;
    const id = $('#aiNotifyId', view).value.trim();
    const message = $('#aiNotifyMessage', view).value.trim();
    if (!id || !message) { toast('请填写群号/QQ 号和提醒内容', 'err'); return; }
    const r = await api('/api/console/notify-ai', 'POST', { key: kind + ':' + id, message })
      .catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#aiNotifyMsg', view), r.ok ? ('✅ 已投递到 DSH：' + r.sessionId) : ('❌ ' + (r.error || '失败')), r.ok);
  });
}
