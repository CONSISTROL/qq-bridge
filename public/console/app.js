// 控制台入口：注册所有分区 → 建左侧导航 → 起 hash 路由 → 起全局状态轮询。
//
// 新增一个功能分区只需要三步：写 views/xxx.js + views/xxx.html，
// 在这里 import，加进 VIEWS 数组。导航、标题、角标、路由都是自动的。
import { initTheme } from './core/theme.js';
import { captureTokenFromUrl } from './core/api.js';
import { defineView, getViews, startRouter } from './core/router.js';
import { startStatusPoll } from './core/status.js';
import { $ } from './core/dom.js';

import * as overview from './views/overview.js';
import * as social1 from './views/social1.js';
import * as social2 from './views/social2.js';
import * as slang from './views/slang.js';
import * as knowledge from './views/knowledge.js';
import * as memory from './views/memory.js';
import * as images from './views/images.js';
import * as persona from './views/persona.js';
import * as security from './views/security.js';
import * as ops from './views/ops.js';
import * as tools from './views/tools.js';

const VIEWS = [overview, social1, social2, slang, knowledge, memory, images, persona, security, ops, tools];
const GROUP_ORDER = ['总览', '仿真', '语料', '运行', '系统'];
const GROUP_FALLBACK = '系统';

for (const view of VIEWS) defineView(view);

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  nav.textContent = '';
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const view of getViews()) {
    const group = groups.has(view.group) ? view.group : GROUP_FALLBACK;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(view);
  }
  for (const [group, items] of groups) {
    if (!items.length) continue;
    items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    const title = document.createElement('div');
    title.className = 'nav-group-title';
    title.textContent = group;
    nav.appendChild(title);
    for (const view of items) {
      const link = document.createElement('a');
      link.className = 'nav-item';
      link.href = '#/' + view.id;
      link.dataset.view = view.id;

      const ico = document.createElement('span');
      ico.className = 'nav-ico';
      ico.textContent = view.icon ?? '';

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

function highlightNav(view) {
  for (const link of document.querySelectorAll('.nav-item')) {
    link.classList.toggle('active', link.dataset.view === view.id);
  }
  const title = $('#viewTitle');
  if (title) title.textContent = view.title;
  const desc = $('#viewDesc');
  if (desc) desc.textContent = view.desc ?? '';
  document.title = `QQ 桥接控制台 · ${view.title}`;
}

function updatePendingBadge(count) {
  const badge = document.getElementById('navPending');
  if (!badge) return;
  badge.textContent = count > 0 ? String(count) : '';
  badge.style.display = count > 0 ? '' : 'none';
}

initTheme();
captureTokenFromUrl();
renderNav();
startRouter({ root: $('#view-root'), fallback: 'overview', onNavigate: highlightNav });
startStatusPoll(5000, updatePendingBadge);
