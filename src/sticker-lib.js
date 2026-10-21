// 表情包体系（聊天模式）——本地表情知识库与策略提示纯函数。
//
// 职责：
// - state/stickers.json 的读写与字段归一化
// - 把 SnowLuma `fetch_custom_face_detail` 返回的 QQ 收藏表情合并进本地库
// - 支持按 emoji_id / md5 / url 查找、按备注/本地笔记/标签搜索
// - 生成注入 AI 的“表情包策略/可用表情”摘要
//
// 设计原则：
// - QQ 账号的收藏表情是“源”，本地库是“AI 认知层”：保留 AI 学习到的含义/标签/使用次数，
//   不覆盖 QQ 的备注；QQ desc 为空时 AI 可以看图后用 qq_sticker_note 记录自己的理解。
// - 所有文本只做展示/提示，不执行任何本地操作。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    // 本地备注：**只给 AI 看**的短名，不进 QQ、别人看不到。
    // 和 desc（QQ 官方备注，全 QQ 可见）分开：管理员可以在控制台给表情起个更准的名字，
    // AI 选表情时优先认这个，认不出才退回 QQ desc / 长笔记。
    localRemark: String(entry.localRemark ?? '').trim().slice(0, 40),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 把 SnowLuma 返回的 QQ 收藏表情详情合并进本地库。
// 保留本地 AI 认知字段（localNote/tags/usage/useCount/lastUsedAt/lastContext），
// 只更新 QQ 侧字段（id/resId/url/md5/desc）。
export function mergeStickerLibrary(existing, fetched, { complete = true } = {}) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localRemark: old?.localRemark || '',
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
      byId.set(id, merged);
    }
  }
  // 清理已被 QQ 端删除的收藏表情（保留手动/本地新增的非 qq 来源条目）。
  // count 限制导致的部分结果不能证明其他表情已被删除。
  return out.filter((e) => !complete || e.source !== 'qq' || fetchedIds.has(e.id));
}

/**
 * 这个表情是不是「还没人给过说法」？
 *
 * 判据是三样都没有：本地备注（localRemark，AI 用的短名）、QQ 官方备注（desc）、
 * 本地长笔记（localNote）。只要有一样，AI 就能认出它，不算没备注。
 * 收藏夹里这种表情不少（QQ 只存图、不存含义），需要 AI 自己看图补上。
 */
export function stickerNeedsRemark(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const hasLocalRemark = String(e.localRemark ?? '').trim().length > 0;
  const hasDesc = String(e.desc ?? '').trim().length > 0;
  const hasNote = String(e.localNote ?? '').trim().length > 0;
  return !hasLocalRemark && !hasDesc && !hasNote;
}

function stickerUrlKey(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw) && !/^[^\s/]+\/[^\s]*$/.test(raw)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

// id/md5 精确匹配优先；URL 只忽略协议、尾斜杠与查询参数，不做任意子串匹配。
export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const id = raw;
  const md5 = raw.toUpperCase();
  const list = Array.isArray(entries) ? entries : [];
  const exact = list.find((e) => {
    if (!e) return false;
    if (e.id === id || e.resId === id) return true;
    if (e.md5 && e.md5 === md5) return true;
    return false;
  });
  if (exact) return exact;
  const urlNormalized = stickerUrlKey(raw);
  return (urlNormalized && list.find((e) => e && stickerUrlKey(e.url) === urlNormalized)) || null;
}

// 格式化给 AI 看的表情列表；query 会匹配 desc/localRemark/localNote/tags/usage/id/md5。
// onlyUnlabeled=true 时只返回「三样备注都没有」的表情——AI 用它来补自己的理解。
export function formatStickerList(entries, query = '', limit = 48, { onlyUnlabeled = false } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const unlabeled = list.filter(stickerNeedsRemark).length;
  const q = String(query ?? '').trim().toLowerCase();
  let filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localRemark, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  if (onlyUnlabeled) filtered = filtered.filter(stickerNeedsRemark);
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    resId: e.resId,
    md5: e.md5,
    url: e.url,
    desc: e.desc || '',
    localRemark: e.localRemark || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    usage: e.usage || '',
    useCount: e.useCount || 0,
    lastUsedAt: e.lastUsedAt || 0,
    source: e.source || 'qq',
    needsRemark: stickerNeedsRemark(e)
  }));
  return {
    total: list.length,
    unlabeled,
    onlyUnlabeled: !!onlyUnlabeled,
    matched: filtered.length,
    truncated: filtered.length > max,
    stickers: items
  };
}

