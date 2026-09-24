// AI 记忆管理自检（src/memory-admin.js）。
//
// 覆盖：清单统计（七类记忆各自的条数与 token 估算）、逐条增删、
//       钉住保护（清空/自然遗忘都必须跳过钉住的条目）、备份与回滚、
//       自然遗忘的三条规则、路径穿越防护。
//
//   node scripts/test-memory-admin.mjs          # 纯函数层（临时目录，不碰真实 state/）
//   node scripts/test-memory-admin.mjs --e2e    # 额外跑一遍真实桥接的 /api/memory* 接口
//
// e2e 会用一个临时 state 目录 + config.json 起桥接（不碰真实 state/），
// 跑完自动关掉；需要本机没有占用它选的端口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryAdmin, MEMORY_KIND, estimateTokens, pinKey, thoughtPinId } from '../src/memory-admin.js';
import { loadMemberStore } from '../src/member-remarks.js';
import { loadStickerStore } from '../src/sticker-lib.js';
import { createKnowledgeEntry } from '../src/knowledge-store.js';
import { createSlangEntry } from '../src/slang-learner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`); }

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── 造一个隔离的「桥接内存态」─────────────────────────────────────────
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-'));
  const files = {
    social: path.join(dir, 'social-v2.json'),
    remarks: path.join(dir, 'member-remarks.json'),
    slang: path.join(dir, 'slang.json'),
    knowledge: path.join(dir, 'knowledge.json'),
    stickers: path.join(dir, 'stickers.json')
  };
  const now = Date.now();
  const social = {
    paused: false,
    conversations: new Map([
      ['group:100', {
        activeTopics: [
          { text: '周末去哪儿玩', lastMentionAt: now - 5 * 60 * 1000, participants: ['甲'], pendingQuestion: '定下来了吗' },
          { text: '早就聊完的老话题', lastMentionAt: now - 3 * DAY }
        ],
        pendingThoughts: [
          { text: '想说一句骚话', motivation: 'sociability', expiresAt: now + HOUR },
          { text: '已经过期的想法', motivation: 'curiosity', expiresAt: now - HOUR }
        ],
        memberImpressions: { 甲: { traits: ['嘴硬心软'], interactionCount: 12 }, 乙: { traits: ['潜水'], interactionCount: 1 } },
        recentMessages: [
          { id: '1', seq: 1, text: '晚上吃啥', time: now - 60000, userId: '1001' },
          { id: '2', seq: 2, text: '随便', time: now - 30000, userId: '1002', isSelf: true }
        ],
        unread: [{ id: '3', seq: 3, text: '在吗', time: now - 10000, userId: '1001' }],
        seenForwardIds: ['fwd-1'],
        lastIncomingAt: now - 10000
      }],
      ['private:200', {
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        recentMessages: [],
        unread: [],
        seenForwardIds: [],
        lastIncomingAt: now - 2 * DAY
      }]
    ])
  };
  const remarks = {
    conversations: {
      'group:100': {
        1001: { qq: '1001', remark: '老王', note: '爱发猫图', nick: '隔壁老王', source: 'ai', createdAt: new Date(now - DAY).toISOString(), updatedAt: new Date(now - DAY).toISOString() },
        1002: { qq: '1002', remark: '小李', note: '学生', nick: '小李', source: 'manual', createdAt: new Date(now - DAY).toISOString(), updatedAt: new Date(now - DAY).toISOString() }
      }
    }
  };
  let slang = [
    createSlangEntry({ content: '班味', meaning: '上班的疲惫气质', status: 'confirmed', source: 'manual' }),
    createSlangEntry({ content: '待考的词', meaning: '', status: 'candidate', source: 'manual' })
  ];
  let knowledge = [
    createKnowledgeEntry({ question: 'DeepSeek 什么时候开源的？', answer: '2023 年 11 月。', kind: 'fact', status: 'confirmed', source: 'manual' }),
    createKnowledgeEntry({ question: '群里能发广告吗？', answer: '不能。', kind: 'rule', status: 'candidate', source: 'manual' })
  ];
  let stickers = [
    { id: 'st-1', desc: '猫猫震惊', localNote: '震惊用', tags: ['震惊'], usage: '被群友整活时', useCount: 3, lastUsedAt: now - 120 * DAY, createdAt: new Date(now - 200 * DAY).toISOString(), updatedAt: new Date(now - 120 * DAY).toISOString() },
    { id: 'st-2', desc: '远古表情', localNote: '很久没用了', tags: ['旧'], usage: '', useCount: 1, lastUsedAt: now - 200 * DAY, createdAt: new Date(now - 300 * DAY).toISOString(), updatedAt: new Date(now - 200 * DAY).toISOString() }
  ];
  const memberStore = loadMemberStore(files.remarks);
  memberStore.conversations = remarks.conversations;

  const saves = { social: 0, members: 0, slang: 0, knowledge: 0, stickers: 0 };
  const admin = createMemoryAdmin({
    stateDir: dir,
    socialFile: files.social,
    memberRemarksFile: files.remarks,
    slangFile: files.slang,
    knowledgeFile: files.knowledge,
    stickerFile: files.stickers,
    agentsFile: path.join(dir, 'AGENTS.md'),
    social,
    memberStore,
    saveSocial: () => { saves.social += 1; fs.writeFileSync(files.social, JSON.stringify({ paused: false, conversations: Object.fromEntries(social.conversations) }, null, 2)); },
    saveMembers: () => { saves.members += 1; fs.writeFileSync(files.remarks, JSON.stringify(memberStore, null, 2)); },
    getSlang: () => slang,
    setSlang: (list) => { slang = list; saves.slang += 1; fs.writeFileSync(files.slang, JSON.stringify(list, null, 2)); },
    getKnowledge: () => knowledge,
    setKnowledge: (list) => { knowledge = list; saves.knowledge += 1; fs.writeFileSync(files.knowledge, JSON.stringify(list, null, 2)); },
    getStickers: () => stickers,
    setStickers: (list) => { stickers = list; saves.stickers += 1; fs.writeFileSync(files.stickers, JSON.stringify(list, null, 2)); },
    sessionMap: () => ({ 'group:100': 'session-abc' }),
    log: () => {}
  });
  return {
    dir, files, social, memberStore, admin, saves,
    // 用 getter/setter 对（而不是只读 getter）：回滚测试里要像真实桥接那样
    // 把「重新 load 出来的集合」赋回内存态，只读 getter 会静默赋值失败。
    get slang() { return slang; }, set slang(v) { slang = v; },
    get knowledge() { return knowledge; }, set knowledge(v) { knowledge = v; },
    get stickers() { return stickers; }, set stickers(v) { stickers = v; }
  };
}

