// 控制台入口：注册所有分区 → 建导航（桌面侧栏 + 手机底栏/抽屉）→ 起 hash 路由 → 状态轮询。
//
// 新增一个功能分区只需要三步：写 views/xxx.js + views/xxx.html，
// 在这里 import，加进 VIEWS 数组。导航、标题、角标、路由都是自动的。
import { initTheme } from './core/theme.js';
import { captureTokenFromUrl } from './core/api.js';
import { defineView, getViews, startRouter } from './core/router.js';
import { startStatusPoll } from './core/status.js';
import { $, autoGrowTextareas } from './core/dom.js';
import { iconElement } from './core/icons.js';

import * as overview from './views/overview.js';
import * as chat from './views/chat.js';
import * as memorydb from './views/memorydb.js';
import * as album from './views/album.js';
import * as voicepack from './views/voicepack.js';
import * as persona from './views/persona.js';
import * as autonomy from './views/autonomy.js';
import * as security from './views/security.js';
import * as ops from './views/ops.js';
import * as tools from './views/tools.js';
import * as plugins from './views/plugins.js';
import * as capabilities from './views/capabilities.js';
import * as mc from './views/mc.js';

const VIEWS = [overview, chat, memorydb, album, voicepack, persona, autonomy, security, ops, tools, capabilities, plugins, mc];
const GROUP_ORDER = ['总览', '仿真', '语料', '运行', '扩展', '系统'];
const GROUP_FALLBACK = '系统';
// 手机底栏只放最常用的四个分区；其余进「更多」抽屉。
const MOBILE_PRIMARY = [
  ['overview', '总览'],
  ['chat', '聊天'],
  ['memorydb', '记忆'],
  ['album', '相册']
];

for (const view of VIEWS) defineView(view);
// 长文本框自动随内容长高（长提示词/备注不用在小框里滚）
autoGrowTextareas();

function groupedViews() {
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const view of getViews()) {
    const group = groups.has(view.group) ? view.group : GROUP_FALLBACK;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(view);
  }
  for (const items of groups.values()) items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return groups;
}

function makeIcon(name, size = 18) {
  return iconElement(name || 'dot', { size });
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  nav.textContent = '';
  for (const [group, items] of groupedViews()) {
    if (!items.length) continue;
    const title = document.createElement('div');
    title.className = 'nav-group-title';
    title.textContent = group;
    nav.appendChild(title);
    for (const view of items) {
      const link = document.createElement('a');
      link.className = 'nav-item';
      link.href = '#/' + view.id;
      link.dataset.view = view.id;
      link.setAttribute('aria-label', view.title);

      const ico = document.createElement('span');
      ico.className = 'nav-ico';
      ico.appendChild(makeIcon(view.icon, 18));

      const label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = view.title;

      link.append(ico, label);
      if (view.badge) {
        const badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.id = view.badge;
        badge.style.display = 'none';
        link.appendChild(badge);
      }
      nav.appendChild(link);
    }
  }
}

