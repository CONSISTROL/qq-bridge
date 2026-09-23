// B站视频理解：元数据 / 字幕（文字稿）/ 画面（雪碧图抽帧）。
//
// 为什么这条路值得做（全部实测过，见 docs 第二十节）：
//   * 字幕：B站自己生成了 AI 中文字幕，等于把「听」这一层直接变成文字。
//     不需要下载视频、不需要 ffmpeg、不需要 ASR。49 分钟复盘 ≈ 6700 字 ≈ 4700 token。
//   * 画面：B站为每个视频都生成了进度条预览雪碧图（videoshot），
//     6 张图 = 600 帧、每帧 480×270、带 589 个时间戳、覆盖全片，总共只要约 6MB。
//     实测画面可得 8/8，字幕可得 5/8 —— 所以两者互补。
//   * 真实的成本不是带宽，是**视觉 token**：600 帧约 60 万 token，不可能全看。
//     所以对外只暴露「按时间点取几帧」的接口，配合字幕的时间戳来定位。
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** 雪碧图磁盘缓存：同一视频反复取帧不必重复下载 */
function createSheetCache(dir, maxBytes = 200 * 1024 * 1024) {
  fs.mkdirSync(dir, { recursive: true });
  const inflight = new Map();
  function totalBytes() {
    try {
      return fs.readdirSync(dir).reduce((s, f) => s + (fs.statSync(path.join(dir, f)).size || 0), 0);
    } catch { return 0; }
  }
  function evict() {
    try {
      const files = fs.readdirSync(dir)
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs, s: fs.statSync(path.join(dir, f)).size }))
        .sort((a, b) => a.t - b.t);
      let total = files.reduce((s, x) => s + x.s, 0);
      for (const x of files) {
        if (total <= maxBytes) break;
        fs.unlinkSync(path.join(dir, x.f));
        total -= x.s;
      }
    } catch { /* 清理失败不影响主流程 */ }
  }
  return {
    async get(key, fetcher) {
      const file = path.join(dir, key);
      if (fs.existsSync(file)) {
        try { fs.utimesSync(file, new Date(), new Date()); return fs.readFileSync(file); } catch { /* 读失败就重新下 */ }
      }
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        const buf = await fetcher();
        try { fs.writeFileSync(file, buf); evict(); } catch { /* 缓存写失败不影响返回 */ }
        return buf;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }
  };
}