// ── 1. 清单 ──────────────────────────────────────────────────────────
console.log('— 清单（七类记忆各有多少、吃多少 token）—');
{
  const fx = makeFixture();
  const inv = fx.admin.inventory();
  const byId = Object.fromEntries(inv.groups.map((g) => [g.id, g]));
  eq(inv.groups.length, 7, '七类记忆都在清单里');
  eq(byId.session.stats.topics.raw, 2, '进行中的话题 2 条');
  eq(byId.session.stats.thoughts.raw, 2, '想说没说的话 2 条');
  eq(byId.session.stats.impressions.raw, 2, '对群友的印象 2 条');
  eq(byId.members.stats.remarks.raw, 2, '成员备注 2 条');
  eq(byId.slang.total.items, 2, '黑话 2 条');
  eq(byId.knowledge.total.items, 2, '知识 2 条');
  eq(byId.stickers.stats.stickers.items, 2, '收藏表情 2 个');
  eq(byId.stickers.stats.notes.items, 2, '表情笔记 2 条');
  eq(byId.context.stats.sessions, 1, '会话映射 1 条');
  eq(byId.context.stats.messages.items, 3, '对话上下文 3 条');
  ok(byId.session.total.tokens > 0, '会话记忆有 token 估算');
  ok(inv.tokens.injectedPerWake === byId.session.total.tokens, '「每次唤醒注入」= 会话记忆那一类');
  ok(inv.files.some((f) => f.label.includes('钉住表')), '文件清单里有钉住表');
  ok(estimateTokens('中文四个字') === 5, 'token 估算：中文一字≈1');
  ok(estimateTokens('abcdefgh') === 2, 'token 估算：英文 4 字符≈1');
  ok(estimateTokens('') === 0, '空串估算 0');
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ── 2. 逐条查询与删除 ────────────────────────────────────────────────
console.log('— 逐条查 / 删 —');
{
  const fx = makeFixture();
  const topics = fx.admin.items({ kind: MEMORY_KIND.TOPIC });
  eq(topics.total, 2, '列出全部话题');
  const one = fx.admin.items({ kind: MEMORY_KIND.TOPIC, key: 'group:100', q: '周末' });
  eq(one.total, 1, '按会话 + 关键词过滤');
  eq(one.items[0].pendingQuestion, '定下来了吗', '话题带出待追问');
  const remarks = fx.admin.items({ kind: MEMORY_KIND.REMARK, q: '猫图' });
  eq(remarks.total, 1, '备注可按说明搜索');
  eq(remarks.items[0].id, '1001', '备注按 QQ 号索引');
  const ctx = fx.admin.items({ kind: MEMORY_KIND.CONTEXT });
  eq(ctx.total, 3, '对话上下文 2 条已读 + 1 条未读');
  ok(ctx.items.some((m) => m.unread), '未读能区分出来');

  const del = fx.admin.remove({ kind: MEMORY_KIND.TOPIC, key: 'group:100', id: '周末去哪儿玩' });
  eq(del.removed, 1, '删掉一条话题');
  eq(fx.social.conversations.get('group:100').activeTopics.length, 1, '内存态立刻生效');
  ok(fx.saves.social > 0, '删除会落盘');

  const delImp = fx.admin.remove({ kind: MEMORY_KIND.IMPRESSION, key: 'group:100', id: '乙' });
  eq(delImp.removed, 1, '删掉一条对群友的印象');
  const delRemark = fx.admin.remove({ kind: MEMORY_KIND.REMARK, key: 'group:100', id: '1002' });
  eq(delRemark.removed, 1, '删掉一条成员备注');
  eq(Object.keys(fx.memberStore.conversations['group:100']).length, 1, '备注库里只剩 1 个');
  const delSlang = fx.admin.remove({ kind: MEMORY_KIND.SLANG, id: fx.slang[0].id });
  eq(delSlang.removed, 1, '删掉一条黑话');
  const delNote = fx.admin.remove({ kind: MEMORY_KIND.STICKER, id: 'st-1' });
  eq(delNote.removed, 1, '清掉一个表情的笔记');
  eq(fx.stickers.length, 2, '清笔记不会把表情从收藏里删掉');
  eq(fx.stickers[0].localNote, '', '笔记被清空');
  eq(fx.admin.remove({ kind: 'nope', id: 'x' }).ok, false, '未知类型返回错误');
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ── 3. 钉住保护 ──────────────────────────────────────────────────────
console.log('— 钉住（清空时保护）—');
{
  const fx = makeFixture();
  // 话题/想法的钉住标识是后端给的稳定 pinId（话题用下标），控制台也是拿它来钉的
  const topicItems = fx.admin.items({ kind: MEMORY_KIND.TOPIC }).items;
  const weekend = topicItems.find((t) => t.text === '周末去哪儿玩');
  const p1 = fx.admin.setPin({ kind: MEMORY_KIND.TOPIC, key: 'group:100', id: weekend.pinId, reason: '还在聊' });
  ok(p1.ok && p1.pinned, '钉住一条话题');
  const p2 = fx.admin.setPin({ kind: MEMORY_KIND.REMARK, key: 'group:100', id: '1001' });
  ok(p2.ok, '钉住一条成员备注');
  ok(fs.existsSync(path.join(fx.dir, 'memory-pins.json')), '钉住表落盘');
  eq(fx.admin.inventory().pins.total, 2, '清单里能看到 2 条钉住');
  const items = fx.admin.items({ kind: MEMORY_KIND.TOPIC });
  ok(items.items.find((t) => t.text === '周末去哪儿玩').pinned, '列表里标出已钉住');
  eq(weekend.pinId, 'topic:0', '钉住标识是稳定 pinId（下标）而不是会变的原文');

  const cleared = fx.admin.clear({ kind: MEMORY_KIND.TOPIC, key: 'group:100' });
  eq(cleared.ok, true, '清空该会话话题');
  eq(cleared.cleared.topics, 1, '只清掉没钉住的那条');
  eq(cleared.skippedPinned, 1, '报告跳过了 1 条钉住的');
  eq(fx.social.conversations.get('group:100').activeTopics.length, 1, '钉住的话题还在');
  ok(cleared.backup, '清空前自动备份');

  const forced = fx.admin.clear({ kind: MEMORY_KIND.TOPIC, key: 'group:100', includePinned: true, backup: false });
  eq(forced.cleared.topics, 1, 'includePinned 时连钉住的一起清');
  eq(fx.social.conversations.get('group:100').activeTopics.length, 0, '内存态清干净');
  eq(fx.admin.inventory().pins.total, 2, '钉住表本身不会被清空动作删掉');

  const unpin = fx.admin.setPin({ kind: MEMORY_KIND.REMARK, key: 'group:100', id: '1001', pinned: false });
  eq(unpin.pinned, false, '取消钉住');
  ok(unpin.removed, '取消钉住报告确实摘掉了');

  // 删掉一条被钉住的记忆时，钉子要跟着消失，别留下死条目
  fx.admin.setPin({ kind: MEMORY_KIND.REMARK, key: 'group:100', id: '1001' });
  fx.admin.remove({ kind: MEMORY_KIND.REMARK, key: 'group:100', id: '1001' });
  eq(fx.admin.inventory().pins.total, 1, '删掉记忆后钉子自动摘掉');
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ── 4. 自然遗忘 ──────────────────────────────────────────────────────
console.log('— 自然遗忘（按规则，不是一刀切）—');
{
  const fx = makeFixture();
  // 先钉住一条「已经过期的想法」和一个很久没用过的表情笔记：钉住 = 明确不想忘
  // 过期的想法在浏览列表里本就不显示（列表按「AI 现在会看到什么」来），
  // 所以这里直接用同一个 pinId 规则算出它的标识。
  const thoughts = fx.social.conversations.get('group:100').pendingThoughts;
  eq(fx.admin.items({ kind: MEMORY_KIND.THOUGHT }).total, 1, '过期想法不出现在浏览列表里');
  const expiredPinId = thoughtPinId(thoughts[1], 1);
  fx.admin.setPin({ kind: MEMORY_KIND.THOUGHT, key: 'group:100', id: expiredPinId, reason: '单测' });
  fx.admin.setPin({ kind: MEMORY_KIND.STICKER, id: 'st-2' });
  const res = fx.admin.forget({ key: 'group:100' });
  eq(res.ok, true, '自然遗忘能跑通');
  eq(res.forgotten.thoughts, 0, '钉住的过期想法不会被清');
  eq(res.forgotten.stickerNotes, 1, '只清掉没钉住的那条表情笔记');
  eq(res.forgotten.topics, 1, '只清掉搁置超过 24h 的话题');
  eq(res.skippedPinned, 2, '报告跳过 2 条钉住的');
  const st = fx.social.conversations.get('group:100');
  eq(st.pendingThoughts.length, 2, '两条想法都还在（一条没过期、一条钉住了）');
  eq(st.activeTopics.length, 1, '刚聊过的话题留着');
  eq(fx.stickers.find((s) => s.id === 'st-1').localNote, '', '没钉住的表情笔记已按规则清掉');
  eq(fx.stickers.find((s) => s.id === 'st-2').localNote, '很久没用了', '钉住的表情笔记还在');

  // 再跑一次：该清的已经清完，只剩钉住的那些，属于「无事可做」
  const res2 = fx.admin.forget({ key: 'group:100' });
  eq(res2.forgottenTotal, 0, '第二次自然遗忘没有可清的东西');
  eq(fx.admin.inventory().groups.find((g) => g.id === 'slang').total.items, 2, '黑话不会被自然遗忘误伤');

  // 取消钉住后，过期的想法才允许被带走
  fx.admin.setPin({ kind: MEMORY_KIND.THOUGHT, key: 'group:100', id: expiredPinId, pinned: false });
  const res3 = fx.admin.forget({ key: 'group:100' });
  eq(res3.forgotten.thoughts, 1, '取消钉住后，过期的想法被清掉');
  eq(st.pendingThoughts.length, 1, '没过期的想法留着');
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ── 5. 备份 / 回滚 ───────────────────────────────────────────────────
console.log('— 备份与回滚 —');
{
  const fx = makeFixture();
  // 把内存态先落到磁盘（模拟桥接运行中的样子），再打备份
  fs.writeFileSync(fx.files.social, JSON.stringify({ paused: false, conversations: Object.fromEntries(fx.social.conversations) }, null, 2));
  fs.writeFileSync(fx.files.knowledge, JSON.stringify(fx.knowledge, null, 2));
  fs.writeFileSync(fx.files.slang, JSON.stringify(fx.slang, null, 2));
  fs.writeFileSync(fx.files.remarks, JSON.stringify(fx.memberStore, null, 2));
  const backup = fx.admin.backup({ reason: '单测' });
  eq(backup.ok, true, '打一份备份');
  ok(backup.backup.files.includes('social-v2.json'), '备份包含轻量记忆');
  const list = fx.admin.listBackups();
  ok(list.length >= 1, '备份列表非空');
  ok(list[0].managed && list[0].restorable, '自己建的备份标记为可回滚');
  eq(list[0].reason, '单测', '备份原因记进 meta');

  fx.admin.clear({ kind: MEMORY_KIND.KNOWLEDGE, backup: false });
  eq(fx.knowledge.length, 0, '清空知识库');

  let reloaded = [];
  const restored = fx.admin.restoreBackup({
    name: backup.backup.name,
    // 真实桥接注入的是 reloadMemoryState(files)：按文件名重新 load 各个集合，
    // 这里照抄同样的语义——从磁盘重读，而不是回退到某个内存引用。
    reload: (files) => {
      reloaded = files;
      fx.knowledge = JSON.parse(fs.readFileSync(fx.files.knowledge, 'utf8'));
    }
  });
  eq(restored.ok, true, '回滚成功');
  ok(reloaded.includes('knowledge.json'), '回滚后通知上层重载对应文件');
  eq(fx.knowledge.length, 2, '知识库回到清空前（从磁盘重读）');
  ok(restored.safetyBackup && restored.safetyBackup !== backup.backup.name, '回滚前又给当前状态打了一份备份');

  eq(fx.admin.restoreBackup({ name: '../../etc/passwd' }).ok, false, '路径穿越被拒绝');
  eq(fx.admin.restoreBackup({ name: 'memory-不存在' }).ok, false, '不存在的备份被拒绝');
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ── 6. 全清 ──────────────────────────────────────────────────────────
console.log('— 清空全部（保留钉住的）—');
{
  const fx = makeFixture();
  fx.admin.setPin({ kind: MEMORY_KIND.KNOWLEDGE, id: fx.knowledge[0].id, reason: '这条重要' });
  const res = fx.admin.clear({ kind: 'all', reason: '单测全清' });
  eq(res.ok, true, '全清能跑通');
  eq(fx.knowledge.length, 1, '钉住的知识条目留下');
  eq(fx.slang.length, 0, '黑话被清空');
  eq(fx.social.conversations.get('group:100').recentMessages.length, 0, '对话上下文被清空');
  eq(fx.social.conversations.get('group:100').memberImpressions.甲, undefined, '印象被清空');
  eq(Object.keys(fx.memberStore.conversations['group:100']).length, 0, '成员备注被清空');
  ok(res.clearedTotal > 0, '报告清掉的总条数');
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// ── 7. e2e：真实桥接的 HTTP 接口 ─────────────────────────────────────
if (process.argv.includes('--e2e')) {
  console.log('— e2e：/api/memory* 接口 —');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-e2e-'));
  const port = 3399;
  const token = 'test-console-token';
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'console-token'), token, 'utf8');
  const now = Date.now();
  fs.writeFileSync(path.join(stateDir, 'social-v2.json'), JSON.stringify({
    paused: false,
    conversations: {
      'group:555': {
        activeTopics: [{ text: 'e2e 话题', lastMentionAt: now }],
        pendingThoughts: [{ text: 'e2e 想法', expiresAt: now + HOUR }],
        memberImpressions: { 测试甲: { traits: ['靠谱'], interactionCount: 3 } },
        recentMessages: [{ id: '9', seq: 9, text: 'e2e 上下文', time: now }]
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, 'member-remarks.json'), JSON.stringify({
    version: 1,
    conversations: { 'group:555': { 10001: { qq: '10001', remark: 'e2e老王', note: '单测用', nick: '老王', source: 'manual', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } } }
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, 'knowledge.json'), JSON.stringify([
    createKnowledgeEntry({ question: 'e2e 问题', answer: 'e2e 答案', kind: 'fact', status: 'confirmed', source: 'manual' })
  ], null, 2));
  // config.json 必须在 spawn 之前写好：桥接启动时只读一次，晚写就会用默认端口起来
  // （曾经因为这个时序，e2e 偶尔连不上自己起的那个进程）。
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    dsh: { baseUrl: 'http://127.0.0.1:9', authToken: '' },
    snowluma: { wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9' },
    consolePort: port,
    consoleToken: token,
    ownerQQ: 1472298635,
    slang: { enabled: false },
    knowledge: { enabled: false },
    rag: { enabled: false }
  }, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQ_BRIDGE_STATE_DIR: stateDir,
      QQ_BRIDGE_CONFIG: path.join(stateDir, 'config.json'),
      QQ_BRIDGE_CONSOLE_PORT: String(port),
      QQ_BRIDGE_NO_DSH: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d.toString(); });
  child.stderr.on('data', (d) => { childLog += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, routePath, body) => {
    const res = await fetch(base + routePath, {
      method,
      headers: { 'x-console-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const waitUp = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await call('GET', '/api/memory');
        if (r.status === 200) return true;
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  try {
    const up = await waitUp();
    ok(up, '桥接起来了（/api/memory 200）');
    if (up) {
      const inv = await call('GET', '/api/memory');
      const session = inv.json.groups.find((g) => g.id === 'session');
      eq(session.stats.topics.raw, 1, 'e2e：读到真实 state 里的话题');
      // DSH 长期记忆文件的路径解析：DSH_HOME 常常就是 ~/.dsh，别拼成 ~/.dsh/.dsh
      ok(!String(inv.json.agents.path).includes('.dsh/.dsh') && !String(inv.json.agents.path).includes('.dsh\\.dsh'),
        `e2e：AGENTS.md 路径没有重复的 .dsh（${inv.json.agents.path}）`);
      const items = await call('GET', '/api/memory/items?kind=lightTopic');
      eq(items.json.total, 1, 'e2e：items 接口按类型列出');
      const preview = await call('GET', '/api/memory/preview?keys=group:555');
      ok(preview.json.blocks[0].text.includes('e2e 话题'), 'e2e：预览里能看到真正会注入的话题');
      eq(preview.json.blocks[0].remarkCount, 1, 'e2e：预览带出该会话的成员备注数');
      // 控制台钉的是后端给的 pinId（话题用下标），不是会变的原文
      const pinId = items.json.items[0].pinId;
      ok(Boolean(pinId), `e2e：条目带稳定 pinId（${pinId}）`);
      const pin = await call('POST', '/api/memory/pin', { kind: 'lightTopic', key: 'group:555', id: pinId, reason: 'e2e' });
      ok(pin.json.ok && pin.json.pinned, 'e2e：钉住成功');
      const clr = await call('POST', '/api/memory/clear', { kind: 'lightTopic', key: 'group:555' });
      eq(clr.json.clearedTotal, 0, 'e2e：钉住的话题清不掉');
      eq(clr.json.skippedPinned, 0, 'e2e：没清任何东西，所以跳过计数为 0（钉住保护体现在 clearedTotal 上）');
      const still = await call('GET', '/api/memory/items?kind=lightTopic');
      eq(still.json.total, 1, 'e2e：清空之后话题依然在（被钉住保护）');
      ok(still.json.items[0].pinned, 'e2e：列表里标着已钉住');
      const unpin = await call('POST', '/api/memory/pin', { kind: 'lightTopic', key: 'group:555', id: pinId, pinned: false });
      ok(unpin.json.ok, 'e2e：取消钉住');
      const clr2 = await call('POST', '/api/memory/clear', { kind: 'lightTopic', key: 'group:555' });
      eq(clr2.json.clearedTotal, 1, 'e2e：取消钉住后清得掉');
      ok(clr2.json.backup, 'e2e：清空前留了备份');
      const backups = await call('GET', '/api/memory/backups');
      ok(backups.json.backups.length >= 1, 'e2e：备份可列出');
      const restore = await call('POST', '/api/memory/restore', { name: clr2.json.backup });
      ok(restore.json.ok, 'e2e：回滚成功');
      const after = await call('GET', '/api/memory/items?kind=lightTopic');
      eq(after.json.total, 1, 'e2e：回滚后话题回来了');
      const forget = await call('POST', '/api/memory/forget', {});
      eq(forget.json.forgotten.thoughts, 0, 'e2e：没过期的想法不会被自然遗忘');

      // 逐条删除（控制台行内「忘掉」走的就是这个）——删掉后再手动改文件 + reload 抠回来
      const del = await call('POST', '/api/memory/remove', { kind: 'lightTopic', key: 'group:555', id: 'topic:0' });
      eq(del.json.removed, 1, 'e2e：逐条忘掉生效（pinId 定位）');
      eq((await call('GET', '/api/memory/items?kind=lightTopic')).json.total, 0, 'e2e：删完列表为空');
      // 手改 state 文件后必须能重新读盘，否则「文件对了、页面还是旧的」
      const socialPath = path.join(stateDir, 'social-v2.json');
      const raw = JSON.parse(fs.readFileSync(socialPath, 'utf8'));
      raw.conversations['group:555'].activeTopics = [{ text: '手改回来的话题', lastMentionAt: Date.now() }];
      fs.writeFileSync(socialPath, JSON.stringify(raw, null, 2));
      const reload = await call('POST', '/api/memory/reload', {});
      eq(reload.json.ok, true, 'e2e：重新读盘成功');
      const back = await call('GET', '/api/memory/items?kind=lightTopic');
      eq(back.json.total, 1, 'e2e：读盘后拿到手改的那条');
      eq(back.json.items[0].text, '手改回来的话题', 'e2e：内容就是磁盘上的内容');

      // AI 的 agent token 不许碰管理接口：带上合法 console token 也照样拒绝，
      // 否则这里量到的只是「没带 console token」的 401，测不出真正要守的那条线。
      const denied = await fetch(base + '/api/memory', {
        headers: { 'x-console-token': token, 'x-agent-token': 'whatever' }
      });
      eq(denied.status, 403, 'e2e：带 agent token 一律 403（管理接口不给 AI 用）');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    if (fail && childLog) console.log('--- 桥接日志尾部 ---\n' + childLog.split('\n').slice(-25).join('\n'));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} 项通过${fail ? `，${fail} 项失败 ❌` : '，全部通过 ✅'}`);
if (fail) process.exit(1);
