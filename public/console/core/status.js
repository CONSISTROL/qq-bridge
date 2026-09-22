// 全局状态：顶栏状态徽标 + 挂起数量角标。
//
// 这两样是跨分区的（不管你在哪个页面都该看到 DSH 在不在线、有几条挂起审批），
// 所以放在 shell 层轮询；view 通过 'console:status' / 'console:pending' 事件拿快照，
// 需要立刻刷新时调 refreshStatus()。
import { api } from './api.js';
import { every } from './poll.js';
import { $ } from './dom.js';

export const MODE_LABEL = {
  chat: '聊天模式',
  'closed-agent': '封闭 Agent',
  reserved: '一代仿真模式',
  reserved2: '二代仿真模式'
};

let latest = null;
let pending = [];
let onBadge = () => {};

export function getStatus() { return latest; }
export function getPending() { return pending; }

function renderStatusBadge() {
  const el = $('#statusText');
  if (!el) return;
  if (!latest) {
    el.textContent = '桥接不可达（令牌错误或进程未运行）';
    el.classList.add('err');
    return;
  }
  el.classList.remove('err');
  const s = latest;
  el.textContent = 'DSH: ' + (s.dshReady ? '在线' : '离线')
    + ' ｜ 模式: ' + (MODE_LABEL[s.mode] ?? s.mode ?? '-')
    + ' ｜ 管理员: ' + (s.ownerQQ || '未设置')
    + ' ｜ 群白名单: ' + ((s.allowGroups || []).join(', ') || '无')
    + ' ｜ 私聊白名单: ' + ((s.allowPrivate || []).join(', ') || '无');
}

function renderPendingBadge() {
  onBadge(pending.length);
}

export async function refreshStatus() {
  const [status, pend] = await Promise.allSettled([api('/api/status'), api('/api/pending')]);
  latest = status.status === 'fulfilled' ? status.value : null;
  if (pend.status === 'fulfilled') pending = pend.value?.pending ?? [];
  renderStatusBadge();
  renderPendingBadge();
  document.dispatchEvent(new CustomEvent('console:status', { detail: latest }));
  document.dispatchEvent(new CustomEvent('console:pending', { detail: pending }));
  return latest;
}

export function startStatusPoll(ms, badgeHandler) {
  if (typeof badgeHandler === 'function') onBadge = badgeHandler;
  return every(ms, refreshStatus, { immediate: true });
}