function renderMobileBar() {
  const bar = $('#mobileBar');
  if (!bar) return;
  bar.textContent = '';
  const byId = new Map(getViews().map((v) => [v.id, v]));
  for (const [id, label] of MOBILE_PRIMARY) {
    const view = byId.get(id);
    if (!view) continue;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'mobile-tab';
    tab.dataset.view = id;
    tab.setAttribute('aria-label', view.title);
    const ico = document.createElement('span');
    ico.className = 'mobile-ico';
    ico.appendChild(makeIcon(view.icon, 22));
    const text = document.createElement('span');
    text.className = 'mobile-label';
    text.textContent = label;
    tab.append(ico, text);
    if (view.badge) {
      const badge = document.createElement('span');
      badge.className = 'mobile-badge';
      badge.id = 'mobilePending';
      badge.style.display = 'none';
      tab.appendChild(badge);
    }
    bar.appendChild(tab);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'mobile-tab';
  more.id = 'mobileMore';
  more.setAttribute('aria-label', '更多分区');
  const ico = document.createElement('span');
  ico.className = 'mobile-ico';
  ico.appendChild(makeIcon('more', 22));
  const text = document.createElement('span');
  text.className = 'mobile-label';
  text.textContent = '更多';
  more.append(ico, text);
  bar.appendChild(more);
}

function renderSheet() {
  const grid = $('#sheetGrid');
  if (!grid) return;
  grid.textContent = '';
  for (const [group, items] of groupedViews()) {
    if (!items.length) continue;
    const title = document.createElement('div');
    title.className = 'sheet-group-title';
    title.textContent = group;
    grid.appendChild(title);
    for (const view of items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sheet-item';
      item.dataset.view = view.id;
      const ico = document.createElement('span');
      ico.className = 'sheet-ico';
      ico.appendChild(makeIcon(view.icon, 20));
      const copy = document.createElement('span');
      copy.className = 'sheet-copy';
      const name = document.createElement('b');
      name.textContent = view.title;
      const desc = document.createElement('span');
      desc.textContent = view.desc ?? '';
      copy.append(name, desc);
      item.append(ico, copy);
      grid.appendChild(item);
    }
  }
}

function setSheetOpen(open) {
  const sheet = $('#mobileSheet');
  const backdrop = $('#sheetBackdrop');
  if (!sheet || !backdrop) return;
  sheet.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  document.body.classList.toggle('sheet-open', open);
  sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function highlightNav(view) {
  const activeEls = [];
  for (const link of document.querySelectorAll('.nav-item, .mobile-tab[data-view]')) {
    const on = link.dataset.view === view.id;
    link.classList.toggle('active', on);
    if (on) activeEls.push(link);
  }
  for (const item of document.querySelectorAll('.sheet-item')) {
    item.classList.toggle('active', item.dataset.view === view.id);
  }
  const more = document.getElementById('mobileMore');
  if (more) more.classList.toggle('active', !MOBILE_PRIMARY.some(([id]) => id === view.id));
  setSheetOpen(false);

  const pageIcon = $('#viewIcon');
  if (pageIcon) {
    pageIcon.textContent = '';
    pageIcon.appendChild(makeIcon(view.icon, 20));
  }
  const title = $('#viewTitle');
  if (title) title.textContent = view.title;
  const desc = $('#viewDesc');
  if (desc) desc.textContent = view.desc ?? '';
  document.title = `鱼群bot 控制台 · ${view.title}`;
}

function updatePendingBadge(count) {
  for (const id of ['navPending', 'mobilePending']) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.textContent = count > 0 ? String(count) : '';
    badge.style.display = count > 0 ? '' : 'none';
  }
}

function bindMobileNav() {
  const bar = $('#mobileBar');
  const more = $('#mobileMore');
  const sheet = $('#mobileSheet');
  const backdrop = $('#sheetBackdrop');
  if (bar) {
    bar.addEventListener('click', (ev) => {
      const tab = ev.target instanceof Element ? ev.target.closest('[data-view]') : null;
      if (tab) location.hash = '#/' + tab.dataset.view;
    });
  }
  if (more) more.addEventListener('click', () => setSheetOpen(true));
  if (sheet) {
    sheet.addEventListener('click', (ev) => {
      const close = ev.target instanceof Element ? ev.target.closest('[data-sheet-close]') : null;
      if (close) { setSheetOpen(false); return; }
      const item = ev.target instanceof Element ? ev.target.closest('.sheet-item') : null;
      if (item) { setSheetOpen(false); location.hash = '#/' + item.dataset.view; }
    });
  }
  if (backdrop) backdrop.addEventListener('click', () => setSheetOpen(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') setSheetOpen(false);
  });
}

// 表单控件的视觉标签大多没有 for/id 关联；这里按所在行补 aria-label，读屏也能用。
function labelFormControls(root = document) {
  const setLabels = (row, labelEl) => {
    const text = labelEl?.textContent?.trim();
    if (!text) return;
    for (const ctl of row.querySelectorAll('input, select, textarea')) {
      if (ctl.closest('label') || ctl.getAttribute('aria-label')) continue;
      ctl.setAttribute('aria-label', text);
    }
  };
  for (const row of root.querySelectorAll('.form-row')) setLabels(row, row.querySelector(':scope > label'));
  for (const field of root.querySelectorAll('.field')) setLabels(field, field.querySelector(':scope > label'));
  for (const pair of root.querySelectorAll('.field-pair')) setLabels(pair, pair.querySelector(':scope > .field-label'));
}
labelFormControls();
const viewRoot = $('#view-root');
if (viewRoot && typeof MutationObserver === 'function') {
  let labelTimer = null;
  new MutationObserver(() => {
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => labelFormControls(), 80);
  }).observe(viewRoot, { childList: true, subtree: true });
}

initTheme();
captureTokenFromUrl();
renderNav();
renderMobileBar();
renderSheet();
bindMobileNav();
startRouter({ root: $('#view-root'), fallback: 'overview', onNavigate: highlightNav });
startStatusPoll(5000, updatePendingBadge);
