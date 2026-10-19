// 插件（总览）：桥接的**声明式插件**清单。
// 插件 = 一个目录 + manifest.json，只能声明两类能力：HTTP 工具、定时任务（不执行任意代码）。
// 来源用**所在目录**判定：plugins/ = 用户添加，state/ai-plugins/ = AI 自己添加。
export const id = 'plugins';
export const title = '动态插件';
export const desc = '声明式插件：用户添加 / AI 添加，各自的工具与定时任务';
export const group = '总览';
export const order = 3;

import { api } from '../core/api.js';
import { $, esc, setMsg, delegate, confirmDanger } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export async function mount(root) {
  const view = await mountFragment(root, 'plugins');
  let plugins = [];

  const render = () => {
    const box = $('#plgList', view);
    if (!box) return;
    const badge = (o) => (o === 'ai' ? '<span class="pill b">AI 添加</span>' : '<span class="pill g">用户添加</span>');
    box.innerHTML = plugins.length ? '' : '<div class="meta">还没有插件。用户插件放 <code>plugins/&lt;id&gt;/manifest.json</code>；AI 自己写会落到 <code>state/ai-plugins/</code>。</div>';
    for (const p of plugins) {
      const card = document.createElement('div');
      card.className = 'plg-card' + (p.enabled ? '' : ' plg-off');
      card.innerHTML = `<div class="plg-head"><b>${esc(p.name)}</b> ${badge(p.origin)} <span class="meta">${esc(p.id)} v${esc(p.version)}</span>`
        + ` <button class="small" type="button" data-plg-toggle="${esc(p.origin)}|${esc(p.id)}|${p.enabled ? '0' : '1'}">${p.enabled ? '禁用' : '启用'}</button></div>`
        + (p.description ? `<div class="meta">${esc(p.description)}</div>` : '')
        + (p.tools.length ? `<div class="meta" style="margin-top:4px">工具：${p.tools.map((t) => `<code>${esc(t.toolName)}</code>`).join(' ')}</div>` : '')
        + (p.jobs.length ? `<div class="meta">定时：${p.jobs.map((j) => `${esc(j.name)}（每 ${j.everyMin} 分）`).join('、')}</div>` : '')
        + `<div class="meta">路径：<code>${esc(p.path)}</code></div>`;
      box.append(card);
    }
  };

  const load = async () => {
    const r = await api('api/plugins', 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setMsg($('#plgMsg', view), '❌ ' + (r.error || '加载失败')); return; }
    plugins = r.plugins || [];
    const c = r.counts || {};
    setMsg($('#plgMsg', view), '');
    const info = $('#plgCounts', view);
    if (info) info.textContent = `用户添加 ${c.user || 0} · AI 添加 ${c.ai || 0}`;
    render();
  };

  delegate(view, 'click', '[data-plg-toggle]', async (ev, btn) => {
    const [origin, id, want] = btn.dataset.plgToggle.split('|');
    btn.disabled = true;
    const r = await api('api/plugins/toggle', 'POST', { origin, id, enabled: want === '1', by: 'console' }).catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    setMsg($('#plgMsg', view), r.ok ? '✅ 已切换' : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });

  const loadPending = async () => {
    const box = $('#plgPending', view);
    if (!box) return;
    const r = await api('api/ai-plugins/pending', 'GET').catch(() => null);
    const pending = Object.values((r && r.pending) || {});
    if (!pending.length) { box.innerHTML = '<div class="meta">没有待批准的 AI 插件。</div>'; return; }
    box.innerHTML = '';
    for (const p of pending) {
      const card = document.createElement('div');
      card.className = 'plg-card';
      const m = p.manifest || {};
      const tests = (p.testResults || []).map((t) => `${t.tool}: HTTP ${t.status}${t.ok ? ' ✅' : ' ❌'}`).join(' · ');
      card.innerHTML = `<div class="plg-head"><b>${esc(m.name || p.id)}</b> <span class="pill b">AI 添加</span> <span class="meta">${esc(p.id)}</span>`
        + ` <button class="small" type="button" data-plg-approve="${esc(p.id)}">批准启用</button>`
        + ` <button class="small danger" type="button" data-plg-reject="${esc(p.id)}">拒绝并删除</button></div>`
        + (m.description ? `<div class="meta">${esc(m.description)}</div>` : '')
        + `<div class="meta">工具：${(m.tools || []).map((t) => esc(t.name)).join(', ') || '无'}</div>`
        + (tests ? `<div class="meta">自测：${esc(tests)}</div>` : '<div class="meta">还没自测</div>');
      box.append(card);
    }
  };
  delegate(view, 'click', '[data-plg-approve]', async (ev, btn) => {
    const r = await api('api/ai-plugins/approve', 'POST', { id: btn.dataset.plgApprove, approve: true }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#plgMsg', view), r.ok ? '✅ 已批准并启用' : ('❌ ' + (r.error || '失败')));
    await loadPending(); await load();
  });
  delegate(view, 'click', '[data-plg-reject]', async (ev, btn) => {
    if (!confirmDanger('拒绝并删除这个 AI 插件？')) return;
    const r = await api('api/ai-plugins/approve', 'POST', { id: btn.dataset.plgReject, approve: false }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#plgMsg', view), r.ok ? '✅ 已拒绝并删除' : ('❌ ' + (r.error || '失败')));
    await loadPending(); await load();
  });
  await loadPending();
  await load();
  return () => {};
}