// 生成注入 AI 的“可用表情包”摘要（不暴露完整 URL，避免上下文爆炸）。
// autoLabel=false 时不再催 AI 补备注（控制台「表情包」分区的开关），已写的备注不受影响。
export function buildStickerContext(entries, max = 8, { autoLabel = true, labelPerTurn = 2 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const top = [...list]
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || ((b.localRemark || b.desc || b.localNote) ? 1 : 0) - ((a.localRemark || a.desc || a.localNote) ? 1 : 0))
    .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));
  const lines = top.map((e) => {
    // 本地备注优先：那是管理员专门为 AI 起的名字，比 QQ 官方 desc 更准。
    const label = e.localRemark || e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    return `- ${label}${extra}${used}`;
  });
  // 收藏夹里一堆表情是「只有图、没有说法」的：QQ 不存含义，管理员也未必逐个标注。
  // 让 AI 自己看图补上——这是它选表情时唯一能用的抓手。
  //
  // 写法是拿线上行为换来的：第一版只写了「有空就自己看一眼补上」，结果模型在推理里
  // 明确写了「could label 1-2 later, not now … but it costs image tokens, let me skip」——
  // 「有空」= 永远不有空。所以这里改成：**给具体 id**（省一次工具调用、可立即执行）、
  // **挂到闲置回合上**（群里没人等你、准备潜水收尾时先补一个再走），并**明说成本可忽略**，
  // 免得它替我们省 token 而一直拖着。
  const unlabeledList = list.filter(stickerNeedsRemark);
  // 一轮补几个由 socialV2.sticker.autoLabelPerTurn 决定（默认 2，上限 6）：
  // 每张表情图都要进上下文，所以默认压得小；嫌慢可以在控制台调大。
  const perTurn = Math.max(1, Math.min(6, Number(labelPerTurn) || 2));
  const sample = unlabeledList.slice(0, perTurn).map((e) => e.id);
  const sampleHint = sample.length === 1
    ? `\n**本次就补这个**：\`${sample[0]}\`（要看全部：qq_list_stickers(onlyUnlabeled=true)）。`
    : `\n**本次就补这 ${sample.length} 个**：${sample.map((id) => `\`${id}\``).join('、')}（要看全部：qq_list_stickers(onlyUnlabeled=true)）。`;
  const backlog = autoLabel && unlabeledList.length
    ? `\n【有 ${unlabeledList.length} 个表情还没有任何备注】这是你选表情时唯一的抓手，攒着等于白收藏。`
      + '做法：qq_get_sticker_image 看一眼 → qq_sticker_note 写 localRemark（≤40 字短名，如「捂耳朵猫（不想听）」）+ note（含义、什么场合该发）。'
      + (sample.length ? sampleHint : '')
      + '\n**什么时候做**：这一轮如果群里没人等你、你准备潜水收尾，就先补几个再走，它是闲置回合的默认填充动作，**别拖到「以后」**。'
      + `\n成本：一张表情图约几百 token，补一个可以忽略，这是给你自己建记忆、不算浪费上下文；一轮最多补 ${perTurn} 个，不用专门为它开一轮。`
      + '\n**一张一张来**：看完一张**立刻**用它的 id 调 qq_sticker_note 写掉，再去看下一张，'
      + '别先把几张图都看完再一起写，那样很容易把 A 的描述写到 B 上（线上真发生过：`faker_憋笑` 和 `柴郡猫猫_点赞` 的笔记互换了）。'
      + '\n三条禁忌：已有 localRemark / desc / localNote 的**不要覆盖**；看图写，别照文件名（哈希）猜；别把补备注的进度发到群里。'
    : '';
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/有备注的 ${top.length} 个，完整列表请用 qq_list_stickers 查看）：\n${lines.join('\n')}${backlog}`;
}

