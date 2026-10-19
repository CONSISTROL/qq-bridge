// 插件（独立页）：桥接的「插件 → 能力」开关。
//
// 从「聊天模式」里拆出来的：工具开关本来就是"这个 bot 有哪些能力"，跟聊天参数不是一类东西，
// 混在一个长页面里既难找也容易误改。这里按插件分组：插件整组开关 + 组内每项能力单独开关；
// 标了（基础）的能力跟着插件开关走，不给单独开关。
export const id = 'capabilities';
export const title = '插件';
export const desc = '它有哪些能力：按插件分组，逐项开关（拨动即写入 config.json 并立即生效）';
export const icon = '🧩';
export const group = '总览';
export const order = 4;

import { api } from '../core/api.js';
import { $, toast, delegate } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export async function mount(root) {
  const view = await mountFragment(root, 'capabilities');

  const render = (plugins) => {
    const box = $('#capList', view);
    if (!box) return;
    box.textContent = '';
    for (const p of plugins) {
      const card = document.createElement('div');
      card.className = 'v2-plugin' + (p.enabled ? '' : ' off');
      const head = document.createElement('div');
      head.className = 'v2-plugin-head';
      const capOn = p.capabilities.filter((c) => c.enabled).length;
      head.innerHTML = `<b>${p.icon || ''} ${p.name}</b> <span class="meta">${capOn}/${p.capabilities.length} 项</span>`;
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'switch';
      sw.checked = p.enabled;
      sw.addEventListener('change', () => setPlugin(p.id, null, sw.checked));
      head.append(sw);
      const desc = document.createElement('div');
      desc.className = 'meta';
      desc.textContent = p.desc || '';
      const grid = document.createElement('div');
      grid.className = 'v2-cap-grid';
      for (const c of p.capabilities) {
        const lab = document.createElement('label');
        lab.className = 'v2-cap' + (c.base ? ' v2-cap-base' : '');
        if (c.base) {
          lab.append(document.createTextNode('· ' + c.label + '（基础）'));
        } else {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'switch';
          cb.checked = c.enabled;
          cb.addEventListener('change', () => setPlugin(p.id, c.id, cb.checked));
          lab.append(cb, document.createTextNode(' ' + c.label));
        }
        grid.append(lab);
      }
      card.append(head, desc, grid);
      box.append(card);
    }
  };

  const load = async () => {
    const r = await api('/api/socialV2/plugins', 'GET').catch(() => null);
    if (!r || !r.ok) {
      const box = $('#capList', view);
      if (box) box.innerHTML = '<div class="meta">插件清单加载失败</div>';
      return [];
    }
    render(r.plugins || []);
    const info = $('#capCounts', view);
    if (info) {
      const on = (r.plugins || []).filter((p) => p.enabled).length;
      info.textContent = `${on} / ${(r.plugins || []).length} 个插件已启用`;
    }
    return r.plugins || [];
  };

  const setPlugin = async (plugin, capability, enabled) => {
    const r = await api('/api/socialV2/plugins', 'POST', { plugin, capability: capability || '', enabled }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ ' + ((r && r.error) || '保存失败'), 'err'); return; }
    render(r.plugins || []);
    const info = $('#capCounts', view);
    if (info) info.textContent = `${(r.plugins || []).filter((p) => p.enabled).length} / ${(r.plugins || []).length} 个插件已启用`;
  };

  delegate(view, 'click', '#capAllOn', async () => {
    const r = await api('/api/socialV2/plugins', 'POST', { bulk: 'all', enabled: true }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ ' + ((r && r.error) || '保存失败'), 'err'); return; }
    render(r.plugins || []);
    toast('已启用全部插件能力（高危项仍保持关闭）', 'ok');
  });
  delegate(view, 'click', '#capAllOff', async () => {
    const r = await api('/api/socialV2/plugins', 'POST', { bulk: 'all', enabled: false }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ ' + ((r && r.error) || '保存失败'), 'err'); return; }
    render(r.plugins || []);
    toast('已禁用全部插件能力', 'ok');
  });

  await load();
  return () => {};
}
