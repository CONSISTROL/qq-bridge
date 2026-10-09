// 出站口播清洗：削掉最机械的「AI 标签 / 发语词」。
//
// 为什么需要这个（而不是再加一条提示词）：
// 「行，」在唤醒提示词里**已经点名禁过一轮**了，今天线上照样出现两次
// （15:02「行，我先按S31那个价位看」、15:09「行，S31和初耳NOVA都记本子上」）。
// 现在这条规则写的是「开场**别老用**」——「别老用」被模型读成了「偶尔用没关系」。
// 这类字符串是完全确定性的，确定性处理比再写一遍 prompt 可靠得多。
//
// 设计原则：**只做极窄的机械删除，绝不做改写**。
// 可能改变语义的一个都不碰——宁可漏洗，不可洗坏。
// 每次命中都记日志（调用方负责），这样才能量出真实发生率。

/** 句首发语词：只有这些，且必须紧跟标点，才算「公式化开场」。 */
const OPENER_RE = /^(?:行|好的|好嘞)\s*[，,。.、：:！!]\s*/;
/** 收尾标签：**必须带冒号**才算标签（「总结一下」这种正常说法不能被误伤）。 */
const LABEL_RE = /^(?:总结|小结|结论|综上|总之|总而言之|总的来说|一句话总结|一句话)\s*[：:]\s*/;

/** 剥掉一层又一层，但也别无限剥（防病态输入）。 */
const MAX_STRIP = 2;

/**
 * 清洗一条待发出的消息文本。
 * @param {string} text
 * @param {{ scrubbers?: string[] }} [opts] 只跑指定清洗器（测试/灰度用）
 * @returns {{text:string, changed:boolean, hits:string[]}}
 */
export function scrubFormulaicSpeech(text, opts = {}) {
  const original = String(text ?? '');
  if (!original.trim()) return { text: original, changed: false, hits: [] };
  const only = Array.isArray(opts.scrubbers) && opts.scrubbers.length ? new Set(opts.scrubbers) : null;
  const useOpener = !only || only.has('opener');
  const useLabel = !only || only.has('label');
  // 先吃掉前导空白再匹配：消息前多敲几个空格很常见，不该因此漏洗。
  let out = original.replace(/^[\s\u3000]+/, '');
  const hits = [];
  for (let round = 0; round < MAX_STRIP; round += 1) {
    let hitThisRound = false;
    if (useLabel) {
      const m = LABEL_RE.exec(out);
      if (m) { out = out.slice(m[0].length); hits.push('label'); hitThisRound = true; }
    }
    if (useOpener) {
      const m = OPENER_RE.exec(out);
      if (m) { out = out.slice(m[0].length); hits.push('opener'); hitThisRound = true; }
    }
    if (!hitThisRound) break;
  }
  if (!hits.length) return { text: original, changed: false, hits: [] };
  const trimmed = out.replace(/^[\s\u3000]+/, '');
  // 洗完只剩空白或只剩标点（原文本来就是一句「行，」「行，。」）→ 保留原文。
  // 既不让调用方发出空消息，也不让它发一条光秃秃的标点。
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return { text: original, changed: false, hits: [] };
  return { text: trimmed, changed: true, hits };
}

/** 给日志/控制台用的可读说明。 */
export function describeScrub(hits) {
  const names = { opener: '句首发语词', label: '总结标签' };
  return (Array.isArray(hits) ? hits : []).map((h) => names[h] ?? h).join('+');
}
