// AI 工具与外围能力路由：消息/转发/备注/发送、记忆、插件、语音、手机、豆包。
//
// 从 bridge.js 抽出的控制台路由。依赖由工厂函数注入：
// 稳定的函数/常量按值传入；会被重新赋值的绑定用 getter/setter（模块内以 deps.xxx 访问）。

export function createAgentRoutes(deps) {
  const {
    CARD_TEXT_LIMIT,
    FEEDBACK_FILE,
    MEMBER_REMARKS_PER_KEY_MAX,
    ROOT,
    SENSITIVE_RE,
    STATE_DIR,
    TOOL_LOG_FILE,
    addClip,
    agentTokenOk,
    anyAgentTokenOk,
    appendActivity,
    appendFeedbackEntry,
    appendMemoryV2,
    archiveStatsOf,
    atomicWriteJson,
    bot,
    cfg,
    clipPath,
    conversationRemarks,
    createPack,
    feedbackTimes,
    fetchMediaData,
    findMemberRemark,
    fitMediaBuffer,
    formatForwardResponse,
    formatMemberRemarkList,
    formatMemoryV2,
    fs,
    getDoubaoChannel,
    getSocialV2State,
    groupAvatarUrl,
    listMemberRemarks,
    listPacks,
    log,
    memberAvatarUrl,
    memberCardCooldown,
    memoryAdmin,
    memoryPreview,
    modeAllowed,
    normalizeUserId,
    path,
    phoneAct,
    phoneBili,
    phoneEnsureUnlocked,
    phonePostMoment,
    phonePrepare,
    phoneScreenshot,
    phoneShell,
    phoneShopping,
    phoneStatus,
    phoneUnprepare,
    phoneWake,
    pluginToolName,
    postOneBot,
    readFeedbackEntries,
    readJsonSafe,
    readToolLog,
    recordSentMessagesV2,
    redactKnownTokensOnly,
    reloadMemoryState,
    removeClip,
    removeMemberRemark,
    removePack,
    resolveFfmpegPath,
    resolveGroupMemberName,
    resolveGroupRoles,
    resolveReplyInfo,
    resolveReplyTargetV2,
    safeFetchToFile,
    saveMemberStoreSafe,
    saveSocialV2State,
    scanPlugins,
    scheduleReplyCheckV2,
    searchArchive,
    seenForwardIds,
    sendMessagesV2,
    setMemberRemark,
    sharp,
    shouldBlockSilentReply,
    socialV2,
    spawn,
    unquoteJsonString,
  } = deps;

  async function handleActivityRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ok: true, entries: readToolLog(limit) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      try {
        fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8');
      } catch {}
      log('控制台：工具调用日志已清空');
      sendJson({ ok: true });
      return;
    }
    // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
      sendJson({ ok: true, entries: readFeedbackEntries() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      atomicWriteJson(FEEDBACK_FILE, []);
      log('控制台：清空 AI 反馈');
      sendJson({ ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
      const rawMessage = String(body.message ?? '').trim();
      if (!key || !rawMessage) {
        sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) {
        sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403);
        return;
      }
      // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
      const fNow = Date.now();
      const fTimes = feedbackTimes.get(key) || [];
      const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
      const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
      if (fRecentMinute >= 5 || fRecentHour >= 20) {
        sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
        return;
      }
      fTimes.push(fNow);
      feedbackTimes.set(key, fTimes.slice(-100));
      const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
      const message = rawMessage.slice(0, maxLength);
      appendFeedbackEntry({
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        key,
        level,
        message,
        time: new Date().toISOString(),
      });
      log(`[chat] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
      appendActivity(`${key} [chat] AI 反馈 [${level}]：${message.slice(0, 80)}`);
      if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
        log(`[chat] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
      }
      sendJson({ ok: true, key, level, message });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
      sendJson({ ok: true, key, messages: mine });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
      // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
      sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const messageId = String(url.searchParams.get('messageId') ?? '').trim();
      if (!key || !messageId) {
        sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      try {
        const st = getSocialV2State(key);
        const found = (st.recentMessages || []).find(
          (m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)),
        );
        const forwardFields = found
          ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward,
            }
          : {};
        let info = null;
        // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
        if (found && found.messageId && String(found.messageId) !== messageId) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, found.card ? CARD_TEXT_LIMIT : 200),
            userId: found.userId ? String(found.userId) : null,
            messageId: String(found.messageId),
            seq: found.seq,
            card: found.card ?? null,
          };
        } else {
          info = await resolveReplyInfo(kind, id, messageId);
          if (!info && found) {
            info = {
              sender: String(found.sender || ''),
              text: String(found.text || found.plain || '').slice(0, found.card ? CARD_TEXT_LIMIT : 200),
              userId: found.userId ? String(found.userId) : null,
              messageId: found.messageId ? String(found.messageId) : null,
              seq: found.seq,
              card: found.card ?? null,
            };
          }
        }
        // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
        if (info && found) Object.assign(info, forwardFields);
        sendJson({ ok: true, key, messageId, info });
      } catch (error) {
        sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleForwardRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2ToolEnabled, v2SessionAllowed } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const id = String(url.searchParams.get('id') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (!id) {
        sendJson({ ok: false, error: 'id 不能为空' }, 400);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '合并转发查看仅 chat 模式可用' }, 403);
        return;
      }
      if (!agentToken) {
        sendJson({ ok: false, error: 'chat 模式读取合并转发必须携带 agent token' }, 403);
        return;
      }
      if (!agentTokenOk(key, agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const num = Number(keyMatch[2]);
      if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      if (!v2ToolEnabled('getForwardMsg')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
        return;
      }
      // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
      const st = getSocialV2State(key);
      const seenInRecent = (st?.recentMessages || []).some(
        (m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id),
      );
      const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
      const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
      if (!seenInRecent && !seenInUnread && !seenInMemory) {
        sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
        return;
      }
      try {
        const fwdCfg = cfg.socialV2?.forward ?? {};
        const clampNum = (v, dflt, min, max) => {
          // 注意：URLSearchParams.get() 缺参数时返回的是 **null**，而 Number(null) === 0，
          // 会被当成「显式传了 0」压到下限，线上表现就是「没传 limit 时本层只给 1 条」。
          if (v === null || v === undefined || v === '') return dflt;
          const n = Number(v);
          return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
        };
        const msgOffset = clampNum(url.searchParams.get('offset'), 0, 0, 5000);
        const msgLimit = clampNum(url.searchParams.get('limit'), clampNum(fwdCfg.messageLimit, 50, 1, 100), 1, 100);
        const nestedDepth = clampNum(fwdCfg.nestedDepth, 2, 0, 3);
        const maxNested = clampNum(fwdCfg.maxNestedForwards, 10, 0, 20);
        const nestedChars = clampNum(fwdCfg.nestedChars, 300, 40, 2000);
        // 整次请求最多再抓几条嵌套转发：嵌套会分叉，没有总预算的话一条
        // 「转发里套十个转发、每个再套十个」就能放大成上百次 OneBot 调用。
        let nestedBudget = clampNum(fwdCfg.nestedFetchBudget, 20, 0, 60);
        const remember = (fid) => {
          if (!fid) return;
          let set = seenForwardIds.get(key);
          if (!set) {
            set = new Set();
            seenForwardIds.set(key, set);
          }
          set.add(fid);
          if (set.size > 1000) {
            for (const old of set) {
              set.delete(old);
              if (set.size <= 1000) break;
            }
          }
        };
        const data = await bot.raw('get_forward_msg', { id });
        const formatted = formatForwardResponse(data, {
          maxMessages: msgLimit,
          offset: msgOffset,
          maxCharsPerMessage: clampNum(fwdCfg.messageChars, 500, 40, 2000),
        });
        // 本层出现的嵌套 id 先登记成「本会话已见过」，AI 之后可以直接拿它再查。
        const collectNestedIds = (level) => {
          const out = [];
          const seen = new Set();
          for (const m of level?.messages || []) {
            for (const fid of m.nestedForwardIds || []) {
              remember(fid);
              if (!seen.has(fid) && out.length < maxNested) {
                seen.add(fid);
                out.push(fid);
              }
            }
          }
          return out;
        };
        const seenIds = new Set([id]);
        /**
         * 递归展开嵌套转发。
         *
         * 以前只抓一层、每个只给「3 条 × 120 字」的预览，线上那条多层转发里内层有 18 条，
         * AI 只能看到 3 条，表现就是「多层合并转发只看得见最外面一层」。现在按层递归
         * （默认 2 层），每层给足条数，并受总抓取预算约束。
         */
        const expandNested = async (level, depth) => {
          if (depth >= nestedDepth || nestedBudget <= 0) return [];
          const ids = collectNestedIds(level);
          const out = [];
          for (const fid of ids) {
            if (seenIds.has(fid) || nestedBudget <= 0) continue;
            seenIds.add(fid);
            nestedBudget -= 1;
            try {
              const ndata = await bot.raw('get_forward_msg', { id: fid });
              const deep = depth > 0; // 越深给得越少，免得深层把上下文吃光
              const nfmt = formatForwardResponse(ndata, {
                maxMessages: deep
                  ? clampNum(fwdCfg.nestedDeepMessages, 8, 1, 50)
                  : clampNum(fwdCfg.nestedMessages, 12, 1, 50),
                maxCharsPerMessage: deep ? Math.max(80, Math.round(nestedChars / 2)) : nestedChars,
              });
              const children = await expandNested(nfmt, depth + 1);
              out.push({ id: fid, ...nfmt, ...(children.length ? { children } : {}) });
            } catch (error) {
              log(`嵌套转发展开失败 ${key} ${fid}:`, error?.message ?? error);
              out.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
            }
          }
          return out;
        };
        const nestedPreviews = await expandNested(formatted, 0);
        const note = [
          `本层共 ${formatted.total} 条${formatted.hasMore ? `，本次给了第 ${msgOffset + 1}~${msgOffset + formatted.messages.length} 条，剩下的用 offset=${msgOffset + formatted.messages.length} 再查一次` : ''}。`,
          '本层里显示成 `[转发]` 的消息是**嵌套的合并转发**，已经展开在 nestedPreviews 里（再深一层在各自的 children 里）。',
          '要看某个嵌套转发的**完整**内容（而不只是预览），用同一个工具、把 id 换成嵌套里那个 id 再查一次；嵌套里再套的也一样，可以一层层查下去。',
        ].join('');
        sendJson({ ok: true, key, id, ...formatted, nestedPreviews, note });
      } catch (error) {
        log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const media = Array.isArray(body.media) ? body.media : [];
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '转发媒体读取仅 chat 模式可用' }, 403);
        return;
      }
      const fwdCfg = cfg.socialV2?.forward ?? {};
      const maxLimit = Math.max(1, Math.min(64, Number(fwdCfg.maxImageLimit) || 20));
      const offset = Math.max(0, Math.min(500, Number(body.offset) || 0));
      const limit = Math.max(1, Math.min(maxLimit, Number(body.limit) || Number(fwdCfg.imageLimit) || 8));
      if (!media.length) {
        sendJson({ ok: true, key, media: [], images: [], total: 0, offset, limit, hasMore: false });
        return;
      }
      const windowed = media.slice(offset, offset + limit);
      try {
        const images = await fetchMediaData(windowed, {
          maxCount: limit,
          maxTotalBytes: Number(fwdCfg.maxTotalBytes) || 16 * 1024 * 1024,
        });
        // index 是「这一窗里的第几张」，换算回它在整条转发里的序号，AI 才知道进度。
        for (const img of images) {
          if (img && Number.isFinite(Number(img.index))) img.index = Number(img.index) + offset;
        }
        sendJson({
          ok: true,
          key,
          media: windowed,
          images,
          total: media.length,
          offset,
          limit,
          hasMore: offset + windowed.length < media.length,
        });
      } catch (error) {
        log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
        sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      // 群身份要跟「桥接管理员」分清楚：isOwner 一直表示 ownerQQ（控制台里那个人），
      // 线上被 AI 读成了「群主」。这里改名为 isBridgeAdmin，并额外标注真实 QQ 群身份 groupRole。
      const roles = key.startsWith('group:') ? await resolveGroupRoles(key.split(':')[1]) : null;
      const roleZh = (r) => (r === 'owner' ? '群主' : r === 'admin' ? '群管理员' : r === 'member' ? '普通成员' : '');
      const map = new Map();
      for (const m of st.recentMessages) {
        if (!m || m.isSelf) continue;
        const uid = m.userId ? String(m.userId) : '';
        const key2 = uid || String(m.sender || '未知');
        const cur = map.get(key2) || {
          sender: m.sender || key2,
          userId: uid || undefined,
          count: 0,
          lastTime: 0,
          isBridgeAdmin: !!m.isOwner,
        };
        if (!cur.userId && uid) cur.userId = uid;
        cur.count += 1;
        if (m.time > cur.lastTime) cur.lastTime = m.time;
        if (m.isOwner) cur.isBridgeAdmin = true;
        map.set(key2, cur);
      }
      const members = [...map.values()]
        .sort((a, b) => b.count - a.count || b.lastTime - a.lastTime)
        .slice(0, limit)
        .map((m) => {
          const role = roles && m.userId ? (roles.get(String(m.userId)) ?? null) : null;
          return {
            ...m,
            groupRole: role,
            groupRoleLabel: roleZh(role),
            avatar: memberAvatarUrl(m.userId || m.user_id),
          };
        });
      sendJson({
        ok: true,
        key,
        note: 'isBridgeAdmin=桥接管理员（ownerQQ，控制台里配置 AI 的人），不是 QQ 群主；群身份看 groupRole（owner=群主/admin=群管理员/member=普通成员）。',
        members,
        groupAvatar: key.startsWith('group:') ? groupAvatarUrl(key.split(':')[1]) : '',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
      if (!key || !category || !content) {
        sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400);
        return;
      }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return;
      }
      if (category === 'memberImpression' && !String(extra.target || '').trim()) {
        sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) {
        sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      appendMemoryV2(st, category, content, extra);
      sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const oldContent = String(body.oldContent ?? '').trim();
      const target = redactKnownTokensOnly(String(body.target ?? '').trim());
      const newContent =
        body.newContent !== undefined && body.newContent !== null
          ? redactKnownTokensOnly(String(body.newContent).trim())
          : undefined;
      const newExtra =
        body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
      const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
      const cleanNewExtra = {
        ...newExtra,
        pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
        participants: Array.isArray(newExtra.participants)
          ? newExtra.participants.map((p) => redactExtra(p))
          : undefined,
        motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
        target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined,
      };
      if (!key || !category) {
        sendJson({ ok: false, error: 'key/category 不能为空' }, 400);
        return;
      }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return;
      }
      if (category === 'memberImpression' && !target) {
        sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400);
        return;
      }
      if (category !== 'memberImpression' && !oldContent) {
        sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) {
        sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) {
          sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404);
          return;
        }
        if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.pendingQuestion !== undefined)
          st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
        if (Array.isArray(cleanNewExtra.participants))
          st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) {
          sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404);
          return;
        }
        if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.motivation !== undefined)
          st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
        if (cleanNewExtra.expiresAtMs !== undefined)
          st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        const oldTarget = target;
        if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) {
          sendJson({ ok: false, error: '非法的群友名字' }, 400);
          return;
        }
        const im = st.memberImpressions[oldTarget] || {};
        const newTarget = String(cleanNewExtra.target || oldTarget).trim();
        if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) {
          sendJson({ ok: false, error: '非法的群友名字' }, 400);
          return;
        }
        if (newContent !== undefined) {
          im.traits = newContent
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 20);
        }
        if (cleanNewExtra.interactionCount !== undefined)
          im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
        if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
        st.memberImpressions[newTarget] = im;
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const category = String(url.searchParams.get('category') ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) {
        sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      const raw = {
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts)
          ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20)
          : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
      };
      if (category === 'activeTopic') {
        raw.pendingThoughts = [];
        raw.memberImpressions = {};
      } else if (category === 'pendingThought') {
        raw.activeTopics = [];
        raw.memberImpressions = {};
      } else if (category === 'memberImpression') {
        raw.activeTopics = [];
        raw.pendingThoughts = [];
      }
      // 成员备注单独返回：它不在 social-v2 状态里，但控制台的「记忆」面板要一起显示。
      const remarkList = listMemberRemarks(deps.memberStore, key, { limit: MEMBER_REMARKS_PER_KEY_MAX });
      sendJson({
        ok: true,
        key,
        category,
        formatted: formatMemoryV2({ ...st, ...raw }),
        raw,
        memberRemarks: remarkList.entries,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const target = String(body.target ?? '').trim();
      if (!key || !category) {
        sendJson({ ok: false, error: 'key/category 不能为空' }, 400);
        return;
      }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return;
      }
      if (category === 'memberImpression' && !target) {
        sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400);
        return;
      }
      if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) {
        sendJson({ ok: false, error: '非法的群友名字' }, 400);
        return;
      }
      if (category !== 'memberImpression' && !content) {
        sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) {
        sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        delete st.memberImpressions[target];
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) {
        sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      if (!category || category === 'activeTopic') st.activeTopics = [];
      if (!category || category === 'pendingThought') st.pendingThoughts = [];
      if (!category || category === 'memberImpression') st.memberImpressions = {};
      saveSocialV2State();
      sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
      return;
    }
  }
  async function handleMemberRemarkRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/member-remarks') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const q = String(url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(MEMBER_REMARKS_PER_KEY_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memberRemark')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_member_remarks' }, 403);
        return;
      }
      const result = listMemberRemarks(deps.memberStore, key, { q, limit });
      // 带 q 时额外给一条「最像的那个」：AI 常拿群里看到的名字来问「这是谁」。
      const match = q ? findMemberRemark(deps.memberStore, key, q) : null;
      sendJson({
        ok: true,
        key,
        total: result.total,
        allTotal: result.allTotal,
        match: match ?? null,
        entries: result.entries,
        block: formatMemberRemarkList(result.entries, {
          empty: q ? `没有匹配「${q}」的成员备注` : '（这个会话还没有成员备注；可以用 qq_set_member_remark 记一条）',
        }),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/member-remark') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const userId = String(body.userId ?? body.qq ?? '').trim();
      if (!key || !userId) {
        sendJson({ ok: false, error: 'key 和 userId 不能为空' }, 400);
        return;
      }
      if (!normalizeUserId(userId)) {
        sendJson({ ok: false, error: 'userId 必须是正整数 QQ 号' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memberRemark')) {
        sendJson({ ok: false, error: '工具未启用：qq_set_member_remark' }, 403);
        return;
      }
      if (body.remark === undefined && body.note === undefined && body.nick === undefined) {
        sendJson({ ok: false, error: '至少要传 remark / note / nick 之一；想删除请用 qq_remove_member_remark' }, 400);
        return;
      }
      // 顺手补一份昵称快照：群友改昵称后，AI 还能对上「当初记的是谁」。失败不影响写入。
      let nick = body.nick !== undefined && body.nick !== null ? String(body.nick) : undefined;
      if (nick === undefined && key.startsWith('group:')) {
        const groupId = Number(key.slice(6));
        try {
          const cached = await resolveGroupMemberName(groupId, userId);
          if (cached) nick = cached;
        } catch {
          /* 缓存/WS 不可用，下面直接查一次 */
        }
        if (!nick) {
          // 优先走 postOneBot（WS 失败自动回退 HTTP），WS 正在重连时也能拿到快照。
          try {
            const info = await postOneBot(
              'get_group_member_info',
              { group_id: groupId, user_id: Number(userId) },
              { timeoutMs: 5000, retries: 0 },
            );
            const snap = info?.card || info?.nickname;
            if (snap) nick = String(snap);
          } catch {
            /* 网关不支持就留空 */
          }
        }
      }
      const { entry, removed } = setMemberRemark(deps.memberStore, key, userId, {
        remark: body.remark === undefined || body.remark === null ? undefined : String(body.remark),
        note: body.note === undefined || body.note === null ? undefined : String(body.note),
        nick,
        source: req.headers['x-agent-token'] ? 'ai' : 'manual',
      });
      if (entry || removed) saveMemberStoreSafe();
      if (entry) log(`[member-remark] ${key} 记录备注 QQ ${entry.qq} -> ${entry.remark || '（无短名）'}`);
      else if (removed) log(`[member-remark] ${key} 备注为空，已删除 QQ ${userId}`);
      sendJson({
        ok: true,
        key,
        removed,
        entry: entry ?? null,
        total: Object.keys(conversationRemarks(deps.memberStore, key)).length,
        block: formatMemberRemarkList(Object.values(conversationRemarks(deps.memberStore, key))),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/member-remark-remove') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const userId = String(body.userId ?? body.qq ?? '').trim();
      if (!key || !userId) {
        sendJson({ ok: false, error: 'key 和 userId 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memberRemark')) {
        sendJson({ ok: false, error: '工具未启用：qq_remove_member_remark' }, 403);
        return;
      }
      const removed = removeMemberRemark(deps.memberStore, key, userId);
      if (removed) {
        saveMemberStoreSafe();
        log(`[member-remark] ${key} 删除备注 QQ ${userId}`);
      }
      sendJson({
        ok: true,
        key,
        removed,
        total: Object.keys(conversationRemarks(deps.memberStore, key)).length,
        block: formatMemberRemarkList(Object.values(conversationRemarks(deps.memberStore, key))),
      });
      return;
    }
    // 真·QQ 群名片（set_group_card）：默认关闭，需要机器人是管理员/群主，且全群可见。
    // 这是写操作，只适合做「正名」，不该拿来当 AI 的私有记忆，私有记忆走上面的备注库。
    if (req.method === 'POST' && url.pathname === '/api/socialV2/set-member-card') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const userId = String(body.userId ?? body.qq ?? '').trim();
      const card =
        body.card === undefined || body.card === null
          ? ''
          : String(body.card)
              .replace(/[\r\n\t]+/g, ' ')
              .trim()
              .slice(0, 60);
      if (!key || !userId) {
        sendJson({ ok: false, error: 'key 和 userId 不能为空' }, 400);
        return;
      }
      if (!normalizeUserId(userId)) {
        sendJson({ ok: false, error: 'userId 必须是正整数 QQ 号' }, 400);
        return;
      }
      if (!key.startsWith('group:')) {
        sendJson({ ok: false, error: '群名片只能在群聊会话里设置' }, 400);
        return;
      }
      // 默认关闭：必须由管理员在控制台显式打开 socialV2.tools.setMemberCard。
      if (cfg.socialV2?.tools?.setMemberCard !== true) {
        sendJson({ ok: false, error: '该工具未启用（需要在控制台打开 socialV2.tools.setMemberCard）' }, 403);
        return;
      }
      if (req.headers['x-agent-token']) {
        if (deps.currentMode !== 'chat') {
          sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
          return;
        }
        if (!agentTokenOk(key, req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: 'agent token 无效' }, 403);
          return;
        }
        if (!v2SessionAllowed(key)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (socialV2.paused) {
          sendJson({ ok: false, error: 'AI 已暂停，不能改群名片' }, 403);
          return;
        }
      } else if (deps.currentMode === 'chat') {
        // chat 下不允许「无 token 的管理端」绕过：控制台请走备注库或切模式后再改。
        sendJson({ ok: false, error: 'chat 模式下改群名片必须携带 agent token' }, 403);
        return;
      }
      const groupId = Number(key.slice(6));
      const lastAt = memberCardCooldown.get(`${key}:${userId}`) || 0;
      const cooldownMs = 15000;
      if (Date.now() - lastAt < cooldownMs) {
        sendJson(
          { ok: false, error: `改群名片太频繁，请 ${Math.ceil((cooldownMs - (Date.now() - lastAt)) / 1000)} 秒后再试` },
          429,
        );
        return;
      }
      try {
        await postOneBot(
          'set_group_card',
          { group_id: groupId, user_id: Number(userId), card },
          { timeoutMs: 10000, retries: 1 },
        );
        memberCardCooldown.set(`${key}:${userId}`, Date.now());
        // 有界：冷却表只用来防抖，超过 500 条就丢最早的一批。
        if (memberCardCooldown.size > 500) {
          for (const old of [...memberCardCooldown.keys()].slice(0, memberCardCooldown.size - 500))
            memberCardCooldown.delete(old);
        }
        log(`[member-card] ${key} 群名片 QQ ${userId} -> ${card ? `「${card}」` : '（已清除）'}`);
        appendActivity(`${key} [群名片] ${userId} -> ${card || '清除'}`);
        sendJson({ ok: true, key, userId, card, note: card ? '已修改群名片（全群可见）' : '已清除群名片' });
      } catch (error) {
        sendJson({ ok: false, error: `改群名片失败：${error?.message ?? error}（机器人需要是管理员/群主）` }, 500);
      }
      return;
    }
  }
  async function handleSendRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2ToolEnabled } = routeCtx;
    if (
      req.method === 'POST' &&
      (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')
    ) {
      const body = await readBody();
      const token = String(body.token ?? '').trim();
      const isPrivate = url.pathname === '/api/send/private';
      const isReply = url.pathname === '/api/send/reply';
      const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
      const message = unquoteJsonString(String(body.message ?? '').trim());
      const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
      if (socialV2.paused && token) {
        sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
        return;
      }
      if (!targetId || !message) {
        sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400);
        return;
      }
      if (isPrivate && atUserId) {
        sendJson({ ok: false, error: '私聊不需要 @' }, 400);
        return;
      }
      if (
        isReply &&
        (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')
      ) {
        sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
        return;
      }
      if (deps.currentMode === 'chat' && !token) {
        sendJson({ ok: false, error: 'chat 模式发送必须携带 agent token' }, 403);
        return;
      }
      if (token && !agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const flag = isPrivate ? 'sendPrivate' : isReply ? 'reply' : 'sendGroup';
      if (token && !v2ToolEnabled(flag)) {
        sendJson({ ok: false, error: `工具未启用：${flag}` }, 403);
        return;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式无效' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (
        replyToMessageId !== undefined &&
        replyToMessageId !== null &&
        String(replyToMessageId).trim() !== '' &&
        !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())
      ) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return;
      }
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const stForReply = getSocialV2State(key);
        const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          sendJson(
            {
              ok: false,
              error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）',
            },
            400,
          );
          return;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (message.length > maxChars) {
        sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
        return;
      }
      if (SENSITIVE_RE.test(message)) {
        sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
        return;
      }
      // st/now 必须留在 try 外面：catch 里回滚发送额度时要用（原来写在 try 内，
      // 一旦发送失败，catch 反而抛 ReferenceError，真实错误被盖成 500）。
      const st = getSocialV2State(key);
      const now = Date.now();
      try {
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
        recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        saveSocialV2State();
        log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
        appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
        if (sentMessages.length > 0) scheduleReplyCheckV2(key);
        sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
      } catch (error) {
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
        }
        // 失败/未发出的消息回滚预占的发送额度，避免假 429。
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, 1 - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        sendJson(
          {
            ok: false,
            error: error?.message ?? String(error),
            // 回执超时且历史查不到：这条可能已经发出。让上游（MCP）据此提示模型「别原样重发」。
            ...(error?.uncertain === true
              ? {
                  uncertain: true,
                  hint: '这条可能已经发出（回执超时、历史里也没查到）：不要原样重发，先用 qq_get_recent_messages 确认最后几条。',
                }
              : {}),
            // 自我重复闸门：**没发出去**，是有意打回，让模型换个题再说（这不是错误）。
            ...(error?.selfRepeat === true ? { selfRepeat: true, detail: error?.detail ?? null } : {}),
            // 原样重发闸门：也是**有意拒发**，让 MCP 返回非错误结果、别诱导模型反复重试。
            ...(error?.duplicateGuard === true ? { duplicateGuard: true, detail: error?.detail ?? null } : {}),
          },
          500,
        );
      }
      return;
    }
  }
  async function handleShareMediaRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-media') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const kind = String(body.kind ?? 'music') === 'video' ? 'video' : 'music';
      const mediaUrl = String(body.url ?? '').trim();
      const title = String(body.title ?? '').slice(0, 80);
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const km = /^(group|private):(\d+)$/.exec(key);
      if (!km) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (!/^https?:\/\//i.test(mediaUrl)) {
        sendJson({ ok: false, error: 'url 必须是公网 http(s)' }, 400);
        return;
      }
      if (agentToken && !agentTokenOk(key, agentToken) && !anyAgentTokenOk(agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const gid = Number(km[2]);
      const textOf = () => (title ? `${title}\n${mediaUrl}` : mediaUrl);
      const sendText = async () => {
        const seg = [{ type: 'text', data: { text: textOf() } }];
        const r =
          km[1] === 'group'
            ? await bot.raw('send_group_msg', { group_id: gid, message: seg })
            : await bot.raw('send_private_msg', { user_id: gid, message: seg });
        recordSentMessagesV2(key, [textOf()]);
        return r?.data?.message_id ?? r?.message_id ?? null;
      };
      const tmp = path.join(STATE_DIR, `media-${Date.now()}.bin`);
      try {
        const got = await safeFetchToFile(mediaUrl, 20 * 1024 * 1024, tmp, { timeoutMs: 60000 });
        const b64 = fs.readFileSync(tmp).toString('base64');
        const segs =
          kind === 'video'
            ? [{ type: 'video', data: { file: 'base64://' + b64 } }]
            : [{ type: 'record', data: { file: 'base64://' + b64 } }];
        let ok = false,
          mid = null,
          reason = '';
        try {
          const r =
            km[1] === 'group'
              ? await bot.raw('send_group_msg', { group_id: gid, message: segs })
              : await bot.raw('send_private_msg', { user_id: gid, message: segs });
          // 注意 bot.raw() 返回的是 OneBot 的 **data 字段本身**（{message_id}），不是整包响应；
          // 只认 data.message_id 会把成功误判成失败，接着又补发一条文本（线上真事）。
          const gotMid = r?.message_id ?? r?.data?.message_id ?? null;
          if (gotMid != null || r?.status === 'ok') {
            ok = true;
            mid = gotMid;
          } else reason = JSON.stringify(r).slice(0, 120);
        } catch (error) {
          reason = String(error?.message ?? error).slice(0, 120);
        }
        if (ok) {
          recordSentMessagesV2(key, [`[${kind === 'video' ? '视频' : '音频'}] ${title || mediaUrl}`]);
          log(`[media] 已发${kind === 'video' ? '视频' : '音频'} ${key}（${Math.round(got.bytes / 1024)}KB）`);
          sendJson({ ok: true, key, messageId: mid, kind, bytes: got.bytes, fallback: false });
          return;
        }
        // 视频段/语音段都已实测可用（retcode 0）；这里只在**真失败**时降级成标题+链接
        log(`[media] ${kind} 段发送失败（${reason}），降级为文本链接`);
        const mid2 = await sendText();
        sendJson({
          ok: true,
          key,
          messageId: mid2,
          kind,
          fallback: true,
          note: `媒体段发不出去（${reason}），已降级为标题+链接`,
        });
        return;
      } catch (error) {
        try {
          const mid3 = await sendText();
          sendJson({
            ok: true,
            key,
            messageId: mid3,
            kind,
            fallback: true,
            note: `下载/发送失败（${String(error?.message ?? error).slice(0, 80)}），已降级为标题+链接`,
          });
        } catch (e2) {
          sendJson({ ok: false, error: `分享失败：${String(e2?.message ?? e2)}` }, 500);
        }
        return;
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  async function handleMemoryApiRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/socialV2/memory') {
      const body = req.method === 'POST' ? await readBody() : {};
      const key = String(body.key ?? url.searchParams.get('key') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const op = String(body.op ?? url.searchParams.get('op') ?? '').trim();
      if (!/^(group|private):\d+$/.test(key)) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (agentToken && !agentTokenOk(key, agentToken) && !anyAgentTokenOk(agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      try {
        if (op === 'search') {
          const sinceDays = Math.max(0, Number(body.sinceDays) || 0);
          const since = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;
          const hits = searchArchive({
            stateDir: STATE_DIR,
            key,
            query: String(body.query ?? ''),
            since,
            limit: Number(body.limit) || 20,
          });
          const stats = archiveStatsOf({ stateDir: STATE_DIR, key });
          sendJson({
            ok: true,
            key,
            hits,
            stats,
            note: hits.length ? '' : '归档里没搜到（可能超出保留天数，或说法不一样）',
          });
          return;
        }
        if (op === 'recall') {
          const query = String(body.query ?? '').trim();
          const anchors = query
            ? searchArchive({ stateDir: STATE_DIR, key, query, limit: Number(body.limit) || 8 })
            : [];
          sendJson({
            ok: true,
            key,
            query,
            anchors,
            note: '直接从完整归档里捞原文锚点（日记已废弃）；别凭日记把细节说死',
          });
          return;
        }
        sendJson({ ok: false, error: '未知 op（search / recall）' }, 400);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }
  async function handleMemoryAdminRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      const action = url.pathname === '/api/memory' ? '' : url.pathname.slice('/api/memory/'.length);
      try {
        if (req.method === 'GET' && (action === '' || action === 'inventory')) {
          sendJson(memoryAdmin.inventory());
          return;
        }
        if (req.method === 'GET' && action === 'items') {
          sendJson(
            memoryAdmin.items({
              kind: String(url.searchParams.get('kind') ?? '').trim(),
              key: String(url.searchParams.get('key') ?? '').trim(),
              q: String(url.searchParams.get('q') ?? '').trim(),
              limit: Number(url.searchParams.get('limit')) || 300,
            }),
          );
          return;
        }
        if (req.method === 'GET' && action === 'backups') {
          sendJson({ ok: true, backups: memoryAdmin.listBackups(), backupRoot: memoryAdmin.backupRoot });
          return;
        }
        if (req.method === 'GET' && action === 'preview') {
          const keys = String(url.searchParams.get('keys') ?? '')
            .split(',')
            .map((k) => k.trim())
            .filter((k) => /^(group|private):\d+$/.test(k));
          sendJson(memoryPreview(keys.length ? keys : [...socialV2.conversations.keys()]));
          return;
        }
        if (req.method !== 'POST') {
          sendJson({ ok: false, error: `不支持的请求：${req.method} ${url.pathname}` }, 405);
          return;
        }
        const body = await readBody();
        if (action === 'reload') {
          // 手改了 state/*.json（或从备份里抠回一条）之后，让运行中的桥接重新读一遍，
          // 免得「文件是对的、页面上还是旧的」，也省掉一次为读盘而重启。
          reloadMemoryState(['social-v2.json', 'member-remarks.json', 'slang.json', 'knowledge.json', 'stickers.json']);
          log('控制台：AI 记忆已从磁盘重新读入');
          sendJson({ ok: true, inventory: memoryAdmin.inventory() });
          return;
        }
        if (action === 'backup') {
          sendJson(memoryAdmin.backup({ reason: String(body.reason ?? '控制台手动备份') }));
          return;
        }
        if (action === 'restore') {
          // 回滚前先让内存态跟着重载，否则页面显示的还是回滚前的数据。
          const result = memoryAdmin.restoreBackup({ name: String(body.name ?? '').trim(), reload: reloadMemoryState });
          if (result.ok) log(`控制台：AI 记忆回滚到备份 ${result.name}`);
          sendJson(result);
          return;
        }
        if (action === 'clear') {
          const kind = String(body.kind ?? '').trim();
          const label = kind === 'all' ? '全部记忆' : kind;
          const result = memoryAdmin.clear({
            kind,
            key: String(body.key ?? '').trim(),
            category: String(body.category ?? '').trim(),
            includePinned: body.includePinned === true,
            reason: `控制台清空 ${label}`,
          });
          if (result.ok) {
            log(
              `控制台：清空 AI 记忆（${label}${body.key ? ` @ ${body.key}` : ''}）共 ${result.clearedTotal} 条，备份 ${result.backup || '无'}`,
            );
            appendActivity(`控制台清空 AI 记忆：${label} ${result.clearedTotal} 条`);
          }
          sendJson(result);
          return;
        }
        if (action === 'forget') {
          const result = memoryAdmin.forget({
            key: String(body.key ?? '').trim(),
            thoughtTtlMs: body.thoughtTtlMs,
            topicIdleMs: body.topicIdleMs,
            stickerIdleMs: body.stickerIdleMs,
          });
          if (result.ok) log(`控制台：AI 记忆自然遗忘 ${result.forgottenTotal} 条（备份 ${result.backup || '无'}）`);
          sendJson(result);
          return;
        }
        if (action === 'remove') {
          const result = memoryAdmin.remove({
            kind: String(body.kind ?? '').trim(),
            key: String(body.key ?? '').trim(),
            id: String(body.id ?? '').trim(),
            id2: String(body.id2 ?? '').trim(),
          });
          if (result.ok && result.removed) log(`控制台：忘掉一条记忆 ${result.kind} @ ${result.key} -> ${result.id}`);
          sendJson(result);
          return;
        }
        if (action === 'pin') {
          sendJson(
            memoryAdmin.setPin({
              kind: String(body.kind ?? '').trim(),
              key: String(body.key ?? '').trim(),
              id: String(body.id ?? '').trim(),
              id2: String(body.id2 ?? '').trim(),
              pinned: body.pinned !== false,
              reason: String(body.reason ?? '').trim(),
            }),
          );
          return;
        }
        sendJson({ ok: false, error: `未知的记忆管理动作：${action || '(空)'}` }, 404);
        return;
      } catch (error) {
        log('记忆管理接口异常:', error?.stack ?? error);
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
        return;
      }
    }
  }
  async function handleAiPluginRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/ai-plugins' || url.pathname.startsWith('/api/ai-plugins/')) {
      const action = url.pathname === '/api/ai-plugins' ? '' : url.pathname.slice('/api/ai-plugins/'.length);
      const aiRoot = path.join(STATE_DIR, 'ai-plugins');
      const pendingFile = path.join(STATE_DIR, 'ai-plugins-pending.json');
      const enabledFile = path.join(STATE_DIR, 'plugins-enabled.json');
      const readPending = () => {
        const v = readJsonSafe(pendingFile, {});
        return v && typeof v === 'object' ? v : {};
      };
      const readEnabled = () => {
        const v = readJsonSafe(enabledFile, {});
        return v && typeof v === 'object' ? v : {};
      };
      const safeId = (v) =>
        String(v ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40);
      const validate = (m) => {
        const errs = [];
        if (!m || typeof m !== 'object') return ['manifest 必须是 JSON 对象'];
        if (!safeId(m.id)) errs.push('id 必须是字母/数字/下划线/短横线');
        if (!String(m.name || '').trim()) errs.push('name 不能为空');
        const tools = Array.isArray(m.tools) ? m.tools : [];
        if (!tools.length && !(Array.isArray(m.jobs) && m.jobs.length)) errs.push('至少声明一个 tool 或 job');
        for (const t of tools) {
          if (!t || !String(t.name || '').trim()) errs.push('tool.name 不能为空');
          if (!/^https?:\/\//.test(String(t.url || ''))) errs.push(`tool ${t && t.name}: url 必须是 http(s)`);
        }
        for (const j of Array.isArray(m.jobs) ? m.jobs : []) {
          if (!/^https?:\/\//.test(String(j?.url || ''))) errs.push('job.url 必须是 http(s)');
        }
        return errs;
      };
      try {
        if (req.method === 'GET' && action === 'pending') {
          sendJson({ ok: true, pending: readPending() });
          return;
        }
        if (req.method === 'POST' && action === 'write') {
          // AI 侧唯一入口：写 manifest（强制 origin=ai、enabled=false），并进入待批准队列
          const body = await readBody();
          const m = body.manifest && typeof body.manifest === 'object' ? body.manifest : null;
          const errs = validate(m);
          if (errs.length) {
            sendJson({ ok: false, error: 'manifest 不合法', errors: errs }, 400);
            return;
          }
          const id = safeId(m.id);
          const dir = path.join(aiRoot, id);
          let count = 0;
          try {
            count = fs.readdirSync(aiRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
          } catch {
            count = 0;
          }
          if (count >= 20 && !fs.existsSync(dir)) {
            sendJson({ ok: false, error: 'AI 插件数量已达上限（20）' }, 429);
            return;
          }
          const manifest = {
            ...m,
            id,
            origin: 'ai',
            enabled: false,
            version: String(m.version || '0.1.0'),
            description: String(m.description || '').slice(0, 500),
          };
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
          } catch (error) {
            sendJson({ ok: false, error: `写插件失败：${error.message}` }, 500);
            return;
          }
          const st = readEnabled();
          st[`ai:${id}`] = false;
          atomicWriteJson(enabledFile, st);
          const pending = readPending();
          pending[id] = { id, createdAt: Date.now(), manifest, author: String(body.author || 'ai').slice(0, 40) };
          atomicWriteJson(pendingFile, pending);
          log(`[plugin] AI 提交插件 ${id}（待批准）`);
          sendJson({
            ok: true,
            id,
            pending: true,
            note: '已进入待批准队列，管理员在控制台「插件 → 待批准」批准后才会启用',
          });
          return;
        }
        if (req.method === 'POST' && action === 'test') {
          // 只读自测：按声明各请求一次，回报 HTTP 状态（不启用）
          const body = await readBody();
          const id = safeId(body.id);
          let m = null;
          try {
            m = JSON.parse(fs.readFileSync(path.join(aiRoot, id, 'manifest.json'), 'utf8'));
          } catch {
            /* 见下 */
          }
          if (!m) {
            sendJson({ ok: false, error: '插件不存在' }, 404);
            return;
          }
          const results = [];
          for (const t of Array.isArray(m.tools) ? m.tools.slice(0, 5) : []) {
            try {
              const r = await fetch(t.url, {
                method: String(t.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
                signal: AbortSignal.timeout(12000),
              });
              results.push({ tool: t.name, status: r.status, ok: r.ok });
            } catch (error) {
              results.push({
                tool: t.name,
                status: 0,
                ok: false,
                error: String(error?.message ?? error).slice(0, 120),
              });
            }
          }
          const pending = readPending();
          if (pending[id]) {
            pending[id].testedAt = Date.now();
            pending[id].testResults = results;
            atomicWriteJson(pendingFile, pending);
          }
          sendJson({ ok: true, id, results });
          return;
        }
        if (req.method === 'POST' && action === 'approve') {
          const body = await readBody();
          const id = safeId(body.id);
          if (body.approve === false) {
            // 拒绝：删掉 AI 的插件目录与待批准记录
            try {
              fs.rmSync(path.join(aiRoot, id), { recursive: true, force: true });
            } catch {
              /* 忽略 */
            }
            const pending = readPending();
            delete pending[id];
            atomicWriteJson(pendingFile, pending);
            const st = readEnabled();
            delete st[`ai:${id}`];
            atomicWriteJson(enabledFile, st);
            log(`[plugin] 已拒绝 AI 插件 ${id}`);
            sendJson({ ok: true, id, rejected: true });
            return;
          }
          const pending = readPending();
          if (!pending[id]) {
            sendJson({ ok: false, error: '没有这个待批准插件' }, 404);
            return;
          }
          const st = readEnabled();
          st[`ai:${id}`] = true;
          atomicWriteJson(enabledFile, st);
          delete pending[id];
          atomicWriteJson(pendingFile, pending);
          log(`[plugin] 已批准 AI 插件 ${id}`);
          sendJson({ ok: true, id, enabled: true });
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }
  async function handlePluginRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, phonePin } = routeCtx;
    if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) {
      const action = url.pathname === '/api/plugins' ? '' : url.pathname.slice('/api/plugins/'.length);
      const enabledFile = path.join(STATE_DIR, 'plugins-enabled.json');
      const readEnabled = () => {
        const v = readJsonSafe(enabledFile, {});
        return v && typeof v === 'object' ? v : {};
      };
      const listNow = () =>
        scanPlugins({ root: process.cwd(), aiRoot: path.join(STATE_DIR, 'ai-plugins'), enabledState: readEnabled() });
      try {
        if (req.method === 'GET' && (action === '' || action === 'list')) {
          const plugins = listNow().map((p) => ({
            ...p,
            tools: p.tools.map((t) => ({ ...t, toolName: pluginToolName(p, t) })),
          }));
          sendJson({
            ok: true,
            plugins,
            counts: {
              user: plugins.filter((p) => p.origin === 'user').length,
              ai: plugins.filter((p) => p.origin === 'ai').length,
            },
          });
          return;
        }
        if (req.method === 'POST' && action === 'toggle') {
          const body = await readBody();
          const key = `${String(body.origin)}:${String(body.id)}`;
          const state0 = readEnabled();
          state0[key] = body.enabled !== false;
          atomicWriteJson(enabledFile, state0);
          log(`[plugin] ${key} → ${state0[key] ? '启用' : '禁用'}（${body.by || 'console'}）`);
          sendJson({ ok: true, key, enabled: state0[key] });
          return;
        }
        if (req.method === 'POST' && action === 'call') {
          // AI 调用插件工具：按 manifest 里的声明发 HTTP（不执行插件自带代码）
          const body = await readBody();
          const origin = String(body.origin || 'user');
          const plugin = listNow().find((p) => p.origin === origin && p.id === String(body.plugin));
          if (!plugin) {
            sendJson({ ok: false, error: '插件不存在' }, 404);
            return;
          }
          if (!plugin.enabled) {
            sendJson({ ok: false, error: '插件未启用（需要管理员在控制台开启）' }, 403);
            return;
          }
          const tool = plugin.tools.find((t) => t.name === String(body.tool));
          if (!tool) {
            sendJson({ ok: false, error: '插件里没有这个工具' }, 404);
            return;
          }
          if (tool.kind === 'phone') {
            // 声明式插件的"手机能力"：action 白名单，参数来自调用方
            const act = String(tool.action || '');
            const kw = String(body.params?.keyword ?? body.params?.q ?? tool.keyword ?? '').trim();
            const appSel = String(body.params?.app ?? tool.app ?? 'jd');
            if (act === 'shopping') {
              const r = await phoneShopping({ keyword: kw, app: appSel, pin: phonePin() });
              sendJson({ ok: true, plugin: plugin.id, tool: tool.name, kind: 'phone', result: r });
              return;
            }
            sendJson({ ok: false, error: `插件声明了不支持的手机动作：${act}` }, 400);
            return;
          }
          const resp = await fetch(tool.url, {
            method: tool.method,
            headers: {
              'user-agent': 'qq-bridge-plugin/1.0',
              ...(tool.method === 'POST' ? { 'content-type': 'application/json' } : {}),
              ...(tool.body ? {} : {}),
            },
            ...(tool.method === 'POST' && tool.body ? { body: JSON.stringify(tool.body) } : {}),
            signal: AbortSignal.timeout(tool.timeoutMs),
          });
          const text = (await resp.text()).slice(0, tool.maxChars);
          sendJson({ ok: true, plugin: plugin.id, tool: tool.name, status: resp.status, text });
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }
  async function handleVoicePackRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/voice-packs' || url.pathname.startsWith('/api/voice-packs/')) {
      const vpAgent = String(req.headers['x-agent-token'] ?? '').trim();
      const vpAction = url.pathname === '/api/voice-packs' ? '' : url.pathname.slice('/api/voice-packs/'.length);
      // 管理操作（建包/删包/抽音频）只给控制台；读列表 + 发片段 允许 AI（它要能"来段糖哭"）
      if (req.headers['x-agent-token'] && !(vpAction === '' || vpAction === 'send')) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      const action = url.pathname === '/api/voice-packs' ? '' : url.pathname.slice('/api/voice-packs/'.length);
      try {
        if (req.method === 'GET' && action === 'file') {
          const abs = clipPath({
            stateDir: STATE_DIR,
            id: url.searchParams.get('pack'),
            file: url.searchParams.get('file'),
          });
          if (!abs) {
            sendJson({ ok: false, error: '参数不合法' }, 400);
            return;
          }
          let buf;
          try {
            buf = fs.readFileSync(abs);
          } catch {
            sendJson({ ok: false, error: '文件不存在' }, 404);
            return;
          }
          const mime = /\.mp3$/i.test(abs)
            ? 'audio/mpeg'
            : /\.m4a$/i.test(abs)
              ? 'audio/mp4'
              : /\.ogg$/i.test(abs)
                ? 'audio/ogg'
                : 'audio/wav';
          res.writeHead(200, {
            'content-type': mime,
            'content-length': String(buf.length),
            'Cache-Control': 'private, max-age=60',
          });
          res.end(buf);
          return;
        }
        if (req.method === 'GET') {
          sendJson({ ok: true, packs: listPacks({ stateDir: STATE_DIR }) });
          return;
        }
        const body = await readBody();
        if (action === 'create') {
          const r = createPack({
            stateDir: STATE_DIR,
            name: body.name,
            id: body.id,
            notes: body.notes,
            engine: body.engine,
          });
          sendJson(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error }, r.ok ? 200 : 400);
          return;
        }
        if (action === 'remove') {
          sendJson(removePack({ stateDir: STATE_DIR, id: body.pack }));
          return;
        }
        if (action === 'remove-clip') {
          sendJson(removeClip({ stateDir: STATE_DIR, id: body.pack, file: body.file }));
          return;
        }
        if (action === 'send') {
          // 群友点名"来段爱音糖哭" → 直接把语音包里的片段作为语音条发出去（不经过 TTS）
          const key = String(body.key ?? '').trim();
          const km = /^(group|private):(\d+)$/.exec(key);
          if (!km) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const abs = clipPath({ stateDir: STATE_DIR, id: body.pack, file: body.clip });
          if (!abs) {
            sendJson({ ok: false, error: 'pack/clip 不合法' }, 400);
            return;
          }
          let buf;
          try {
            buf = fs.readFileSync(abs);
          } catch {
            sendJson({ ok: false, error: '片段不存在' }, 404);
            return;
          }
          const id = Number(km[2]);
          const seg = [{ type: 'record', data: { file: 'base64://' + buf.toString('base64') } }];
          const resp =
            km[1] === 'group'
              ? await bot.raw('send_group_msg', { group_id: id, message: seg })
              : await bot.raw('send_private_msg', { user_id: id, message: seg });
          const mid = resp?.data?.message_id ?? resp?.message_id ?? null;
          recordSentMessagesV2(key, [`[语音包] ${String(body.pack)}/${String(body.clip)}`]);
          log(`[voicepack] 已发 ${key}：${body.pack}/${body.clip}（${Math.round(buf.length / 1024)}KB）`);
          sendJson({ ok: true, key, messageId: mid, bytes: buf.length });
          return;
        }
        if (action === 'add-bili') {
          // bvid/url → cid → dash 音频直链 → 下载 → ffmpeg 转 16k 单声道 wav
          const raw = String(body.bvid || body.url || '').trim();
          const bvid = (/BV[0-9A-Za-z]{10}/.exec(raw) || [])[0];
          if (!bvid) {
            sendJson({ ok: false, error: '请给 B站视频的 bvid 或链接（形如 BV1xx411c7mD）' }, 400);
            return;
          }
          const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
          const pg = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
            headers: { 'user-agent': UA, referer: 'https://www.bilibili.com' },
          })
            .then((r) => r.json())
            .catch(() => null);
          const cid = pg?.data?.[0]?.cid;
          if (!cid) {
            sendJson({ ok: false, error: '拿不到该视频的分P信息（视频不存在或接口被限流）' }, 400);
            return;
          }
          const pu = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`, {
            headers: { 'user-agent': UA, referer: 'https://www.bilibili.com' },
          })
            .then((r) => r.json())
            .catch(() => null);
          const auds = (pu?.data?.dash?.audio || []).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
          if (!auds.length) {
            sendJson({ ok: false, error: '这个视频没有可下载的音轨' }, 400);
            return;
          }
          const src = auds[0].baseUrl;
          const ab = await fetch(src, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com' } });
          if (!ab.ok) {
            sendJson({ ok: false, error: `下载音轨失败（HTTP ${ab.status}）` }, 502);
            return;
          }
          const rawAudio = Buffer.from(await ab.arrayBuffer());
          const ffmpeg = await resolveFfmpegPath();
          if (!ffmpeg) {
            sendJson({ ok: false, error: '本机没有 ffmpeg，转不了音频' }, 500);
            return;
          }
          const tmp = path.join(STATE_DIR, `voice-${Date.now()}.m4a`);
          fs.writeFileSync(tmp, rawAudio);
          const wav = path.join(STATE_DIR, `voice-${Date.now()}.wav`);
          const startSec = Math.max(0, Number(body.startSec) || 0);
          const durSec = Math.max(1, Math.min(600, Number(body.durationSec) || 30));
          const ok = await new Promise((resolve) => {
            const child = spawn(ffmpeg, [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-ss',
              String(startSec),
              '-t',
              String(durSec),
              '-i',
              tmp,
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              wav,
            ]);
            child.on('close', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
          });
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* 清理失败无所谓 */
          }
          if (!ok) {
            try {
              fs.unlinkSync(wav);
            } catch {
              /* 忽略 */
            }
            sendJson({ ok: false, error: 'ffmpeg 转码失败' }, 500);
            return;
          }
          const buf = fs.readFileSync(wav);
          try {
            fs.unlinkSync(wav);
          } catch {
            /* 忽略 */
          }
          const r = addClip({
            stateDir: STATE_DIR,
            id: body.pack,
            buffer: buf,
            ext: 'wav',
            label: `${bvid}-${startSec}s`,
          });
          sendJson(r.ok ? { ok: true, ...r, pack: body.pack } : { ok: false, error: r.error }, r.ok ? 200 : 400);
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }
  async function handlePhoneRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2ToolEnabled, phonePin } = routeCtx;
    if (url.pathname === '/api/phone' || url.pathname.startsWith('/api/phone/')) {
      const action = url.pathname === '/api/phone' ? '' : url.pathname.slice('/api/phone/'.length);
      const need = (flag, label) => {
        if (!v2ToolEnabled(flag)) {
          sendJson({ ok: false, error: `能力未启用：${label}（控制台 → 插件 → 手机控制）` }, 403);
          return false;
        }
        return true;
      };
      try {
        if (req.method === 'GET' && action === 'status') {
          if (!need('phoneStatus', '看屏幕')) return;
          sendJson({ ok: true, ...(await phoneStatus()) });
          return;
        }
        if (req.method === 'POST' && action === 'prepare') {
          if (!need('phoneKey', '操作手机')) return;
          const prep = await phonePrepare();
          if (!prep.wake?.unlocked && phonePin()) Object.assign(prep, await phoneEnsureUnlocked({ pin: phonePin() }));
          sendJson(prep);
          return;
        }
        if (req.method === 'POST' && action === 'unprepare') {
          if (!need('phoneKey', '操作手机')) return;
          sendJson(await phoneUnprepare());
          return;
        }
        if (req.method === 'POST' && action === 'wake') {
          if (!need('phoneKey', '操作手机')) return;
          const pin = phonePin();
          sendJson(pin ? await phoneEnsureUnlocked({ pin }) : await phoneWake());
          return;
        }
        if (req.method === 'GET' && action === 'screenshot') {
          if (!need('phoneScreenshot', '看屏幕')) return;
          // ?wake=1：先亮屏（手机有密码时仍会停在锁屏，返回里如实说）
          let wakeInfo = null;
          if (String(url.searchParams.get('wake') ?? '') === '1') {
            const pin = phonePin();
            wakeInfo = pin ? await phoneEnsureUnlocked({ pin }) : await phoneWake();
          }
          const shot = await phoneScreenshot();
          if (!shot.ok) {
            sendJson({ ok: false, error: shot.error }, 502);
            return;
          }
          // send=1：直接把截图发到指定会话（群聊/私聊都行），AI 看得到图，但"发出去"必须这里做
          const sendKey =
            String(url.searchParams.get('send') ?? '') === '1' ? String(url.searchParams.get('key') ?? '').trim() : '';
          if (sendKey) {
            const km = /^(group|private):(\d+)$/.exec(sendKey);
            if (!km) {
              sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
              return;
            }
            // 手机截图原图 2~4MB，直接发会触发 QQ 的 highway upload 921（实测）；
            // 先缩到 1080 宽的 jpeg（通常 200~400KB），稳。
            let raw = Buffer.from(shot.data, 'base64');
            try {
              raw = await sharp(raw)
                .rotate()
                .resize({ width: 1080, withoutEnlargement: true })
                .jpeg({ quality: 82, mozjpeg: true })
                .toBuffer();
            } catch {
              try {
                raw = await fitMediaBuffer(raw, 'phone-screenshot.png');
              } catch {
                /* 原样发 */
              }
            }
            const seg = [{ type: 'image', data: { file: 'base64://' + raw.toString('base64') } }];
            const gid = Number(km[2]);
            const r =
              km[1] === 'group'
                ? await bot.raw('send_group_msg', { group_id: gid, message: seg })
                : await bot.raw('send_private_msg', { user_id: gid, message: seg });
            const mid = r?.message_id ?? r?.data?.message_id ?? null;
            recordSentMessagesV2(sendKey, ['[手机截图]']);
            log(`[phone] 已发截图 ${sendKey}（${Math.round(raw.length / 1024)}KB）`);
            sendJson({
              ok: true,
              sent: true,
              messageId: mid,
              data: shot.data,
              mimeType: shot.mimeType,
              bytes: raw.length,
              wake: wakeInfo,
            });
            return;
          }
          sendJson({ ok: true, data: shot.data, mimeType: shot.mimeType, bytes: shot.bytes, wake: wakeInfo });
          return;
        }
        if (req.method === 'POST' && action === 'act') {
          if (!need('phoneTap', '操作手机')) return;
          const body = await readBody();
          const r = await phoneAct(body);
          sendJson(r, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && action === 'shell') {
          if (!need('phoneExec', '在手机上执行命令')) return;
          const body = await readBody();
          sendJson(await phoneShell(String(body.cmd ?? '')));
          return;
        }
        if (req.method === 'POST' && action === 'moment') {
          if (!need('postMoment', '发 QQ 动态')) return;
          const body = await readBody();
          // 默认 dryRun：只走到「输入完文案」不点发送；要真发必须显式传 send=true
          const r = await phonePostMoment({ text: String(body.text ?? ''), pin: phonePin(), send: body.send === true });
          sendJson(r, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && action === 'bili') {
          if (!need('biliSearch', '刷 B站')) return;
          const body = await readBody();
          sendJson(
            await phoneBili({
              task: String(body.task ?? 'feed'),
              query: String(body.query ?? ''),
              swipes: Number(body.swipes) || 3,
              pin: phonePin(),
            }),
          );
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }
  async function handleDoubaoRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/doubao/status' && req.method === 'GET') {
      const dc = cfg.slang?.doubao ?? {};
      let st = { running: false, loggedIn: null };
      try {
        st = getDoubaoChannel().status();
      } catch (error) {
        st = { running: false, error: String(error?.message ?? error) };
      }
      sendJson({
        ok: true,
        enabled: dc.enabled === true,
        config: {
          memoryMax: dc.memoryMax ?? '900M',
          memorySwapMax: dc.memorySwapMax ?? '1500M',
          idleCloseMs: dc.idleCloseMs ?? 300000,
          timeoutMs: dc.timeoutMs ?? 90000,
          maxTerms: dc.maxTerms ?? 3,
        },
        autoConfirmResearched: cfg.slang?.autoConfirmResearched !== false,
        channel: st,
      });
      return;
    }
    if (url.pathname === '/api/doubao/probe' && req.method === 'POST') {
      // 探活：起 worker（可能十几秒）+ 报登录态
      try {
        const r = await getDoubaoChannel().ping({ timeoutMs: 90000 });
        sendJson({ ok: true, ...r });
      } catch (error) {
        sendJson({ ok: false, error: `探活失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (url.pathname === '/api/doubao/login' && req.method === 'POST') {
      // 打开登录框并截二维码，前端显示出来让用户扫
      try {
        const r = await getDoubaoChannel().startLogin({ timeoutMs: 60000 });
        sendJson(r);
      } catch (error) {
        sendJson({ ok: false, error: `取二维码失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (url.pathname === '/api/doubao/login-wait' && req.method === 'POST') {
      const body = await readBody().catch(() => ({}));
      const timeoutMs = Math.min(600000, Math.max(10000, Number(body?.timeoutMs) || 180000));
      try {
        const r = await getDoubaoChannel().waitLogin({ timeoutMs });
        sendJson(r);
      } catch (error) {
        sendJson({ ok: false, error: `等待登录失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (url.pathname === '/api/doubao/ask' && req.method === 'POST') {
      // 测试提问：确认通道真的能问到话（不写库、不影响词条）
      const body = await readBody();
      const prompt = String(body?.prompt ?? '')
        .trim()
        .slice(0, 2000);
      if (!prompt) {
        sendJson({ ok: false, error: 'prompt 不能为空' }, 400);
        return;
      }
      try {
        const r = await getDoubaoChannel().ask(prompt, {
          timeoutMs: Math.min(180000, Number(body?.timeoutMs) || 120000),
        });
        sendJson(r);
      } catch (error) {
        sendJson({ ok: false, error: `提问失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (url.pathname === '/api/doubao/stop' && req.method === 'POST') {
      try {
        getDoubaoChannel().stop('console');
      } catch {
        /* 没起过就算了 */
      }
      sendJson({ ok: true });
      return;
    }
    if (url.pathname === '/api/doubao/config' && req.method === 'POST') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const curSlang = file.slang ?? {};
      const cur = curSlang.doubao ?? {};
      const next = { ...cur };
      if (typeof body?.enabled === 'boolean') next.enabled = body.enabled;
      for (const k of ['memoryMax', 'memorySwapMax']) {
        if (typeof body?.[k] === 'string' && body[k].trim()) next[k] = body[k].trim().slice(0, 20);
      }
      for (const k of ['idleCloseMs', 'timeoutMs', 'maxTerms', 'budgetMs']) {
        if (Number.isFinite(Number(body?.[k]))) next[k] = Math.max(0, Math.round(Number(body[k])));
      }
      curSlang.doubao = next;
      file.slang = curSlang;
      atomicWriteJson(configFile, file);
      cfg.slang = { ...cfg.slang, doubao: next };
      // 开关一关就顺手把 worker 关掉，别让浏览器白占内存
      if (next.enabled !== true) {
        try {
          getDoubaoChannel().stop('disabled');
        } catch {
          /* 没起过 */
        }
      }
      log(`控制台：豆包通道 ${next.enabled === true ? '已启用' : '已关闭'}`);
      sendJson({ ok: true, enabled: next.enabled === true, config: next });
      return;
    }
  }

  return {
    handleActivityRoutes,
    handleForwardRoutes,
    handleMemberRemarkRoutes,
    handleSendRoutes,
    handleShareMediaRoutes,
    handleMemoryApiRoutes,
    handleMemoryAdminRoutes,
    handleAiPluginRoutes,
    handlePluginRoutes,
    handleVoicePackRoutes,
    handlePhoneRoutes,
    handleDoubaoRoutes,
  };
}
