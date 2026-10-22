// 服务状态（DeepSeek 状态页，FlashCat）：概要走桥接接口，正文用 iframe 嵌官方页面。
import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'status';
export const title = '服务状态';
export const desc = 'DeepSeek 服务可用性与最近事件（嵌入 status.deepseek.com）';
export const icon = 'ops';
export const group = '系统';
export const order = 2;

async function refreshStatus(view) {
  const el = $('#dsStatusSummary', view);
  const box = $('#dsStatusRecent', view);
  if (!el) return;
  el.textContent = '加载中…';
  el.className = 'meta';
  const r = await api('/api/status/deepseek').catch(() => null);
  if (!r || r.ok === false) {
    el.textContent = '读取失败';
    if (box) box.textContent = r?.error || '';
    return;
  }
  el.textContent = r.healthy ? '全部正常' : `有 ${r.activeCount} 个进行中的事件`;
  if (!r.healthy) el.className = 'meta warn';
  if (box) {
    const items = (r.recent || []).slice(0, 5).map((c) => {
      const d = c.at ? new Date(c.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `${d} ${c.title}`;
    });
    box.textContent = items.length ? ('最近事件：' + items.join(' ｜ ')) : '';
  }
}

export async function mount(root) {
  const view = await mountFragment(root, 'status');
  await refreshStatus(view);
  $('#dsStatusRefresh', view)?.addEventListener('click', () => {
    const f = $('#dsStatusFrame', view);
    if (f) f.src = f.src;   // 重载 iframe
    refreshStatus(view);
  });
}
