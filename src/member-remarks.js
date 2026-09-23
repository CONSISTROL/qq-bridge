// 群成员备注（二代仿真模式）——AI 私有记忆的成员备注库与读写纯函数。
//
// 背景：SnowLuma/OneBot 没有「群成员本地备注」这类接口。真·群名片（set_group_card）
// 需要机器人是管理员/群主，而且全群可见，不适合当「只给自己看」的记忆。
// 所以这里分成两层：
// - 本模块：桥接本地的备注库，按 会话 key + QQ 号 索引，只在 AI 视角生效，不动 QQ；
// - 真·群名片：另一个默认关闭的工具（qq_set_member_card，socialV2.tools.setMemberCard=true）。
//
// 设计原则：
// - 昵称/群名片只是「记录当时的快照」，索引始终用 QQ 号：群友改昵称不会丢备注；
// - 默认**不注入**唤醒提示（省 token）：AI 想认人时自己调 qq_get_member_remarks 查；
// - 所有文本都会过截断，避免模型写入超长内容把状态文件撑爆。

import fs from 'node:fs';
import path from 'node:path';

export const MEMBER_REMARK_MAX = 20;        // 备注短名上限（和收藏表情备注同一量级）
export const MEMBER_NOTE_MAX = 200;         // 补充说明上限
export const MEMBER_NICK_MAX = 64;          // 昵称快照上限
export const MEMBER_REMARKS_PER_KEY_MAX = 300; // 单个会话最多记多少个成员

/** 归一化 QQ 号：只接受正整数字符串。 */
export function normalizeUserId(value) {
  const s = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(s) ? s : '';
}

function clampText(value, max) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/** 空库结构。 */
export function emptyMemberStore() {
  return { version: 1, conversations: {} };
}

/** 落盘前的归一化：字段缺失/类型不对的记录直接丢弃，避免脏数据反复写回。 */
export function normalizeMemberRemark(raw, fallbackUserId = '') {
  const e = raw && typeof raw === 'object' ? raw : {};
  const qq = normalizeUserId(e.qq ?? e.userId ?? fallbackUserId);
  if (!qq) return null;
  const remark = clampText(e.remark, MEMBER_REMARK_MAX);
  const note = clampText(e.note, MEMBER_NOTE_MAX);
  if (!remark && !note) return null;
  const createdAt = String(e.createdAt || '').trim() || new Date().toISOString();
  return {
    qq,
    remark,
    note,
    nick: clampText(e.nick, MEMBER_NICK_MAX),
    source: e.source === 'manual' ? 'manual' : 'ai',
    createdAt,
    updatedAt: String(e.updatedAt || '').trim() || createdAt
  };
}

/** 读取备注库；文件不存在/损坏时返回空库（不抛错，避免拖垮桥接启动）。 */
export function loadMemberStore(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    const conversations = parsed && typeof parsed.conversations === 'object' && parsed.conversations ? parsed.conversations : {};
    const out = emptyMemberStore();
    for (const [key, members] of Object.entries(conversations)) {
      if (!members || typeof members !== 'object') continue;
      const clean = {};
      for (const [qq, raw] of Object.entries(members)) {
        const entry = normalizeMemberRemark(raw, qq);
        if (entry) clean[entry.qq] = entry;
      }
      if (Object.keys(clean).length) out.conversations[key] = clean;
    }
    return out;
  } catch {
    return emptyMemberStore();
  }
}

