// 全局状态：顶栏状态徽标 + 侧栏状态卡 + 挂起数量角标。
//
// 这几样是跨分区的（不管你在哪个页面都该看到 DSH 在不在线、有几条挂起审批），
// 所以放在 shell 层轮询；view 通过 'console:status' / 'console:pending' 事件拿快照，
// 需要立刻刷新时调 refreshStatus()。
import { api } from './api.js';
import { every } from './poll.js';
import { $ } from './dom.js';

export const MODE_LABEL = {
  reserved2: '聊天模式'
};

let latest = null;
let pending = [];
let onBadge = () => {};

export function getStatus() { return latest; }
export function getPending() { return pending; }

function chip(label, value, { dot = '', title = '', className = '' } = {}) {
  const node = document.createElement('span');
  node.className = 'status-chip' + (className ? ' ' + className : '');
  if (title) node.title = title;
  if (dot) {
    const d = document.createElement('span');
    d.className = 'dot ' + dot;
    node.appendChild(d);
  }
  const key = document.createElement('span');
  key.textContent = label;
  node.appendChild(key);
  const val = document.createElement('b');
  val.textContent = value;
  node.appendChild(val);
  return node;
}

function renderStatusBadge() {
  const el = $('#statusText');
  if (!el) return;
  el.textContent = '';
  el.classList.remove('err');
  if (!latest) {
    el.classList.add('err');
    el.appendChild(chip('桥接', '不可达（令牌错误或进程未运行）', { dot: 'err', className: 'dsh' }));
    return;
  }
  const s = latest;
  const groups = Array.isArray(s.allowGroups) ? s.allowGroups : [];
  const privates = Array.isArray(s.allowPrivate) ? s.allowPrivate : [];
  el.appendChild(chip('DSH', s.dshReady ? '在线' : '离线', {
    dot: s.dshReady ? 'ok' : 'err',
    title: s.dshReady ? 'DeepSeek Harness 已连接' : 'DeepSeek Harness 未连接',
    className: 'dsh'
  }));
  el.appendChild(chip('模式', MODE_LABEL[s.mode] ?? s.mode ?? '-', { className: 'mode' }));
  el.appendChild(chip('管理员', s.ownerQQ ? String(s.ownerQQ) : '未设置', {
    dot: s.ownerQQ ? '' : 'warn',
    title: s.ownerQQ ? 'ownerQQ' : '没有配置管理员，管理类操作会被拒绝',
    className: 'admin'
  }));
  el.appendChild(chip('群', groups.length ? String(groups.length) : '无', { title: groups.join(', ') || '未配置群白名单', className: 'groups' }));
  el.appendChild(chip('私聊', privates.length ? String(privates.length) : '无', { title: privates.join(', ') || '未配置私聊白名单', className: 'privates' }));
  if (s.socialV2Paused) el.appendChild(chip('AI', '已暂停', { dot: 'warn', title: '聊天模式已暂停，agent 工具调用会被拒绝', className: 'paused' }));
}

function renderSideStatus() {
  const el = $('#sideStatus');
  if (!el) return;
  el.textContent = '';
  const dot = document.createElement('span');
  const copy = document.createElement('div');
  copy.className = 'side-status-copy';
  const title = document.createElement('b');
  const detail = document.createElement('span');
  if (!latest) {
    dot.className = 'side-status-dot err';
    title.textContent = '桥接不可达';
    detail.textContent = '检查进程或令牌';
  } else {
    const mode = MODE_LABEL[latest.mode] ?? latest.mode ?? '-';
    dot.className = 'side-status-dot ' + (latest.dshReady ? 'ok' : 'err');
    title.textContent = latest.dshReady ? 'DSH 在线' : 'DSH 离线';
    detail.textContent = mode + (latest.socialV2Paused ? ' · AI 已暂停' : '') + (latest.ownerQQ ? '' : ' · 未设管理员');
  }
  copy.append(title, detail);
  el.append(dot, copy);
}

function renderPendingBadge() {
  onBadge(pending.length);
}

export async function refreshStatus() {
  const [status, pend] = await Promise.allSettled([api('/api/status'), api('/api/pending')]);
  latest = status.status === 'fulfilled' ? status.value : null;
  if (pend.status === 'fulfilled') pending = pend.value?.pending ?? [];
  renderStatusBadge();
  renderSideStatus();
  renderPendingBadge();
  document.dispatchEvent(new CustomEvent('console:status', { detail: latest }));
  document.dispatchEvent(new CustomEvent('console:pending', { detail: pending }));
  return latest;
}

export function startStatusPoll(ms, badgeHandler) {
  if (typeof badgeHandler === 'function') onBadge = badgeHandler;
  return every(ms, refreshStatus, { immediate: true });
}
