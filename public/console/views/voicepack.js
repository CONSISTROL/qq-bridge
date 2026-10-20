// 语音包（语料）：目标音色的参考音频，可以从 B站视频直接抽一段加进来。
export const id = 'voicepack';
export const title = '语音包';
export const desc = '目标音色的参考音频（可从 B站视频抽取），供 TTS/变声参考';
export const icon = 'voice';
export const group = '语料';
export const order = 12;

import { api } from '../core/api.js';
import { $, esc, setMsg, confirmDanger, delegate } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');

export async function mount(root) {
  const view = await mountFragment(root, 'voicepack');
  let packs = [];

  const render = () => {
    const box = $('#vpList', view);
    if (!box) return;
    box.innerHTML = packs.length ? '' : '<div class="empty">还没有语音包<br><b>先在上方建一个包</b>，再从 B站视频抽音频。</div>';
    for (const p of packs) {
      const card = document.createElement('div');
      card.className = 'vp-card';
      card.innerHTML = `<div class="vp-head"><b>${esc(p.name)}</b> <span class="meta">${esc(p.id)} · ${p.clips.length} 段 / ${fmtBytes(p.bytes)}</span></div>`
        + (p.notes ? `<div class="meta">${esc(p.notes)}</div>` : '')
        + `<div class="vp-clips">${p.clips.map((c) => `<div class="vp-clip"><span class="meta">${esc(c.file)}</span><audio controls preload="none" src="api/voice-packs/file?pack=${encodeURIComponent(p.id)}&file=${encodeURIComponent(c.file)}"></audio><button class="small danger" type="button" data-vp-del="${esc(p.id)}|${esc(c.file)}">删</button></div>`).join('')}</div>`
        + `<div class="row" style="gap:6px;margin-top:6px"><button class="small danger" type="button" data-vp-rmpack="${esc(p.id)}">删整个包</button></div>`;
      box.append(card);
    }
  };

  const load = async () => {
    const r = await api('api/voice-packs', 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setMsg($('#vpMsg', view), '❌ ' + (r.error || '加载失败')); return; }
    packs = r.packs || [];
    render();
  };

  delegate(view, 'click', '#vpCreate', async () => {
    const name = $('#vpName', view).value.trim();
    if (!name) { setMsg($('#vpMsg', view), '先填名字'); return; }
    const r = await api('api/voice-packs/create', 'POST', { name, notes: $('#vpNotes', view).value.trim() }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#vpMsg', view), r.ok ? '✅ 已创建' : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });
  delegate(view, 'click', '#vpAddBili', async () => {
    const pack = $('#vpPackSel', view).value;
    const bvid = $('#vpBvid', view).value.trim();
    if (!pack || !bvid) { setMsg($('#vpMsg', view), '选包 + 填 B站 bvid/链接'); return; }
    setMsg($('#vpMsg', view), '下载并抽取音频中…');
    const r = await api('api/voice-packs/add-bili', 'POST', {
      pack, bvid,
      startSec: Number($('#vpStart', view).value) || 0,
      durationSec: Number($('#vpDur', view).value) || 30
    }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#vpMsg', view), r.ok ? `✅ 已加入（${fmtBytes(r.bytes)}）` : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });
  delegate(view, 'click', '[data-vp-del]', async (ev, btn) => {
    const [pack, file] = btn.dataset.vpDel.split('|');
    if (!confirmDanger('删掉这段音频？')) return;
    const r = await api('api/voice-packs/remove-clip', 'POST', { pack, file }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#vpMsg', view), r.ok ? '✅ 已删除' : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });
  delegate(view, 'click', '[data-vp-rmpack]', async (ev, btn) => {
    if (!confirmDanger(`删除语音包 ${btn.dataset.vpRmpack}？里面所有音频都会删掉。`)) return;
    const r = await api('api/voice-packs/remove', 'POST', { pack: btn.dataset.vpRmpack }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#vpMsg', view), r.ok ? '✅ 已删除' : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });

  await load();
  const sel = $('#vpPackSel', view);
  const fillSel = () => { if (!sel) return; sel.innerHTML = packs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); };
  fillSel();
  const obs = setInterval(() => { if (sel && sel.options.length !== packs.length) fillSel(); }, 1500);
  return () => clearInterval(obs);
}
