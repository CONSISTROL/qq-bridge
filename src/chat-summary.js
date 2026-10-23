// 滚动摘要：最近消息被裁掉时，把被裁的那段压成一段很短的摘要，保留在 state 里。
//
// 为什么不用模型来总结：那要额外调一次 LLM（慢 + 花钱），而这个摘要每轮都会被注入，
// 只要"能提醒它那段时间聊过什么"就够了。所以用确定性抽取：
//   · 谁在说话（发言最多的几个人 + 条数）
//   · 聊了哪些事（按关键词/话题词频挑出的几个词）
//   · 几句最有信息量的原话（长度适中、非纯表情/图片占位）
// 需要更高质量的总结时，再由 AI 自己调 qq_search_history 去翻原文。

const PLACEHOLDERS = /^\[(图片|动画表情|表情|视频|文件|语音|音频|转发消息|卡片)[^\]]*\]$/;

const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** 从一批归档/消息记录里抽出一段短摘要（≤ maxChars 字）。 */
export function summarizeRecords(records, { maxChars = 600, maxQuotes = 4 } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && clean(r.text));
  if (!list.length) return '';
  const speakers = new Map();
  const words = new Map();
  for (const r of list) {
    const who = clean(r.sender || (r.me ? '我' : '')).slice(0, 12);
    if (who) speakers.set(who, (speakers.get(who) || 0) + 1);
    const text = clean(r.text);
    if (PLACEHOLDERS.test(text)) continue;
    // 粗糙的"话题词"：连续 2~6 个中文/字母数字串，取出现次数
    for (const m of text.matchAll(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9+.#-]{2,12}/g)) {
      const w = m[0];
      if (/^(这个|那个|什么|就是|然后|可以|一个|没有|不是|还是|他们|我们|自己|现在|已经|感觉|真的)$/.test(w)) continue;
      words.set(w, (words.get(w) || 0) + 1);
    }
  }
  const topSpeakers = [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([w, n]) => `${w}(${n})`).join('、');
  const topWords = [...words.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([w]) => w).join('、');
  const quotes = list
    .map((r) => clean(r.text))
    .filter((t) => t.length >= 6 && t.length <= 60 && !PLACEHOLDERS.test(t))
    .slice(-maxQuotes * 3)
    .filter((_, i, arr) => i % Math.max(1, Math.ceil(arr.length / maxQuotes)) === 0)
    .slice(0, maxQuotes);

  const parts = [];
  if (topSpeakers) parts.push(`主要发言：${topSpeakers}`);
  if (topWords) parts.push(`高频词：${topWords}`);
  if (quotes.length) parts.push(`片段：${quotes.map((q) => `「${q}」`).join(' ')}`);
  let out = parts.join('；');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…';
  return out;
}

/** 把新摘要并进旧摘要：保留最近几条，整体有长度上限。 */
export function mergeSummary(prev, next, { maxChars = 1200 } = {}) {
  const prevList = String(prev ?? '').split('\n').filter(Boolean);
  const txt = clean(next);
  if (!txt) return prevList.join('\n');
  const line = `- ${txt}`;
  const merged = [...prevList, line];
  let out = merged;
  while (out.join('\n').length > maxChars && out.length > 1) out = out.slice(1);
  return out.join('\n');
}
