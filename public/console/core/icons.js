// 控制台图标：一套 24×24、1.7px 线宽的 iOS 风格线性图标。
//
// 为什么自己画：原来导航和状态里用的是 emoji（📊 🧩 🌙…），不同系统字体会长得完全不一样，
// 深色主题下颜色也不受控。这里用 currentColor + 统一线宽，和文字/主题完全同步。
const PATHS = {
  overview: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  chat: '<path d="M20.5 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4.5 2.5.6-4.2A7.5 7.5 0 0 1 8.5 4h4.5a7.5 7.5 0 0 1 7.5 7.5Z"/><circle cx="9" cy="11.5" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="11.5" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="11.5" r=".9" fill="currentColor" stroke="none"/>',
  memory: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m5.5 18 4.2-4.2 3 3 2.6-2.6 3.2 3.8"/>',
  voice: '<path d="M4 10.5v3M8 7.5v9M12 4.5v15M16 8v8M20 10.5v3"/>',
  persona: '<circle cx="11" cy="8" r="3.4"/><path d="M4.5 20c.5-3.6 3.2-5.7 6.5-5.7s6 2.1 6.5 5.7"/><path d="M18.5 4v3M17 5.5h3"/>',
  autonomy: '<circle cx="12" cy="12" r="8.6"/><path d="m15 9-1.6 4.4L9 15l1.6-4.4L15 9Z"/>',
  security: '<path d="M12 3.2 5 6v5.4c0 4.2 2.9 7.2 7 9.4 4.1-2.2 7-5.2 7-9.4V6l-7-2.8Z"/><path d="m9.2 11.8 2 2 3.8-3.8"/>',
  ops: '<path d="M4 7h8M17 7h3M4 12h3M10.5 12H20M4 17h11M20 17h-1"/><circle cx="14.5" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="17.5" cy="17" r="2"/>',
  tools: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7.5 9 3 3-3 3M13 15h3.5"/>',
  capabilities: '<rect x="3" y="4.8" width="18" height="6" rx="3"/><circle cx="16.5" cy="7.8" r="1.7" fill="currentColor" stroke="none"/><rect x="3" y="13.2" width="18" height="6" rx="3"/><circle cx="7.5" cy="16.2" r="1.7" fill="currentColor" stroke="none"/>',
  plugins: '<path d="M9 7V4.5M15 7V4.5M6.5 7h11v4.2a5.5 5.5 0 0 1-5.5 5.5 5.5 5.5 0 0 1-5.5-5.5V7ZM12 16.7V21"/>',
  cube: '<path d="m12 3 8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z"/><path d="m4.4 7.6 7.6 4.2 7.6-4.2M12 11.8V21"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 13.6A8.2 8.2 0 0 1 10.4 4 7.7 7.7 0 1 0 20 13.6Z"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3.5 3.2 20h17.6L12 3.5Z"/><path d="M12 9.5v4.5M12 17.4v.1"/>',
  info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11v5M12 8v.1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 4.1 4.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14.5V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.5"/>',
  inbox: '<path d="M4 5h16v9h-4l-2 3h-4l-2-3H4V5Z"/><path d="M4 14v5h16v-5"/>',
  pin: '<path d="M9 3h6l-1 5 4 4v2h-5v7l-1 1-1-1v-7H6v-2l4-4-1-5Z"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.9A5.5 5.5 0 0 1 17 8.7 3.7 3.7 0 0 1 16.5 18H7Z"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9V4Z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.5 3.4-5.5 7-5.5s6.4 2 7 5.5"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3V9Z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.4-3.2 2.8-5 5.5-5s5.1 1.8 5.5 5"/><path d="M16 5.5a3 3 0 0 1 0 6M17 14.2c2.1.4 3.5 2 3.8 4.8"/>',
  tasks: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="m8.5 9 1.5 1.5L13 7.5M8.5 15h7"/>',
  globe: '<circle cx="12" cy="12" r="8.8"/><path d="M3.5 12h17M12 3.2c2.3 2.4 3.5 5.4 3.5 8.8s-1.2 6.4-3.5 8.8c-2.3-2.4-3.5-5.4-3.5-8.8S9.7 5.6 12 3.2Z"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="3"/><path d="M10.5 5.5h3M11 18.5h2"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'
};

const DEFAULT_ICON = 'dot';

export function iconSvg(name, { size = 18, className = '', strokeWidth = 1.7 } = {}) {
  const body = PATHS[name] || PATHS[DEFAULT_ICON];
  const cls = className ? ` ${className}` : '';
  return `<svg class="ico${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function iconElement(name, options = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'ico-wrap';
  wrap.innerHTML = iconSvg(name, options);
  return wrap.firstElementChild;
}

export function hasIcon(name) { return Object.hasOwn(PATHS, name); }

export const ICON_NAMES = Object.keys(PATHS);