/** 写入备注库（原子写：先写临时文件再 rename，避免断电写坏）。 */
export function saveMemberStore(file, store) {
  const data = store && typeof store === 'object' ? store : emptyMemberStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 取某个会话的成员备注表（只读引用）。 */
export function conversationRemarks(store, key) {
  const conv = store?.conversations?.[String(key ?? '').trim()];
  return conv && typeof conv === 'object' ? conv : {};
}

/**
 * 写入/更新一个成员的备注。remark 与 note 同时为空视为删除。
 * 返回 { entry, removed } —— entry 为 null 表示已删除。
 */
export function setMemberRemark(store, key, userId, { remark, note, nick, source } = {}) {
  const convKey = String(key ?? '').trim();
  const qq = normalizeUserId(userId);
  if (!convKey || !qq) return { entry: null, removed: false };
  if (!store.conversations || typeof store.conversations !== 'object') store.conversations = {};
  const conv = store.conversations[convKey] && typeof store.conversations[convKey] === 'object'
    ? store.conversations[convKey]
    : (store.conversations[convKey] = {});
  const prev = normalizeMemberRemark(conv[qq], qq);
  // 未传的字段保留原值：方便「只补一句说明，不动短名」。
  const nextRemark = remark === undefined ? (prev?.remark ?? '') : clampText(remark, MEMBER_REMARK_MAX);
  const nextNote = note === undefined ? (prev?.note ?? '') : clampText(note, MEMBER_NOTE_MAX);
  const nextNick = nick === undefined ? (prev?.nick ?? '') : clampText(nick, MEMBER_NICK_MAX);

  if (!nextRemark && !nextNote) {
    const existed = Boolean(conv[qq]);
    delete conv[qq];
    if (existed) return { entry: null, removed: true };
    return { entry: null, removed: false };
  }

  const entry = {
    qq,
    remark: nextRemark,
    note: nextNote,
    nick: nextNick,
    source: source === 'manual' || prev?.source === 'manual' ? 'manual' : 'ai',
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  conv[qq] = entry;

  // 有界：超出上限时丢最早更新的记录，避免单个大群把文件撑大。
  const qqs = Object.keys(conv);
  if (qqs.length > MEMBER_REMARKS_PER_KEY_MAX) {
    qqs
      .sort((a, b) => String(conv[a]?.updatedAt ?? '').localeCompare(String(conv[b]?.updatedAt ?? '')))
      .slice(0, qqs.length - MEMBER_REMARKS_PER_KEY_MAX)
      .forEach((old) => { delete conv[old]; });
  }
  return { entry, removed: false };
}

/** 删除一个成员的备注。返回是否真的删掉了。 */
export function removeMemberRemark(store, key, userId) {
  const convKey = String(key ?? '').trim();
  const qq = normalizeUserId(userId);
  const conv = store?.conversations?.[convKey];
  if (!qq || !conv || typeof conv !== 'object' || !conv[qq]) return false;
  delete conv[qq];
  return true;
}

/** 列出某个会话的成员备注，可用 q 按 QQ 号/备注/说明/昵称过滤。 */
export function listMemberRemarks(store, key, { q = '', limit = 100 } = {}) {
  const conv = conversationRemarks(store, key);
  const needle = String(q ?? '').trim().toLowerCase();
  const all = Object.values(conv)
    .filter((e) => e && typeof e === 'object')
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const hit = needle
    ? all.filter((e) => [e.qq, e.remark, e.note, e.nick].some((v) => String(v ?? '').toLowerCase().includes(needle)))
    : all;
  const max = Math.max(1, Number(limit) || 100);
  return { entries: hit.slice(0, max), total: hit.length, allTotal: all.length };
}

/**
 * 按「QQ 号 / 备注 / 昵称」精确或模糊找到一条备注。
 * 用途：让 AI 可以只凭群里看到的名字去改备注，不必先查 QQ 号。
 */
export function findMemberRemark(store, key, needle) {
  const want = String(needle ?? '').trim().toLowerCase();
  if (!want) return null;
  const conv = conversationRemarks(store, key);
  const all = Object.values(conv).filter((e) => e && typeof e === 'object');
  const exact = all.find((e) => String(e.qq) === want
    || String(e.remark ?? '').toLowerCase() === want
    || String(e.nick ?? '').toLowerCase() === want);
  if (exact) return exact;
  const fuzzy = all.find((e) => [e.remark, e.note, e.nick].some((v) => String(v ?? '').toLowerCase().includes(want)));
  return fuzzy ?? null;
}

/** 单行展示。 */
export function formatMemberRemarkLine(entry) {
  if (!entry) return '';
  const name = entry.remark ? `${entry.remark}` : '（未命名）';
  const nick = entry.nick && entry.nick !== entry.remark ? `，QQ 昵称/名片：${entry.nick}` : '';
  const note = entry.note ? `｜${entry.note}` : '';
  return `- ${name}（QQ ${entry.qq}${nick}）${note}`;
}

/** 多行展示（工具返回值用的可读块）。 */
export function formatMemberRemarkList(entries, { empty = '（这个会话还没有成员备注）' } = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return empty;
  return list.map(formatMemberRemarkLine).join('\n');
}
