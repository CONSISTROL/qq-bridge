// bili.js — B 站只读接口的共用逻辑（wbi 签名 + 关键词搜索 + cookie 读取）
//
// 实测（2026-09，无登录）：
//   搜索视频/专栏 ✅ 需要 wbi 签名；带 buvid3/buvid4 能显著降低风控概率
//   评论区图片   ✅ x/v2/reply/wbi/main
//   动态（opus） ✅ x/polymer/web-dynamic/v1/opus/feed/space（详情接口 -352 需登录）
//   专栏        ✅ x/article/viewinfo
//   旧动态接口   ❌ x/polymer/web-dynamic/v1/feed/space 无登录固定 412
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeFetchBuffer } from './safe-fetch.js';
import { describeAnimation } from './image-meta.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const md5 = (s) => createHash('md5').update(s).digest('hex');

/** 读 state/bili-cookie.txt（支持只写 SESSDATA 值或完整 cookie 串）。 */
export function readBiliCookie(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'state', 'bili-cookie.txt'), 'utf8').trim();
    if (!raw) return '';
    return raw.includes('=') ? raw : `SESSDATA=${raw}`;
  } catch { return ''; }
}

export function createBiliClient({ cookie = '', timeoutMs = 20000 } = {}) {
  let jar = cookie;
  let wbi = null;

  async function api(url, params = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    const res = await fetch(u, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com', ...(jar ? { cookie: jar } : {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 风控页/HTML */ }
    return { status: res.status, json, text, url: String(u) };
  }

  /** 没有 cookie 时先拿 buvid3/buvid4，降低 -352 概率。 */
  async function ensureCookie() {
    if (jar) return;
    try {
      const r = await api('https://api.bilibili.com/x/frontend/finger/spi');
      const b3 = r.json?.data?.b_3, b4 = r.json?.data?.b_4;
      if (b3) jar = `buvid3=${b3}; buvid4=${b4 || ''}`;
    } catch { /* 无 cookie 也能跑大部分接口 */ }
  }

  async function wbiQuery(params) {
    if (!wbi || Date.now() - wbi.at > 3600_000) {
      const r = await api('https://api.bilibili.com/x/web-interface/nav');
      const keyOf = (u) => (String(u).split('/').pop() || '').split('.')[0];
      const raw = keyOf(r.json?.data?.wbi_img?.img_url) + keyOf(r.json?.data?.wbi_img?.sub_url);
      if (raw.length < 64) throw new Error('wbi key 获取失败（nav 返回异常）');
      wbi = { mixin: MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32), at: Date.now() };
    }
    const q = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(q).filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== '')
      .sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(q[k]).replace(/[!'()*]/g, ''))}`).join('&');
    return { ...q, w_rid: md5(query + wbi.mixin) };
  }

  const normPic = (u) => String(u || '').replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://');

  /** 某个视频的评论正文（按点赞排序，梗的用法/出处都在这里）。 */
  async function commentTexts(aid, { pages = 1, limit = 20 } = {}) {
    const out = [];
    let next = 0;
    for (let p = 0; p < Math.max(1, pages); p++) {
      const r = await api('https://api.bilibili.com/x/v2/reply/wbi/main',
        await wbiQuery({ oid: aid, type: 1, mode: 3, next, ps: 20, plat: 1, web_location: 1315875 }));
      if (r.status === 412 || r.json?.code !== 0) break;
      const data = r.json.data || {};
      for (const reply of [...(data.replies || []), ...(data.top_replies || [])]) {
        const text = String(reply.content?.message || '').replace(/\s+/g, ' ').trim();
        if (text) out.push({ text: text.slice(0, 160), like: reply.like ?? 0, author: reply.member?.uname || '' });
      }
      next = data.cursor?.next ?? 0;
      if (!next) break;
    }
    return out.sort((a, b) => b.like - a.like).slice(0, limit);
  }

  /** 某个视频的评论区图片（oid = aid，type=1）。 */
  async function commentImages(aid, { pages = 1, mode = 3 } = {}) {
    const out = [];
    let next = 0;
    for (let p = 0; p < Math.max(1, pages); p++) {
      const r = await api('https://api.bilibili.com/x/v2/reply/wbi/main',
        await wbiQuery({ oid: aid, type: 1, mode, next, ps: 20, plat: 1, web_location: 1315875 }));
      if (r.status === 412 || r.json?.code === -352) break;
      if (r.json?.code !== 0) break;
      const data = r.json.data || {};
      for (const reply of [...(data.replies || []), ...(data.top_replies || [])]) {
        for (const pic of (reply.content?.pictures || [])) {
          out.push({ url: pic.img_src, title: String(reply.content?.message || '').replace(/\s+/g, ' ').slice(0, 40), author: reply.member?.uname });
        }
      }
      next = data.cursor?.next ?? 0;
      if (!next) break;
    }
    return out;
  }

  /**
   * 按关键词搜图（AI 按聊天主题找图用）。**不含视频封面**：
   *   sources=['comment']（默认，优先）→ 关键词命中视频的**评论区图片**
   *   sources=['article']              → 专栏配图（用来补足数量）
   * 返回 [{ url, title, source, cv|bvid, author }]
   */
  async function searchImages(keyword, { count = 8, sources = ['comment', 'article'], videoTop = 5, commentPages = 2, animatedOnly = false } = {}) {
    await ensureCookie();
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('keyword 不能为空');
    const n = Math.max(1, Math.min(20, Number(count) || 8));
    const wants = new Set((Array.isArray(sources) ? sources : [sources]).map((x) => String(x)));
    if (!wants.size) { wants.add('comment'); wants.add('article'); }
    const out = [];
    const seen = new Set();
    const push = (item) => {
      const url = normPic(item.url);
      if (!url || !/^https:\/\/i\d\.hdslb\.com\//.test(url) || seen.has(url)) return;
      seen.add(url);
      out.push({ ...item, url });
    };

    // ① 评论区图片优先：关键词 → 相关视频 → 它们的评论区图
    if (wants.has('comment')) {
      const vids = await searchVideos(kw, { page: 1 });
      for (const v of vids.slice(0, Math.max(1, videoTop))) {
        if (out.length >= n) break;
        if (!v.aid) continue;
        try {
          const pics = await commentImages(v.aid, { pages: Math.max(1, commentPages) });
          for (const pic of pics) {
            if (out.length >= n) break;
            push({ ...pic, source: 'comment', bvid: v.bvid, title: String(pic.title || '').trim() || v.title });
          }
        } catch { /* 单个视频失败不影响整体 */ }
      }
    }

    // ② 不够再补专栏配图
    if (wants.has('article') && out.length < n) {
      const r = await api('https://api.bilibili.com/x/web-interface/wbi/search/type',
        await wbiQuery({ search_type: 'article', keyword: kw, page: 1, page_size: 20 }));
      if (r.status === 412 || r.json?.code === -352) {
        if (!out.length) throw new Error(`B 站搜索被风控（HTTP ${r.status} / code ${r.json?.code}）`);
      } else if (r.json?.code === 0) {
        for (const a of (r.json.data?.result || [])) {
          if (out.length >= n) break;
          const title = String(a.title || '').replace(/<[^>]+>/g, '');
          for (const u of (Array.isArray(a.image_urls) ? a.image_urls : [])) {
            if (out.length >= n) break;
            push({ url: u, title, source: 'article', cv: a.id, author: a.author });
          }
        }
      }
    }

    // animatedOnly：逐张下载探测，只留真动图。
    // B 站评论区/专栏里大量 .gif 其实是单帧静态图（视频帧导出），发到 QQ 不会动。
    if (animatedOnly && out.length) {
      const kept = [];
      for (const item of out) {
        try {
          const { buffer } = await safeFetchBuffer(item.url, 6 * 1024 * 1024, { headers: { referer: 'https://www.bilibili.com' } });
          const anim = describeAnimation(buffer);
          if (anim.animated) kept.push({ ...item, animated: true, frames: anim.frames ?? null });
        } catch { /* 探测失败（含链接过期）就跳过 */ }
        if (kept.length >= n) break;
      }
      return kept;
    }

    return out.slice(0, n);
  }

  /** 关键词搜索命中的视频 BV（供定时批量抓封面/评论用） */
  async function searchVideos(keyword, { page = 1 } = {}) {
    await ensureCookie();
    const r = await api('https://api.bilibili.com/x/web-interface/wbi/search/type',
      await wbiQuery({ search_type: 'video', keyword: String(keyword || '').trim(), page, page_size: 20 }));
    if (r.json?.code !== 0) return [];
    return (r.json.data?.result || []).map((v) => ({ bvid: v.bvid, aid: v.aid, title: String(v.title || '').replace(/<[^>]+>/g, '') })).filter((x) => x.bvid);
  }

  /**
   * 梗/黑话知识检索：搜索相关视频（标题+简介+播放量）再取评论区的**高赞评论**。
   * 评论往往就是这个梗最真实的用法与出处，比百科更接地气。
   */
  async function lookupKnowledge(word, { videoCount = 6, commentCount = 15, commentVideos = 2 } = {}) {
    await ensureCookie();
    const kw = String(word || '').trim();
    if (!kw) throw new Error('word 不能为空');
    const r = await api('https://api.bilibili.com/x/web-interface/wbi/search/type',
      await wbiQuery({ search_type: 'video', keyword: kw, page: 1, page_size: 20 }));
    if (r.status === 412 || r.json?.code === -352) throw new Error(`B 站搜索被风控（HTTP ${r.status}）`);
    if (r.json?.code !== 0) throw new Error(`B 站搜索失败：code=${r.json?.code}`);
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
    const videos = (r.json.data?.result || []).slice(0, Math.max(1, videoCount)).map((v) => ({
      bvid: v.bvid, aid: v.aid,
      title: strip(v.title).slice(0, 80),
      desc: strip(v.description).slice(0, 160),
      author: strip(v.author).slice(0, 30),
      play: v.play ?? null
    }));
    const comments = [];
    for (const v of videos.slice(0, Math.max(1, commentVideos))) {
      if (!v.aid) continue;
      try {
        const list = await commentTexts(v.aid, { pages: 1, limit: commentCount });
        for (const c of list) comments.push({ ...c, from: v.bvid });
      } catch { /* 单个视频失败不影响 */ }
      if (comments.length >= commentCount) break;
    }
    return { word: kw, videos, comments: comments.sort((a, b) => b.like - a.like).slice(0, commentCount) };
  }

  /**
   * 下载二进制（图片/雪碧图）。B站 CDN 有防盗链，必须带 referer。
   * 走 safeFetchBuffer（SSRF 白名单 + 大小上限），不自己拼 http 请求。
   */
  async function fetchBuffer(url, maxBytes = 8 * 1024 * 1024) {
    const abs = String(url).startsWith('//') ? `https:${url}` : String(url);
    const { buffer } = await safeFetchBuffer(abs, maxBytes, { headers: { referer: 'https://www.bilibili.com' } });
    return buffer;
  }

  return { api, searchImages, searchVideos, lookupKnowledge, commentTexts, fetchBuffer, get cookie() { return jar; } };
}
