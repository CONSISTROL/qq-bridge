// 机器人自己的资料（昵称 / 个性签名 / 头像）——改它等于改账号级身份，全群全私聊可见。
//
// 为什么单独一个模块：
// - 这里的**校验**规则要能单测（长度、控制字符、链接/广告、令牌泄露），
//   而不是散在 HTTP handler 里靠人肉 review；
// - 变更历史与「回滚到上一个值」是纯数据操作，放这里能脱离桥接验证。
//
// 设计底线（对应线上风险）：
// - **默认关**：能力开关在 config.json 的 socialV2.tools.setProfile，必须显式 true；
// - **只在管理员上下文可用**（判定在 bridge.js：管理员私聊，或触发这一轮的是管理员消息）；
// - 昵称/签名**默认不许带链接**——群友忽悠 AI 把群名改成广告是最典型的滥用；
// - 每次改动都留历史（谁改的、从什么改成什么、什么时候），控制台一键回滚。

export const NICKNAME_MAX = 24;
export const NOTE_MAX = 60;
export const REASON_MAX = 120;
export const HISTORY_MAX = 50;

/** 压掉控制字符/零宽字符并折叠空白（昵称里的换行会破坏客户端渲染）。 */
export function cleanProfileText(value, max) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** 文本里有没有链接/联系方式（昵称、签名里的广告位）。 */
export function looksLikeAd(text) {
  const s = String(text ?? '');
  return /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|cn|net|org|top|xyz|cc|tv|me|io)\b/i.test(s)
    || /(?:qq|微信|vx|v信|telegram|tg|加群|进群|私聊|联系|代购|出售|接单|推广|广告)\s*[:：]?\s*[a-z0-9_-]{4,}/i.test(s)
    // 无歧义的广告词：昵称里出现这些基本就是在打广告（「广告位招租」「代购私聊」）
    || /(?:广告位|招租|推广位|代购|接单|加群|进群|私聊我|联系我|出售|包邮|特价)/.test(s);
}

/**
 * 校验一个要写入的字段。
 * @returns {{ok:true, value:string}|{ok:false, error:string}}
 */
export function validateProfileField(raw, { field = 'nickname', max = NICKNAME_MAX, allowLinks = false } = {}) {
  const label = field === 'nickname' ? '昵称' : (field === 'personalNote' ? '个性签名' : field);
  const value = cleanProfileText(raw, max + 40);
  if (!value) return { ok: false, error: `${label}不能为空（想清空请用回滚，或显式传空字符串以外的占位）` };
  if (value.length > max) return { ok: false, error: `${label}太长：最多 ${max} 字（去掉空白后实际 ${value.length}）` };
  if (!allowLinks && looksLikeAd(value)) {
    return { ok: false, error: `${label}里不允许放链接/联系方式/推广字样（群友很容易忽悠 AI 把它改成广告）` };
  }
  // 保留标记：昵称里出现这些会让群友以为换人了/以为机器人坏了
  if (field === 'nickname' && /^(?:qq|微信|管理员|系统|官方|客服|机器人)$/i.test(value)) {
    return { ok: false, error: `昵称不能是「${value}」这类容易冒充官方/系统的名字` };
  }
  return { ok: true, value };
}

/** 一次变更记录。 */
export function createProfileChange({ field, from = '', to = '', by = 'console', reason = '', now = Date.now() } = {}) {
  return {
    field: String(field),
    from: cleanProfileText(from, 200),
    to: cleanProfileText(to, 200),
    by: cleanProfileText(by, 120),
    reason: cleanProfileText(reason, REASON_MAX),
    at: Number(now) || Date.now()
  };
}

/** 追加变更记录（有界），返回新数组。 */
export function pushProfileChange(history, change, { max = HISTORY_MAX } = {}) {
  const list = Array.isArray(history) ? history.filter((c) => c && c.field) : [];
  list.push(change);
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * 找出「字段 field 的上一个值」（用于一键回滚）。
 * 从最近往前找**最早那次把该字段改成当前值**的记录，取它的 from。
 * 简化实现：取最后一条该字段记录的 from —— 也就是「改之前是什么」。
 */
export function previousValueFor(history, field) {
  const list = Array.isArray(history) ? history.filter((c) => c && c.field === field) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].from) return list[i].from;
  }
  return '';
}

/** 反序列化（持久化回来做归一，损坏字段不能让回滚逻辑崩掉）。 */
export function normalizeProfileState(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const cur = obj.current && typeof obj.current === 'object' ? obj.current : {};
  const avatar = obj.avatar && typeof obj.avatar === 'object' ? obj.avatar : {};
  return {
    current: {
      nickname: cleanProfileText(cur.nickname, 200),
      personalNote: cleanProfileText(cur.personalNote, 200),
      updatedAt: Number(cur.updatedAt) || 0
    },
    // 头像单独存：本机留一份字节，回滚时不必再去网上拉（旧头像可能已经不存在了）
    avatar: {
      file: cleanProfileText(avatar.file, 200),
      sha256: cleanProfileText(avatar.sha256, 80),
      previousFile: cleanProfileText(avatar.previousFile, 200),
      updatedAt: Number(avatar.updatedAt) || 0
    },
    history: (Array.isArray(obj.history) ? obj.history : [])
      .filter((c) => c && typeof c === 'object' && c.field)
      .map((c) => createProfileChange(c))
      .slice(-HISTORY_MAX)
  };
}

/** 给控制台/AI 看的一行现状。 */
export function formatProfileState(state) {
  const s = normalizeProfileState(state);
  const bits = [`昵称：${s.current.nickname || '（未记录）'}`, `签名：${s.current.personalNote || '（未记录）'}`];
  if (s.avatar.sha256) bits.push(`头像：已托管（${s.avatar.sha256.slice(0, 8)}）`);
  const last = s.history[s.history.length - 1];
  if (last) bits.push(`最后变更：${last.field} ← ${last.from || '(空)'}（${last.by}）`);
  return bits.join('｜');
}
