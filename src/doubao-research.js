// 豆包作为梗考究的「一路来源」——问答提示词、回答解析、以及**交叉验证护栏**。
//
// 为什么单独一个模块（纯函数、不 import 桥接、不碰浏览器）：
// 这套判断是这次接入里最容易出错、也最要紧的部分（判错就是把假释义写进群里每轮提示词），
// 必须能离线单测。浏览器那层是 IO，这层是逻辑，分开放。
//
// 核心原则：**模型不是知识库。**
// 问一个语言模型「这个梗什么意思」，它几乎不会说「我不知道」，而是编一个听起来合理的解释。
// 所以豆包给的东西只算「一路证据」，绝不能单独把词条转正——转正了就是每天自动往知识库投毒。

/** 问豆包时用的提示词。要点：明确允许它说不知道，并要求结构化输出。 */
export function buildDoubaoMemePrompt(word, { context = '', groupExamples = [] } = {}) {
  const w = String(word ?? '').trim().slice(0, 60);
  const lines = [
    '你是中文网络用语研究员。下面这个词/短语可能是中国网络梗、黑话或圈内简称。',
    `词：${w}`,
  ];
  if (context) lines.push(`出现语境：${String(context).slice(0, 200)}`);
  if (Array.isArray(groupExamples) && groupExamples.length) {
    lines.push(`我看到它在聊天里是这样用的：${groupExamples.slice(0, 3).map((s) => String(s).slice(0, 100)).join(' / ')}`);
  }
  lines.push(
    '',
    '要求：',
    '1. **只回答你确实知道的**。不确定、没见过、或者它根本不是固定梗，就明确说不知道，不要硬编一个解释。',
    '2. 不要输出客套话、不要复述我的问题，只给结论。',
    '3. 严格按下面的 JSON 输出（不要加代码块标记）：',
    '{"known": true/false, "meaning": "一句话意思", "usage": "什么场合用", "origin": "出处/来源（不知道就空）", "example": "一句例句", "confidence": "high/medium/low"}',
    '4. 若 known 为 false，其余字段留空字符串。'
  );
  return lines.join('\n');
}

/** 模型明确表示「不知道 / 不是梗」的说法。 */
const UNKNOWN_RE = /(不知道|不清楚|不了解|没见过|没有这种|不是(一个)?(固定的)?(网络)?(梗|用法|说法)|无法确定|查不到|无法回答|抱歉|不确定)/;

/**
 * 解析豆包的回答。
 * 模型经常把 JSON 包在 ``` 里、或前后写一句人话，所以要能容忍。
 * @returns {{known:boolean, meaning:string, usage:string, origin:string, example:string, confidence:string, raw:string, reason:string}}
 */
export function parseDoubaoAnswer(text) {
  const raw = String(text ?? '').trim();
  const empty = {
    known: false, meaning: '', usage: '', origin: '', example: '',
    confidence: 'low', raw, reason: ''
  };
  if (!raw) return { ...empty, reason: 'empty' };

  // 先想办法把 JSON 抠出来
  let obj = null;
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object') { obj = parsed; break; }
    } catch { /* 试下一个 */ }
  }

  if (obj) {
    const known = obj.known === true || String(obj.known).toLowerCase() === 'true';
    const meaning = String(obj.meaning ?? '').trim();
    // 说了 known 但没给释义，一样当不知道
    if (!known || !meaning) return { ...empty, reason: known ? 'no_meaning' : 'model_says_unknown' };
    if (UNKNOWN_RE.test(meaning) && meaning.length < 40) return { ...empty, reason: 'model_says_unknown' };
    return {
      known: true,
      meaning: meaning.slice(0, 300),
      usage: String(obj.usage ?? '').trim().slice(0, 200),
      origin: String(obj.origin ?? '').trim().slice(0, 200),
      example: String(obj.example ?? '').trim().slice(0, 160),
      confidence: /^(high|medium|low)$/i.test(String(obj.confidence)) ? String(obj.confidence).toLowerCase() : 'medium',
      raw,
      reason: ''
    };
  }

  // 没 JSON：退化成纯文本，但必须排除「不知道」类回答
  if (UNKNOWN_RE.test(raw)) return { ...empty, reason: 'model_says_unknown' };
  if (raw.length < 4) return { ...empty, reason: 'too_short' };
  // 纯文本回答只在够短、且不像在扯别的时候才收（长文多半是没按要求输出）
  if (raw.length > 400) return { ...empty, reason: 'unstructured_long' };
  return {
    known: true,
    meaning: raw.slice(0, 300),
    usage: '', origin: '', example: '',
    confidence: 'low',
    raw,
    reason: 'plain_text'
  };
}

/**
 * 判定一条候选的证据强度。
 * - strong      ：B站有真实证据（≥1 条高赞评论，或 ≥2 个相关视频）——这是「别人真的这么用」的硬证据
 * - doubao-only ：只有豆包给了释义，没有任何 B站证据
 * - weak        ：什么外部证据都没有（模型凭自己知识答的）
 * 传计数而不是数组：调用方本来就是从抓取结果里数出来的，避免为了「有个长度」造空数组。
 */
export function classifyEvidence({ biliCommentCount = 0, biliVideoCount = 0, doubaoKnown = false } = {}) {
  const comments = Number(biliCommentCount) || 0;
  const videos = Number(biliVideoCount) || 0;
  if (comments >= 1 || videos >= 2) return 'strong';
  if (doubaoKnown) return 'doubao-only';
  return 'weak';
}

/**
 * 能不能把候选转正。
 *
 * 这是本次接入最重要的一条规则：**只有豆包一个来源时，永远不自动转正。**
 * 理由见文件头——模型会编，而转正后的释义会进每条唤醒提示，等于把幻觉变成事实。
 * 判定为 doubao-only 的条目会留在候选里、标上 verdict，等 B站/群聊出现独立证据再收。
 *
 * @returns {{promote:boolean, verdict:string, reason:string}}
 */
export function decidePromotion({
  evidence = 'weak',
  learnerConfirmed = false,
  hasMeaning = false,
  autoConfirm = true
} = {}) {
  if (!learnerConfirmed) return { promote: false, verdict: 'unknown', reason: '研究会话没有确认' };
  if (!hasMeaning) return { promote: false, verdict: 'unknown', reason: '没有拿到释义' };
  if (evidence === 'doubao-only') {
    return {
      promote: false,
      verdict: 'doubao-only',
      reason: '只有豆包一个来源，未经过交叉验证，不收（等 B站/群聊出现独立证据）'
    };
  }
  if (!autoConfirm) return { promote: false, verdict: 'confirmed', reason: '自动转正已关闭，等人工确认' };
  return { promote: true, verdict: 'confirmed', reason: evidence === 'strong' ? 'B站有独立证据支持' : '自动转正' };
}

/** 给控制台/日志用的一句话摘要。 */
export function describeEvidence(evidence) {
  if (evidence === 'strong') return 'B站有独立证据';
  if (evidence === 'doubao-only') return '仅豆包（未交叉验证）';
  return '无外部证据';
}