// 聊天模式下的“真人发表情包”策略提示。
// 这是软策略：AI 仍自主判断是否使用，桥接不强制。
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    // 群里聊得热闹但没你的事时，硬接一句容易尴尬、纯潜水又像不在——发一张贴气氛的表情包是最自然的冒泡方式。
    '- **没人理你时用表情包冒泡**：群里聊得热闹但没你的事、又插不上话时，可以直接发一张**对得上当下气氛**的表情包（不用配文字），比硬接一句自然，也比完全消失强。选图先看气氛（乐/无语/震惊/赞同/吃瓜/敷衍），别把情绪配反；偶尔用，别连着发。',
    '- 选择：优先用本地备注（localRemark）/ QQ 备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 qq_get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 qq_send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发表情。需要引用/点名时传 replyToMessageId / atUserId（群聊）。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里；不要把表情包当回复的唯一内容（偶尔可以，但别让群友觉得你在敷衍）。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。',
    '- 挑图：不确定发哪张、或收藏里没有对得上语境的，调用 qq_pick_sticker（传当前语境/心情），它会先判时机，再从「QQ 收藏表情 + 本地图库」里挑候选；本地都不合适时它会联网找一批（偏二次元/DeepSeek 二创风格），返回的候选可以直接用 send 参数发出去。'
  ].join('\n');
}

// 把「此刻适不适合发表情包」的硬判断渲染成一行注入提示的文本。
// moment 由 bridge 侧 evaluateMoment() 算出（纯函数在 sticker-picker.js）。
export function buildStickerMomentHint(moment, { top = [] } = {}) {
  if (!moment || typeof moment !== 'object') return '';
  if (moment.allowed === false) {
    return `【此刻发表情包】不适合：${moment.reason}。没到时机就别硬塞表情。`;
  }
  // 措辞与"下一步"都改成行动导向（2026-10-15 复盘）：原来普通闲聊渲染成「一般」+
  // 「要发就先 pick 确认…别凭印象瞎发」，语义上是"可选项+有门槛"，模型就直接跳过了
  // （历史上只发过 2 次）。现在明确「可以发/很适合发」，并给**一步发送**的具体参数。
  const good = moment.level === 'good';
  const level = good ? '这轮很适合发一张' : '可以发一张（不勉强）';
  const bits = [`【此刻发表情包】${level}：${moment.reason}`];
  if (moment.lastStickerMinAgo != null && moment.lastStickerMinAgo < 20) bits.push(`上次发表情：${moment.lastStickerMinAgo} 分钟前`);
  const list = Array.isArray(top) ? top.filter(Boolean).slice(0, 3) : [];
  const first = list[0];
  if (list.length) {
    bits.push('本地候选：' + list.map((c) => `${c.label}${c.score != null ? `(${c.score})` : ''}`).join(' / '));
  }
  if (first && first.id) {
    // 一步到位：qq_pick_sticker 自带 send 参数，传了就**直接发出去**（不用再调 qq_send_sticker）。
    // 这里把 top1 的 id 直接写出来，省掉"先查候选再发"的第二步——那是模型不发的主要原因之一。
    bits.push(`想发就一步发出去：qq_pick_sticker(key="<本会话 key>", token="<会话令牌>", send={id:"${first.id}"})` +
      `（它会直接发出这张：${first.label}${good ? '，这轮时机正好' : ''}）`);
  } else {
    bits.push('要发就用 qq_pick_sticker 看候选与时机（本地不够它会联网找），别凭印象瞎发');
  }
  return bits.join('；');
}

// 把 AI 本地认知（remark/note/tags/usage）更新到一条表情记录上，并返回新数组。
export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localRemark: patch.localRemark !== undefined ? String(patch.localRemark ?? '').trim().slice(0, 40) : target.localRemark,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

// 从本地库里移除一条（QQ 端删除成功后同步本地）。返回新数组与被删的条目。
export function removeSticker(entries, id) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  return { entries: list.filter((e) => e.id !== target.id), entry: target };
}

// 记录一次“使用”，返回新数组。
export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