export function createVideoTools({ root, client, log = () => {}, cacheMB = 200 }) {
  const cache = createSheetCache(path.join(root, 'state', 'video-cache'), Math.max(16, Number(cacheMB) || 200) * 1024 * 1024);

  const api = (url, params) => client.api(url, params);
  const j = (r, what) => {
    if (r?.json?.code !== 0) throw new Error(`${what}失败：code=${r?.json?.code} ${r?.json?.message ?? ''}`);
    return r.json.data;
  };

  /** bvid → {aid, cid, title, desc, duration, owner, stat, pages} */
  async function meta(bvid) {
    const d = j(await api('https://api.bilibili.com/x/web-interface/view', { bvid }), '取视频信息');
    return {
      bvid,
      aid: d.aid,
      cid: d.cid,
      title: String(d.title || ''),
      desc: String(d.desc || '').slice(0, 500),
      duration: Number(d.duration) || 0,
      owner: d.owner?.name || '',
      pubdate: d.pubdate || 0,
      stat: { view: d.stat?.view ?? 0, danmaku: d.stat?.danmaku ?? 0, reply: d.stat?.reply ?? 0, like: d.stat?.like ?? 0 },
      pic: d.pic || ''
    };
  }

  /** 字幕：返回 [{from,to,text}] + 全文。没有字幕返回 available:false（不是错误）。 */
  async function subtitle(bvid, { offset = 0, limit = 0 } = {}) {
    const m = await meta(bvid);
    // 必须用 wbi 版：非 wbi 版返回的 subtitle_url 是过期的（实测两版 URL 不同，旧的那个取不到）
    const p = await api('https://api.bilibili.com/x/player/wbi/v2', { aid: m.aid, cid: m.cid });
    const subs = p?.json?.data?.subtitle?.subtitles || [];
    if (!subs.length) return { ...m, available: false, reason: '该视频没有字幕（可能是无解说的集锦/纯操作）' };
    // 优先人工/中文，其次任意
    const pick = subs.find((s) => s.lan === 'zh-CN') || subs.find((s) => String(s.lan).startsWith('zh')) || subs[0];
    const url = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url;
    const body = (await api(url))?.json?.body || [];
    const segments = body.map((x) => ({ from: Math.round(Number(x.from) || 0), to: Math.round(Number(x.to) || 0), text: String(x.content || '') }));
    const full = segments.map((s) => s.text).join('');
    const sliced = limit > 0 ? segments.slice(offset, offset + limit) : segments.slice(offset);
    return {
      ...m,
      available: true,
      lan: pick.lan,
      lanDoc: pick.lan_doc || pick.lan,
      chars: full.length,
      tokensEst: Math.round(full.length * 0.7),
      total: segments.length,
      offset,
      returned: sliced.length,
      text: sliced.map((s) => s.text).join(''),
      segments: sliced
    };
  }

  /** 雪碧图信息（不下载）：{sheets, index[], frameW, frameH, cols, rows, count} */
  async function storyboard(bvid) {
    const m = await meta(bvid);
    const fetchShot = () => api('https://api.bilibili.com/x/player/videoshot', { aid: m.aid, cid: m.cid, index: 1 });
    let d = j(await fetchShot(), '取预览图');
    // 实测：这个接口约 1/4 概率返回 image 但 index 为空数组。index 没有就选不出帧，
    // 所以先重试一次（多数情况第二次就有了）。
    let synthesized = false;
    if (!(d.index || []).length) {
      try {
        const again = j(await fetchShot(), '取预览图(重试)');
        if ((again.index || []).length) d = again;
      } catch { /* 重试失败就走下面的合成 */ }
    }
    const sheets = d.image || [];
    const cols = Number(d.img_x_len) || 10;
    const rows = Number(d.img_y_len) || 10;
    let index = d.index || [];
    if (!index.length && sheets.length) {
      // 仍然为空：B站的采样是固定的 5 秒一格，按这个合成时间戳（标记为估算）。
      // 帧数上限取 floor(时长/5)+1，正好对上实测的 589（2937 秒的视频）。
      const cap = Math.min(sheets.length * cols * rows, Math.floor((Number(m.duration) || 0) / 5) + 1);
      index = Array.from({ length: Math.max(0, cap) }, (_, i) => i * 5);
      synthesized = index.length > 0;
      if (synthesized) log(`[video] videoshot 未返回 index，已按 5 秒采样合成 ${index.length} 个时间点（估算）`);
    }
    return {
      ...m,
      sheets,
      index,
      cols,
      rows,
      indexSynthesized: synthesized || undefined,
      frameW: Number(d.img_x_size) || 0,
      frameH: Number(d.img_y_size) || 0,
      count: index.length || sheets.length * 100,
      available: sheets.length > 0
    };
  }

  /** 取第 i 帧在雪碧图里的位置（i 是 index 数组下标） */
  function locate(sb, i) {
    const per = sb.cols * sb.rows;
    const sheet = Math.floor(i / per);
    const within = i % per;
    return { sheet, col: within % sb.cols, row: Math.floor(within / sb.cols), url: sb.sheets[sheet] };
  }

  /**
   * 取离 atSeconds 最近的 count 帧。
   * spread>0 时以该时间点为中心向两侧摊开取，便于看一段过程。
   */
  async function frames(bvid, { atSeconds = 0, count = 4, spreadSeconds = 0, withSharp = true } = {}) {
    const sb = await storyboard(bvid);
    if (!sb.available) return { ...sb, images: [], reason: '该视频没有预览图' };
    const n = Math.max(1, Math.min(12, Number(count) || 4));
    const idx = sb.index;
    // 用二分找最接近 atSeconds 的那一帧
    let center = 0;
    for (let lo = 0, hi = idx.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (idx[mid] < atSeconds) { center = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    // 时间相近时挑更接近的
    if (center + 1 < idx.length && Math.abs(idx[center + 1] - atSeconds) < Math.abs(idx[center] - atSeconds)) center++;
    const step = spreadSeconds > 0
      ? Math.max(1, Math.round(spreadSeconds / Math.max(1, (idx[1] - idx[0]) || 5)))
      : 1;
    const picks = [];
    const half = Math.floor(n / 2);
    for (let k = 0; k < n; k++) {
      const i = center + (k - half) * step;
      if (i >= 0 && i < idx.length) picks.push(i);
    }
    const images = [];
    const failures = [];
    for (const i of picks) {
      const loc = locate(sb, i);
      if (!loc.url) continue;
      const url = loc.url.startsWith('//') ? `https:${loc.url}` : loc.url;
      try {
        const buf = await cache.get(`${sb.cid}-${loc.sheet}.jpg`, () => client.fetchBuffer(url));
        let out = buf;
        let mimeType = 'image/jpeg';
        if (withSharp) {
          out = await sharp(buf)
            .extract({ left: loc.col * sb.frameW, top: loc.row * sb.frameH, width: sb.frameW, height: sb.frameH })
            .png().toBuffer();
          mimeType = 'image/png';
        }
        images.push({ at: idx[i], mimeType, data: out.toString('base64'), bytes: out.length });
      } catch (error) {
        failures.push({ at: idx[i], error: String(error?.message ?? error) });
        log(`[video] 取帧失败 ${bvid}@${idx[i]}s：${error?.message ?? error}`);
      }
    }
    return {
      ...sb, requestedAt: atSeconds, images,
      // 空结果时把「选了哪几帧、为什么失败」带出去，便于排查而不是静默返回空
      pickedAt: picks.map((i) => idx[i]),
      failures: failures.length ? failures : undefined
    };
  }

  return { meta, subtitle, storyboard, frames };
}
