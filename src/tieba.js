// 贴吧热榜 + 话题帖子：梗的来源之一，也用作"老哥怎么说话"的语感参考。
//
// 用 https://tieba.baidu.com/hottopic/browse/topicList?res_type=1 这个页面（返回 HTML），
// 里面每个话题带 topic_id 与 topic-text；正文/回复在话题详情页。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const decode = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();

/** 贴吧热榜：{ topicId, title } 列表。 */
export async function fetchTiebaHot({ limit = 12, timeoutMs = 15000 } = {}) {
  const res = await fetch('https://tieba.baidu.com/hottopic/browse/topicList?res_type=1', {
    headers: { 'user-agent': UA, referer: 'https://tieba.baidu.com/' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`贴吧热榜 ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /topic_id=(\d+)[\s\S]{0,400}?class="topic-text">([\s\S]*?)<\/[^>]+>/g;
  for (const m of html.matchAll(re)) {
    const title = decode(m[2]);
    if (!title) continue;
    out.push({ topicId: m[1], title: title.slice(0, 80) });
    if (out.length >= limit) break;
  }
  // 兜底：只抓标题文本
  if (!out.length) {
    for (const m of html.matchAll(/class="topic-text">([\s\S]*?)<\//g)) {
      const title = decode(m[1]);
      if (title) out.push({ topicId: '', title: title.slice(0, 80) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 话题详情里的帖子标题/内容片段（用于找梗、学语感）。 */
export async function fetchTiebaTopic({ topicId, limit = 8, timeoutMs = 15000 } = {}) {
  if (!topicId) return [];
  const res = await fetch(`https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=${encodeURIComponent(topicId)}`, {
    headers: { 'user-agent': UA, referer: 'https://tieba.baidu.com/' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`贴吧话题 ${res.status}`);
  const html = await res.text();
  const out = [];
  for (const m of html.matchAll(/<a[^>]*class="[^"]*j_th_tit[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const t = decode(m[1]);
    if (t) out.push(t.slice(0, 90));
    if (out.length >= limit) break;
  }
  if (!out.length) {
    for (const m of html.matchAll(/class="topic-text">([\s\S]*?)<\//g)) {
      const t = decode(m[1]);
      if (t && !out.includes(t)) out.push(t.slice(0, 90));
      if (out.length >= limit) break;
    }
  }
  return out;
}
