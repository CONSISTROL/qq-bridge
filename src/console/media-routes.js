// 媒体相关路由：表情包、搜图、B站抓图/视频、相册、AI 图片管理、图片查询。
//
// 从 bridge.js 抽出的控制台路由。依赖由工厂函数注入：
// 稳定的函数/常量按值传入；会被重新赋值的绑定用 getter/setter（模块内以 deps.xxx 访问）。

export function createMediaRoutes(deps) {
  const {
    ALBUM_META_FILE,
    ALBUM_SOURCES,
    BILI_COOKIE_FILE,
    BILI_RUNNER,
    BILI_TARGETS_FILE,
    MAX_MEDIA_COUNT,
    MAX_MEDIA_FETCH_BYTES,
    ROOT,
    SLANG_STATUS,
    STATE_DIR,
    STICKER_SOURCE,
    agentTokenOk,
    albumStats,
    anyAgentTokenOk,
    appendActivity,
    applyStickerNoteChat,
    atomicWriteJson,
    attachPixivOriginals,
    biliStatus,
    bot,
    buildStickerPickPreviews,
    buildStickerPickResultChat,
    cfg,
    classifyFile,
    collectAlbumItems,
    collectStickerItems,
    collectStickerChat,
    createBiliClient,
    embedder,
    emptyTrash,
    enqueueMemeResearch,
    extractFileContent,
    extractVideoFramesFromFile,
    fetchMediaData,
    fetchMediaFromOneBot,
    fetchVideoThumb,
    findMessageMedia,
    fitMediaBuffer,
    formatStickerList,
    fs,
    getSocialV2State,
    getStickerImageData,
    imageAdmin,
    imageIdentityKey,
    isAlbumImageName,
    itemId,
    listTrash,
    log,
    memeDigestCache,
    mimeFromBuffer,
    modeAllowed,
    normalizeImageForVision,
    notifyAiSession,
    path,
    pixivDailyRanking,
    purgeTrash,
    ragEnabled,
    readBiliCookie,
    readJsonSafe,
    readPickConfig,
    recentSentImageKeys,
    recordSentMessagesChat,
    removeSticker,
    repeatGuardWindowMs,
    resolveFfmpegPath,
    resolveImageConfig,
    resolveReplyTargetChat,
    restoreTrash,
    safeFetchBuffer,
    safeFetchToFile,
    saveChatImage,
    saveSlangStore,
    saveSocialV2State,
    saveStickerStoreSafe,
    saveStickerChat,
    scheduleReplyCheckChat,
    scoreEntries,
    searchPixivByTag,
    searchPixivWeb,
    sendImageChat,
    sendPickedStickerChat,
    sendStickerChat,
    sentBackfill,
    sentImageUrlCandidates,
    setStickerRemarkChat,
    sharp,
    shouldBlockSilentReply,
    spawn,
    startSentBackfill,
    stickerEnabled,
    stickerNeedsRemark,
    syncStickerLibrary,
    synthesizeVoiceChat,
    transcribeMediaAudio,
    trashPath,
    updateAlbumMeta,
    videoToolsOf,
  } = deps;

  async function handleStickerV2Routes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialData/sticker-image') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const key = String(url.searchParams.get('key') ?? '').trim();
      const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
      if (!key || !stickerId) {
        sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403);
        return;
      }
      try {
        const entry = await getStickerImageData(stickerId);
        const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_FETCH_BYTES);
        // 动图要抽多帧：只看第一帧的话，AI 会把某一瞬间当整张表情描述。
        const frames = await normalizeImageForVision(fetched.buffer, entry.url);
        if (!frames.length) {
          sendJson({ ok: false, error: '表情图片过大且无法压缩，已拒绝' }, 400);
          return;
        }
        sendJson({
          ok: true,
          key,
          sticker: {
            id: entry.id,
            desc: entry.desc || '',
            localNote: entry.localNote || '',
            localRemark: entry.localRemark || '',
            tags: entry.tags || [],
            url: entry.url,
            md5: entry.md5,
          },
          image: { mimeType: frames[0].mimeType, data: frames[0].buffer.toString('base64') },
          frames: frames.map((f) => ({
            mimeType: f.mimeType,
            data: f.buffer.toString('base64'),
            text: f.frameText || '',
          })),
          frameCount: frames.length,
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialData/self-image') {
      const key = String(url.searchParams.get('key') ?? '').trim();
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403);
        return;
      }
      const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
      try {
        if (!fs.existsSync(selfPath)) {
          sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404);
          return;
        }
        const buf = fs.readFileSync(selfPath);
        const mimeType = mimeFromBuffer(buf) || 'image/png';
        sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
      } catch (error) {
        sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialData/sticker-note') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) {
        sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) {
        sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403);
        return;
      }
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const tags =
        body.tags !== undefined && body.tags !== null
          ? Array.isArray(body.tags)
            ? body.tags
                .map(String)
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 20)
            : []
          : undefined;
      const usage =
        body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      const localRemark =
        body.localRemark !== undefined && body.localRemark !== null
          ? String(body.localRemark).trim().slice(0, 40)
          : undefined;
      const entry = applyStickerNoteChat(stickerId, note, tags, usage, localRemark);
      if (!entry) {
        sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404);
        return;
      }
      log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
      sendJson({ ok: true, key, sticker: entry });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialData/sticker-remark') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) {
        sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) {
        sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403);
        return;
      }
      try {
        const entry = await setStickerRemarkChat(stickerId, String(body.remark ?? ''));
        log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
        sendJson({ ok: true, key, sticker: entry });
      } catch (error) {
        sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 发语音条：文本 → tzd 的 TTS 服务（edge-tts + RVC 变声）→ QQ record 段。
    if (req.method === 'POST' && url.pathname === '/api/socialData/send-voice') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim();
      const replyToMessageId = body.replyToMessageId;
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const ttsCfg = cfg.socialData?.tts ?? {};
      if (ttsCfg.enabled === false) {
        sendJson({ ok: false, error: '语音合成已关闭（socialData.tts.enabled）' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (!text) {
        sendJson({ ok: false, error: 'text 不能为空' }, 400);
        return;
      }
      // 不设硬门限（owner 要求）：超长就截断，交给提示词去把握分寸。
      const maxCharsRaw = Number(ttsCfg.maxChars);
      const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? Math.min(300, maxCharsRaw) : 0;
      const speakText = maxChars > 0 && text.length > maxChars ? text.slice(0, maxChars) : text;
      if (agentToken && !agentTokenOk(key, agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (agentToken && !v2ToolEnabled('sendVoice')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
        return;
      }
      const stV = getSocialV2State(key);
      const cooldown = Math.max(0, Number(ttsCfg.cooldownMs) || 0);
      const lastVoiceAt = Number(stV.lastVoiceAt) || 0;
      if (cooldown > 0 && lastVoiceAt && Date.now() - lastVoiceAt < cooldown) {
        const left = Math.ceil((cooldown - (Date.now() - lastVoiceAt)) / 1000);
        sendJson(
          {
            ok: false,
            error: `刚发过语音，再等 ${left} 秒（冷却 ${Math.round(cooldown / 1000)} 秒）`,
            cooldownLeftMs: cooldown - (Date.now() - lastVoiceAt),
          },
          429,
        );
        return;
      }
      try {
        const voice = await synthesizeVoiceChat(speakText, ttsCfg);
        const b64 = voice.buffer.toString('base64');
        const segment = [{ type: 'record', data: { file: 'base64://' + b64 } }];
        const resp =
          kind === 'group'
            ? await bot.raw('send_group_msg', { group_id: id, message: segment })
            : await bot.raw('send_private_msg', { user_id: id, message: segment });
        const messageId = resp?.data?.message_id ?? resp?.message_id ?? null;
        stV.lastVoiceAt = Date.now();
        stV.lastActionAt = stV.lastVoiceAt;
        recordSentMessagesChat(key, [`[语音] ${speakText}`]);
        log(
          `[tts] 发语音 ${key}：${speakText.length} 字${voice.fallback ? '（RVC 降级为纯 TTS）' : `（${ttsCfg.model || 'aiyi'} 音色）`}${speakText.length < text.length ? '（超长已截断）' : ''}`,
        );
        sendJson({
          ok: true,
          key,
          messageId,
          chars: speakText.length,
          truncated: speakText.length < text.length,
          fallback: !!voice.fallback,
          bytes: voice.buffer.length,
        });
      } catch (error) {
        log(`[tts] 发语音失败 ${key}：${error?.message ?? error}`);
        sendJson({ ok: false, error: `发语音失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialData/send-sticker') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      const caption = String(body.message ?? body.caption ?? '').trim();
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      if (!key || !stickerId) {
        sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400);
        return;
      }
      // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
      if (caption) {
        sendJson(
          {
            ok: false,
            error:
              '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情',
          },
          400,
        );
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      if (!req.headers['x-agent-token']) {
        sendJson({ ok: false, error: 'chat 模式发送必须携带 agent token' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (kind === 'private' && atUserId) {
        sendJson({ ok: false, error: '私聊不需要 @' }, 400);
        return;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
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
        const resolved = await resolveReplyTargetChat(stForReply, kind, id, String(replyToMessageId).trim());
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
      const sendCfg = cfg.socialData?.send ?? {};
      const now = Date.now();
      try {
        const st = getSocialV2State(key);
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
        const sent = await sendStickerChat(key, stickerId, {
          replyToMessageId: actualReplyToMessageId,
          atUserId,
        });
        // 记录到会话的 recentMessages，让 AI 知道自己发过这个表情
        const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
        const text = `[表情包:${label}]`;
        st.recentMessages.push({
          messageId: sent.messageId ? String(sent.messageId) : null,
          sender: '我',
          text: text.slice(0, 200),
          plain: text.slice(0, 200),
          quoteTargetIsSelf: false,
          isOwner: true,
          ownerLabel: '我',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          sticker: {
            id: sent.entry?.id || stickerId,
            desc: sent.entry?.desc || '',
            localNote: sent.entry?.localNote || '',
          },
          time: Date.now(),
        });
        const recentLimit = Number(cfg.socialData?.context?.recentLimit) || 100;
        if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        saveSocialV2State();
        scheduleReplyCheckChat(key);
        log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
        appendActivity(`${key} [sticker] 工具发送表情：${label}`);
        sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
      } catch (error) {
        const st = getSocialV2State(key);
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleStickerPickRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialData/pick-sticker') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const pickCfg = readPickConfig();
      if (!pickCfg.enabled) {
        sendJson({ ok: false, error: '表情包时机判断已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('pickSticker')) {
        sendJson({ ok: false, error: '工具未启用：qq_pick_sticker' }, 403);
        return;
      }
      if (!/^(group|private):\d+$/.test(key)) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const context = String(body.context ?? '').slice(0, 400);
      const topic = String(body.topic ?? '').slice(0, 60);
      const limit = Math.max(1, Math.min(20, Number(body.limit) || pickCfg.defaultLimit));
      const minScore =
        body.minScore === undefined || body.minScore === null
          ? pickCfg.minScore
          : Math.max(0, Math.min(100, Number(body.minScore) || 0));
      const searchOnline = body.searchOnline === true ? true : body.searchOnline === false ? false : undefined;
      const sendSpec = body.send && typeof body.send === 'object' && !Array.isArray(body.send) ? body.send : null;
      const wantPreview = body.preview === true;
      const st = getSocialV2State(key);
      const now = Date.now();
      // 只有「真的要出网找图」才吃 image.maxPerMinute 额度；纯本地查询不吃。
      const willSearchOnline = searchOnline === true || (searchOnline === undefined && pickCfg.onlineFallback);
      const maxPerMinute = Math.max(0, Number(cfg.socialData?.image?.maxPerMinute) || 0);
      const recentMinute = (st.imageSearchTimes || []).filter((t) => now - t < 60000).length;
      if (willSearchOnline && !sendSpec && maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) {
        sendJson({ ok: false, error: '找图太频繁了，请过一会儿再试（也可以先用本地候选）' }, 429);
        return;
      }
      const reservedSearch = willSearchOnline && !sendSpec;
      if (reservedSearch) {
        st.imageSearchTimes = st.imageSearchTimes || [];
        st.imageSearchTimes.push(now);
        if (st.imageSearchTimes.length > 500) st.imageSearchTimes = st.imageSearchTimes.slice(-500);
      }
      try {
        const result = await buildStickerPickResultChat(key, { context, topic, minScore, limit, searchOnline });
        if (reservedSearch && !result.onlineUsed) {
          st.imageSearchTimes = st.imageSearchTimes.filter((t) => t !== now);
        }
        if (sendSpec) {
          if (result.moment.allowed === false) {
            saveSocialV2State();
            sendJson({ ok: false, error: `现在不适合发表情包：${result.moment.reason}`, moment: result.moment }, 409);
            return;
          }
          // 发出去也走统一的发送限频（与 qq_send_sticker / qq_send_message 同一档额度）
          const sendCfg = cfg.socialData?.send ?? {};
          const sendMaxMin = Math.max(0, Number(sendCfg.maxSendPerMinute) || 0);
          const sendMaxHour = Math.max(0, Number(sendCfg.maxSendPerHour) || 0);
          const sentMin = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const sentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((sendMaxMin > 0 && sentMin + 1 > sendMaxMin) || (sendMaxHour > 0 && sentHour + 1 > sendMaxHour)) {
            sendJson({ ok: false, error: '发送频率超限，稍后再试' }, 429);
            return;
          }
          st.sendTimes = st.sendTimes || [];
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            const sent = await sendPickedStickerChat(key, sendSpec, {
              candidates: result.candidates,
              online: result.online,
            });
            scheduleReplyCheckChat(key);
            sendJson({ ...sent, moment: result.moment, label: sent.sticker?.label || sent.sticker?.title || '' });
          } catch (error) {
            st.sendTimes = st.sendTimes.filter((t) => t !== now);
            saveSocialV2State();
            throw error;
          }
          return;
        }
        saveSocialV2State();
        const hint =
          result.moment.allowed === false
            ? `现在不建议发表情包：${result.moment.reason}`
            : result.candidates.length
              ? `本地候选 top1：${result.candidates[0].label}（${result.candidates[0].score} 分，${result.candidates[0].kind === 'qq' ? '用 qq_send_sticker' : '用 qq_send_image(source=library)'}）；满意就直接发，别硬发不相关的。`
              : '本地没有候选，看看联网结果或换个关键词。';
        const onlineHint = result.online.length
          ? `联网候选可先用 qq_send_image(source=url) 直接发，或 qq_save_sticker(source=url) 存进收藏表情库以后再发。`
          : '';
        log(
          `[sticker] pick ${key}: moment=${result.moment.allowed ? result.moment.level : 'no'} local=${result.candidates.length} online=${result.online.length}`,
        );
        appendActivity(
          `${key} [sticker] 选表情：本地 ${result.candidates.length} / 联网 ${result.online.length}（${result.decided ? '有合适' : '没定'}）`,
        );
        const previews = wantPreview ? await buildStickerPickPreviews(result.candidates, 2) : [];
        sendJson({
          ok: true,
          key,
          moment: result.moment,
          previews,
          intent: result.intents,
          need: result.need,
          topic: result.topic,
          minScore: result.minScore,
          decided: result.decided,
          thresholdMet: result.thresholdMet,
          candidates: result.candidates,
          poolSize: result.poolSize,
          onlineUsed: result.onlineUsed,
          onlineQuery: result.onlineQuery,
          online: result.online,
          onlineNotes: result.onlineNotes,
          seedHome: result.seedHome,
          source: result.source,
          hint: [hint, onlineHint].filter(Boolean).join(' '),
          sendHint:
            '选好后调用 qq_pick_sticker 并传 send：本地候选 {id}，联网候选 {url}；一次只发一张。本地图库（lib: 开头）的条目没有含义描述，不确定长什么样就传 preview=true 看一眼再发。',
        });
      } catch (error) {
        st.imageSearchTimes = st.imageSearchTimes.filter((t) => t !== now);
        saveSocialV2State();
        log(`[sticker] pick 失败 ${key}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `选表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialData/collect-sticker') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const messageRef = String(body.messageId ?? body.seq ?? '').trim();
      const remark = String(body.remark ?? '').trim();
      if (!key || !messageRef) {
        sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) {
        sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const st = getSocialV2State(key);
      const collectCfg = cfg.socialData?.sticker?.collect ?? {};
      if (collectCfg.enabled === false) {
        sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403);
        return;
      }
      const now = Date.now();
      const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
      const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
      const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
        return;
      }
      // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
      st.stickerCollectTimes = st.stickerCollectTimes || [];
      st.stickerCollectTimes.push(now);
      if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
      try {
        const result = await collectStickerChat(key, messageRef, remark);
        saveSocialV2State();
        log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
        appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
        sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
      } catch (error) {
        const idx = st.stickerCollectTimes.indexOf(now);
        if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
        if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
        saveSocialV2State();
        log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 从外部来源保存表情（qq_save_sticker）：本地图库 / base64 / 远程 URL（需开启）
    if (req.method === 'POST' && url.pathname === '/api/socialData/save-sticker') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      if (cfg.socialData?.image?.enabled === false) {
        sendJson({ ok: false, error: '图片保存功能已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const image = String(body.image ?? '').trim();
      if (!key || !image) {
        sendJson({ ok: false, error: 'key 和 image 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('saveSticker')) {
        sendJson({ ok: false, error: '工具未启用：qq_save_sticker' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const st = getSocialV2State(key);
      const imgCfg = cfg.socialData?.image ?? {};
      const now = Date.now();
      const maxPerMinute = Math.max(0, Number(imgCfg.maxPerMinute) || 0);
      const maxPerHour = Math.max(0, Number(imgCfg.maxPerHour) || 0);
      const recentMinute = (st.stickerSaveTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.stickerSaveTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '保存图片太频繁了，请过一会儿再试' }, 429);
        return;
      }
      // 预占额度，避免并发绕过限频；失败回滚。
      st.stickerSaveTimes = st.stickerSaveTimes || [];
      st.stickerSaveTimes.push(now);
      if (st.stickerSaveTimes.length > 500) st.stickerSaveTimes = st.stickerSaveTimes.slice(-500);
      try {
        const result = await saveStickerChat(key, image, {
          source: String(body.source ?? 'auto'),
          remark: body.remark,
        });
        saveSocialV2State();
        log(
          `[sticker] 保存表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''} via=${result.via}${result.sourceUrl ? ' ' + result.sourceUrl : ''}`,
        );
        appendActivity(`${key} [sticker] 保存表情：${result.remark || result.emojiId}（${result.via}）`);
        sendJson({ ok: true, key, emojiId: result.emojiId, sticker: result.entry, via: result.via });
      } catch (error) {
        st.stickerSaveTimes = st.stickerSaveTimes.filter((t) => t !== now);
        sendJson({ ok: false, error: `保存表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 直接发送一张图片（qq_send_image）：本地图库 / base64 / 远程 URL（需开启）
    if (req.method === 'POST' && url.pathname === '/api/socialData/send-image') {
      if (cfg.socialData?.image?.enabled === false) {
        sendJson({ ok: false, error: '图片功能已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const image = String(body.image ?? '').trim();
      if (!key || !image) {
        sendJson({ ok: false, error: 'key 和 image 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const st = getSocialV2State(key);
      const imgCfg = cfg.socialData?.image ?? {};
      const now = Date.now();
      const maxPerMinute = Math.max(0, Number(imgCfg.maxPerMinute) || 0);
      const maxPerHour = Math.max(0, Number(imgCfg.maxPerHour) || 0);
      const recentMinute = (st.imageSendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.imageSendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '发图片太频繁了，请过一会儿再试' }, 429);
        return;
      }
      st.imageSendTimes = st.imageSendTimes || [];
      st.imageSendTimes.push(now);
      if (st.imageSendTimes.length > 500) st.imageSendTimes = st.imageSendTimes.slice(-500);
      try {
        const result = await sendImageChat(key, image, {
          source: String(body.source ?? 'auto'),
          replyToMessageId: body.replyToMessageId,
          atUserId: body.atUserId,
        });
        saveSocialV2State();
        log(
          `[image] 发送图片 ${key} via=${result.via}${result.sourceUrl ? ' ' + result.sourceUrl : ''}${result.delivered === false ? '（⚠ 未确认送达）' : result.delivered === null ? '（送达待确认）' : ''}`,
        );
        appendActivity(
          `${key} [image] 发送图片（${result.via}）${result.delivered === false ? ' ⚠ 未确认送达' : result.delivered === null ? ' 送达待确认' : ''}`,
        );
        if (result.delivered === false) {
          // 探针确实查到「QQ 没要」：如实报失败，并明确劝住「对同一张硬重试」。
          st.imageSendTimes = st.imageSendTimes.filter((t) => t !== now);
          sendJson(
            {
              ok: false,
              delivered: false,
              key,
              messageId: result.data?.message_id ?? null,
              error:
                '图片没有真正送达：网关接受了这条图片消息并返回成功，但 QQ 侧一直没把它变成已发送（get_msg 里 message_seq=0、图片仍是 base64），桥接已自动重发一次仍然如此。' +
                '最常见的原因是 QQ 的图片审核静默拦截了这张图（露骨、擦边、含二维码/联系方式的图都容易被吞），这类图重发多少次都不会出现，' +
                '别再对同一张反复重试：换一张图，或者如实告诉群友这张没发出去（不要说「已发送」）。',
            },
            502,
          );
          return;
        }
        const sendWarnings = [];
        if (result.delivered === null) {
          sendWarnings.push(
            '这张图已经交给网关了，但发送大图时 WS 通道被占满、送达回执没能在回合内确认出来（后台仍在确认）。**不要重发同一张**，重复图基本都是这么来的。照常接话即可；群友说没看到再换一张。',
          );
        }
        // 退到缩略图时明确告诉 AI 画质掉了：别把它当原图，要么换一张、要么如实说明。
        if (result.rendition === 'thumb') {
          sendWarnings.push(
            `这一张只有缩略图画质（${result.size || '?'}）：原图和 1200px 档都没能从取图通道拿到，桥接发的是小图。别当原图用；要么换一张，要么如实跟群友说这张只有缩略图。`,
          );
        }
        sendJson({
          ok: true,
          key,
          via: result.via,
          messageId: result.data?.message_id ?? null,
          // delivered=null：图已经提交给网关了，但送达还没确认出来（探针被大图占满的 WS 拖住）。
          // 既不能说「确认送达」，也不能说「没发出去」；如实回三态，并明确禁止重发同一张。
          delivered: result.delivered === null ? null : true,
          rendition: result.rendition || '',
          size: result.size || '',
          ...(sendWarnings.length ? { warning: sendWarnings.join(' ') } : {}),
        });
      } catch (error) {
        st.imageSendTimes = st.imageSendTimes.filter((t) => t !== now);
        // 结果不确定（WS 超时、网关没回执）：既不能说成功，也不能让 AI 以为失败去重发。
        // 用 502 + uncertain 标记如实上报，并把「不许重发同一张」讲清楚。
        if (error?.uncertain === true) {
          log(`[image] ⚠ 发送结果不确定 ${key}：${error?.message ?? error}`);
          appendActivity(`${key} [image] ⚠ 发送结果不确定（网关无回执，已挡住同图重发）`);
          sendJson(
            {
              ok: false,
              uncertain: true,
              key,
              error:
                `${error?.message ?? error}。这张图已经进入「结果不确定」状态，10 分钟内再发同一张会被直接拒绝（防止重复图）。` +
                '正确做法：先用 qq_get_recent_messages 或 qq_get_my_recent_messages 看看到底发出去没有，' +
                '已经发出就照常接话（别说「没发出去」），确实没有就换一张，或者先跟群友说明情况让他确认。',
            },
            502,
          );
          return;
        }
        sendJson({ ok: false, error: `发送图片失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleStickerAdminRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, SECURITY_HEADERS } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/stickers') {
      const query = String(url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(cfg.socialData?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
      const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
      const onlyUnlabeled = ['1', 'true', 'yes'].includes(
        String(url.searchParams.get('onlyUnlabeled') ?? '').toLowerCase(),
      );
      try {
        const synced = await syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? deps.stickerEntries, query, count, { onlyUnlabeled });
        sendJson({
          ok: true,
          ...list,
          syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt,
          fromCache: synced?.fromCache ?? false,
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
      try {
        const synced = await syncStickerLibrary(true);
        sendJson({
          ok: true,
          total: synced?.entries?.length ?? deps.stickerEntries.length,
          syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt,
        });
      } catch (error) {
        sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 「表情包 → 立刻让 AI 补一批备注」：手动触发，不用等它在空闲回合自己想起来。
    // 实现就是往某个会话投一条自包含的后台提醒，**会话只决定用哪个 agent token 干活**，
    // 备注本身写在同一份 state/stickers.json 里，所以投给哪个群/私聊结果都一样，
    // 不需要让管理员选会话。
    if (req.method === 'POST' && url.pathname === '/api/stickers/autolabel-now') {
      const body = await readBody();
      const now = Date.now();
      // 这是「叫人干活」的按钮：连点只会往队列里塞重复任务，所以留个冷却。
      const cooldownMs = Math.max(
        5000,
        Math.min(300000, Number(cfg.socialData?.sticker?.manualLabelCooldownMs) || 30000),
      );
      if (now - deps.lastStickerLabelNudgeAt < cooldownMs) {
        sendJson(
          {
            ok: false,
            error: `刚触发过，等 ${Math.ceil((cooldownMs - (now - deps.lastStickerLabelNudgeAt)) / 1000)} 秒再点`,
          },
          429,
        );
        return;
      }
      const wantCount = Math.max(
        1,
        Math.min(10, Number(body.count) || Number(cfg.socialData?.sticker?.manualLabelCount) || 5),
      );
      const pickTarget = () => {
        for (const g of (cfg.allow?.groups ?? []).map(String)) {
          const k = `group:${g}`;
          if (modeAllowed(k, 'group', Number(g), cfg, deps.currentMode)) return k;
        }
        for (const p of (cfg.allow?.private ?? []).map(String)) {
          const k = `private:${p}`;
          if (modeAllowed(k, 'private', Number(p), cfg, deps.currentMode)) return k;
        }
        return '';
      };
      const target = String(body.key ?? '').trim() || pickTarget();
      if (!target) {
        sendJson({ ok: false, error: '没有可用的会话（白名单为空或当前模式不允许）' }, 400);
        return;
      }
      try {
        const synced = await syncStickerLibrary(false);
        const pending = (synced?.entries ?? deps.stickerEntries).filter(stickerNeedsRemark);
        if (!pending.length) {
          sendJson({ ok: true, key: target, asked: 0, remaining: 0, message: '已经没有待补备注的表情了' });
          return;
        }
        const chosen = pending.slice(0, wantCount);
        // 提醒要自包含：把 id 直接写进去，省掉它一轮探索（模型对具体文本敏感）。
        const message =
          `现在补 ${chosen.length} 个没备注的收藏表情（控制台手动触发）。\n` +
          chosen.map((e, i) => `${i + 1}. \`${e.id}\``).join('\n') +
          '\n做法：逐个 `qq_get_sticker_image` 看图 → `qq_sticker_note` 写 `localRemark`（≤40 字短名）+ `note`（你理解的含义、什么场合该发）。' +
          '**一张一张来**：看完一张立刻用它的 id 写掉再下一张，别先把几张图看完再一起写（容易把 A 的描述写到 B 上）。' +
          '已经有 localRemark / desc / localNote 的不要覆盖；看图写，别照文件名（哈希）猜。' +
          `补完**不要**把进度发到群里，直接收尾（qq_mark_read / qq_set_wake_config）。还剩 ${pending.length - chosen.length} 个没补，不用一次做完。`;
        const r = await notifyAiSession(target, message);
        deps.lastStickerLabelNudgeAt = now;
        log(
          `[sticker] 控制台手动触发补备注：${target}（本次 ${chosen.length} 个，剩 ${pending.length - chosen.length}）`,
        );
        appendActivity(`${target} 控制台手动触发补表情备注（${chosen.length} 个）`);
        sendJson({
          ok: true,
          key: target,
          sessionId: r.sessionId,
          asked: chosen.length,
          remaining: pending.length - chosen.length,
          ids: chosen.map((e) => e.id),
        });
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) }, error?.statusCode || 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const localRemark =
        body.localRemark !== undefined && body.localRemark !== null
          ? String(body.localRemark).trim().slice(0, 40)
          : undefined;
      const tags =
        body.tags !== undefined && body.tags !== null
          ? Array.isArray(body.tags)
            ? body.tags
                .map(String)
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 20)
            : []
          : undefined;
      const usage =
        body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      if (!stickerId) {
        sendJson({ ok: false, error: 'stickerId 不能为空' }, 400);
        return;
      }
      const entry = applyStickerNoteChat(stickerId, note, tags, usage, localRemark);
      if (!entry) {
        sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404);
        return;
      }
      sendJson({ ok: true, sticker: entry });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!stickerId) {
        sendJson({ ok: false, error: 'stickerId 不能为空' }, 400);
        return;
      }
      try {
        const entry = await setStickerRemarkChat(stickerId, String(body.remark ?? ''));
        sendJson({ ok: true, sticker: entry });
      } catch (error) {
        sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 控制台缩略图：把 QQ 收藏表情的图片取回来直接吐字节（控制台鉴权已在上方统一处理）。
    // 为什么不让前端直接 img src=QQ 直链：p.qpic.cn 会校验 referer/时效，浏览器直连常常 403，
    // 而且那样等于把「哪些表情」暴露给第三方请求；走桥接取图最稳，也能复用 safeFetchBuffer。
    if (req.method === 'GET' && url.pathname === '/api/stickers/image') {
      const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
      if (!stickerId) {
        sendJson({ ok: false, error: 'stickerId 不能为空' }, 400);
        return;
      }
      try {
        const entry = await getStickerImageData(stickerId);
        const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_FETCH_BYTES, { timeoutMs: 20000 });
        const fitted = await fitMediaBuffer(fetched.buffer, entry.url);
        if (!fitted) {
          sendJson({ ok: false, error: '表情图片过大且无法压缩' }, 400);
          return;
        }
        res.writeHead(200, {
          'content-type': fitted.mimeType || 'image/jpeg',
          'cache-control': 'private, max-age=600',
          'content-length': String(fitted.buffer.length),
          ...SECURITY_HEADERS,
        });
        res.end(fitted.buffer);
      } catch (error) {
        sendJson({ ok: false, error: `取表情图片失败：${error?.message ?? error}` }, 404);
      }
      return;
    }
    // 置顶到 QQ 收藏夹最前（move_custom_face_to_front）。
    if (req.method === 'POST' && url.pathname === '/api/stickers/promote') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!stickerId) {
        sendJson({ ok: false, error: 'stickerId 不能为空' }, 400);
        return;
      }
      try {
        const entry = await getStickerImageData(stickerId);
        const response = await bot.request('move_custom_face_to_front', { emoji_id: entry.id });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(response?.wording || response?.retcode || 'unknown');
        }
        // 顺序在 QQ 侧已经变了：强制同步一次，让本地库也按新顺序排（控制台看到的就是真实顺序）。
        await syncStickerLibrary(true);
        log(`[sticker] 控制台置顶表情：${entry.id}`);
        sendJson({ ok: true, stickerId: entry.id });
      } catch (error) {
        sendJson({ ok: false, error: `置顶失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 从 QQ 收藏夹删除（delete_custom_face）。不可逆，前端必须二次确认。
    if (req.method === 'POST' && url.pathname === '/api/stickers/delete') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!stickerId) {
        sendJson({ ok: false, error: 'stickerId 不能为空' }, 400);
        return;
      }
      try {
        const entry = await getStickerImageData(stickerId);
        const response = await bot.request('delete_custom_face', { emoji_id: entry.id });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(response?.wording || response?.retcode || 'unknown');
        }
        // QQ 侧删成功后才动本地库；失败时本地保留，避免「本地没了、QQ 还有」的错位。
        const removed = removeSticker(deps.stickerEntries, entry.id);
        deps.stickerEntries = removed.entries;
        saveStickerStoreSafe();
        log(`[sticker] 控制台删除收藏表情：${entry.id}（${entry.desc || entry.localRemark || '无备注'}）`);
        sendJson({ ok: true, stickerId: entry.id, total: deps.stickerEntries.length });
      } catch (error) {
        sendJson({ ok: false, error: `删除失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleImageSearchRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialData/search-images') {
      if (cfg.socialData?.image?.enabled === false) {
        sendJson({ ok: false, error: '图片功能已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const query = String(body.query ?? '').trim();
      // source：auto（默认：先试 pixiv，没结果再回退 B 站）/ bilibili（梗图/表情包）/ pixiv（二次元插画）/ all（两边都要）
      const source = (() => {
        const s = String(body.source ?? '')
          .trim()
          .toLowerCase();
        return s === 'pixiv' || s === 'all' || s === 'auto' ? s : 'bilibili';
      })();
      // pixiv 的 mode：tag=按关键词搜标签页（默认）；daily=综合日榜（可以不给 query）
      const pixivMode = body.mode === 'daily' ? 'daily' : 'tag';
      const needsQuery = !((source === 'pixiv' || source === 'auto') && pixivMode === 'daily');
      if (!key || (needsQuery && !query)) {
        sendJson({ ok: false, error: needsQuery ? 'key 和 query 不能为空' : 'key 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('searchImages')) {
        sendJson({ ok: false, error: '工具未启用：qq_search_images' }, 403);
        return;
      }
      if (!/^(group|private):\d+$/.test(key)) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const st = getSocialV2State(key);
      const imgCfg = cfg.socialData?.image ?? {};
      const now = Date.now();
      const maxPerMinute = Math.max(0, Number(imgCfg.maxPerMinute) || 0);
      const maxPerHour = Math.max(0, Number(imgCfg.maxPerHour) || 0);
      const recentMinute = (st.imageSearchTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.imageSearchTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '搜图太频繁了，请过一会儿再试' }, 429);
        return;
      }
      st.imageSearchTimes = st.imageSearchTimes || [];
      st.imageSearchTimes.push(now);
      if (st.imageSearchTimes.length > 500) st.imageSearchTimes = st.imageSearchTimes.slice(-500);
      try {
        const imgLimits = resolveImageConfig();
        const count = Math.min(12, Math.max(1, Number(body.count) || 6));
        const notes = [];
        let items = [];
        let pixivMeta = null;
        let pixivFailed = '';
        const wantPixiv = source === 'pixiv' || source === 'all' || source === 'auto';
        const wantBilibili = source === 'bilibili' || source === 'all';
        if (wantPixiv) {
          const pixivCfg = imgLimits.pixiv ?? {};
          const opts = { limit: count, rating: imgLimits.rating, words: imgLimits.ratingWords };
          let result = null;
          let webFailed = '';
          // 真实 pixiv：配了代理才走（本机直连不通）。mode 统一用 all：
          // 带 cookie 时它返回 **全年龄 + R-18 混排**（实测一页 32/20/8），由 rating 档位去筛；
          // 不带 cookie 时 pixiv 对未登录会话直接隐藏 R-18，all 等价于 safe。
          if (pixivCfg.enabled && pixivCfg.proxy && pixivMode !== 'daily' && query) {
            try {
              result = await searchPixivWeb(query, {
                mode: 'all',
                cookie: pixivCfg.cookie,
                proxy: pixivCfg.proxy,
                ...opts,
              });
              await attachPixivOriginals(result.items, pixivCfg);
            } catch (error) {
              webFailed = String(error?.message ?? error);
              result = null;
              // 显式 source=pixiv 时如实报错；auto/all 才允许回退镜像。
              if (source === 'pixiv') throw new Error(`真实 pixiv 搜索失败：${webFailed}`);
            }
          }
          try {
            if (!result) {
              result = pixivMode === 'daily' ? await pixivDailyRanking(opts) : await searchPixivByTag(query, opts);
            }
            pixivMeta = {
              mode: result.mode,
              web: result.mode === 'web',
              pixivMode: result.pixivMode,
              pageUrl: result.pageUrl,
              date: result.date,
              rating: result.rating,
              total: result.total,
              kept: result.keptCount ?? result.items.length,
              returned: result.items.length,
              dropped: result.dropped,
            };
            if (webFailed) notes.push(`真实 pixiv 不可用（${webFailed}），已回退 bobopic 镜像`);
            else if (result.mode === 'web')
              notes.push(`图源=真实 pixiv（${result.pixivMode}${pixivCfg.cookie ? '+登录' : ''}）`);
            if (result.dropped.byRating > 0)
              notes.push(`年龄分级=${result.rating}，滤掉 ${result.dropped.byRating} 张超出档位的图`);
            if (result.dropped.explicit > 0)
              notes.push(`滤掉 ${result.dropped.explicit} 张限制级图（任何分级都不返回）`);
            items = items.concat(result.items);
          } catch (error) {
            // auto 才有资格回退；显式 source=pixiv 时把错误如实抛给调用方，别偷偷换源。
            if (source !== 'auto') throw error;
            pixivFailed = String(error?.message ?? error);
          }
        }
        // 防重发：把本会话最近发过的图从结果里摘掉，AI 就不会再挑到同一张。
        const repeatWindow = repeatGuardWindowMs();
        if (repeatWindow > 0 && items.length) {
          const sent = recentSentImageKeys(key, repeatWindow);
          if (sent.size) {
            const before = items.length;
            items = items.filter((it) => !sent.has(imageIdentityKey(it.url || it.thumbUrl, it.file)));
            const skipped = before - items.length;
            if (skipped > 0) notes.push(`已跳过 ${skipped} 张本会话最近发过的图（防重复）`);
            // 全被滤掉时说清楚原因，别让 AI 以为「搜不到」，换个关键词/图源就还能出图。
            if (!items.length) notes.push('本页结果最近都发过了：换关键词或换图源再搜，别重复发同一张');
          }
        }

        // auto：pixiv 报错、或者只捞到零星几张（少于 3 张，含 0 张）时，再用 B 站补/兜底。
        // 只找到 1 张就当作"找到了"会让中文主播这类冷门标签只回一张不相干的图。
        const pixivKept = pixivMeta?.kept ?? 0;
        const needBiliFallback = source === 'auto' && pixivKept < Math.min(3, count);
        if (wantBilibili || needBiliFallback) {
          if (query) {
            const client = createBiliClient({ cookie: readBiliCookie(ROOT) });
            const rawSources = Array.isArray(body.sources)
              ? body.sources
              : body.sources
                ? [body.sources]
                : ['comment', 'article'];
            const sources = rawSources.map(String).filter((x) => x === 'article' || x === 'comment');
            const biliItems = await client.searchImages(query, {
              count,
              sources: sources.length ? sources : ['comment', 'article'],
              videoTop: Math.min(8, Math.max(1, Number(body.videoTop) || 5)),
              commentPages: Math.min(3, Math.max(1, Number(body.commentPages) || 2)),
              animatedOnly: body.animatedOnly === true,
            });
            const merged = biliItems.map((it) => ({ ...it, provider: 'bilibili' }));
            if (needBiliFallback) {
              if (pixivFailed) notes.push(`pixiv 没搜到（${pixivFailed}），已自动回退 B 站`);
              else if (!pixivKept) notes.push('pixiv 没有可用结果（可能都被分级滤掉了），已自动回退 B 站');
              else notes.push(`pixiv 只有 ${pixivKept} 张，已补上 B 站结果`);
            }
            const seen = new Set(items.map((it) => String(it.url)));
            for (const it of merged) {
              if (seen.has(String(it.url))) continue;
              seen.add(String(it.url));
              items.push(it);
            }
          } else if (source === 'bilibili') {
            throw new Error('query 不能为空');
          }
        }
        saveSocialV2State();
        appendActivity(`${key} [${source}] 按主题搜图：${query || '(pixiv 日榜)'}（${items.length} 张）`);
        log(`[${source}] 搜图 ${query || '(pixiv 日榜)'} → ${items.length} 张`);
        const hintParts = [];
        if (source !== 'pixiv')
          hintParts.push(
            'B 站图默认取自相关视频评论区（不够再补专栏配图），不含视频封面；B 站很多 .gif 其实是单帧静态图，要真动图传 animatedOnly=true',
          );
        if (source !== 'bilibili')
          hintParts.push(
            'pixiv 每项的 url 就是原图直链（桥接自己走配置的代理取回，原图拉不动会自动退到 1200px 档，不用你换地址）；**thumbUrl 是 250×250 方形裁切图/220px 小图，别拿它当原图的替代品**，发出去分辨率明显不对。若发送时报「图片超过体积上限」才考虑 thumbUrl；id 也可以留着下次直接复用',
          );
        if (source === 'auto')
          hintParts.push(
            'source=auto 会先试 pixiv 标签，没结果自动回退 B 站（notes 里会写明走的是哪边）；中文主播/VTuber/梗图这种 pixiv 收录少的，本来就更依赖 B 站',
          );
        hintParts.push(
          '每项 url 可直接交给 qq_send_image（source=url）发送，或用 qq_save_sticker 存进收藏表情库；不要刷屏，一次挑 1~2 张合适的即可',
        );
        sendJson({
          ok: true,
          query,
          source,
          pixivMode: source === 'bilibili' ? undefined : pixivMode,
          count: items.length,
          items,
          rating: imgLimits.rating,
          pixiv: pixivMeta,
          pixivError: pixivFailed || undefined,
          notes,
          animatedOnly: body.animatedOnly === true,
          hint: hintParts.join('；'),
        });
      } catch (error) {
        st.imageSearchTimes = st.imageSearchTimes.filter((t) => t !== now);
        sendJson({ ok: false, error: `搜图失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleImageQueryRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/files/message') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const messageId = String(url.searchParams.get('messageId') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (!messageId) {
        sendJson({ ok: false, error: 'messageId 不能为空' }, 400);
        return;
      }
      if (deps.currentMode === 'chat' && !agentToken) {
        sendJson({ ok: false, error: 'chat 模式读取文件必须携带 agent token' }, 403);
        return;
      }
      // 读文件同样允许跨会话（同图片端点，理由见 anyAgentTokenOk）
      if (agentToken && !agentTokenOk(key, agentToken) && !anyAgentTokenOk(agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (agentToken && !v2ToolEnabled('getFile')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_message_file' }, 403);
        return;
      }
      const fcfg = cfg.socialData?.file ?? {};
      if (fcfg.enabled === false) {
        sendJson({ ok: false, error: '文件读取未启用（socialData.file.enabled）' }, 403);
        return;
      }
      // 分页参数：maxChars=0（默认）＝不限，返回全文；工具侧会按 harness 的修剪阈值分块取。
      const offset = Math.max(0, Math.round(Number(url.searchParams.get('offset')) || 0));
      const wantMax = Number(url.searchParams.get('maxChars'));
      const pageChars = Number.isFinite(wantMax) && wantMax > 0 ? Math.min(5_000_000, Math.round(wantMax)) : 0;
      let files = (findMessageMedia(key, messageId) ?? []).filter((m) => m?.kind === 'file');
      if (!files.length) {
        const fallback = await fetchMediaFromOneBot(messageId);
        files = (fallback ?? []).filter((m) => m?.kind === 'file');
        if (files.length) log(`[file] 已用 get_msg 兜底读到文件段（${key} ${messageId}）`);
      }
      if (!files.length) {
        sendJson({ ok: true, messageId, files: [], note: '该消息里没有可读取的文件' });
        return;
      }
      const item = files[0];
      const meta = { name: item.name || '文件', size: Number(item.size) || 0, kind: classifyFile(item.name, '') };
      if (!item.url) {
        sendJson({
          ok: true,
          messageId,
          ...meta,
          text: '',
          images: [],
          note: '这个文件没有下载直链（QQ 离线文件可能只给了 file_id，网关不支持下载）',
        });
        return;
      }
      const maxBytes = Math.max(256 * 1024, Math.min(64 * 1024 * 1024, Number(fcfg.maxBytes) || 50 * 1024 * 1024));
      const tmpDir = fs.mkdtempSync(path.join(STATE_DIR, 'file-tmp-'));
      const safeName =
        String(meta.name)
          .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
          .slice(-80) || 'file';
      const filePath = path.join(tmpDir, safeName);
      try {
        // QQ 自己的文件 CDN（njc-download.ftn.qq.com 等）走 safe-fetch 会超时（同图片那次），
        // 这里对 QQ 域名优先用普通 fetch，失败再回落 safe-fetch。
        let qqGot = null;
        try {
          const host = new URL(String(item.url)).hostname;
          if (/(^|\.)qq\.com$|(^|\.)qq\.com\.cn$|(^|\.)qpic\.cn$/i.test(host)) {
            const res = await fetch(String(item.url), {
              headers: { referer: 'https://qzone.qq.com/', 'user-agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(90000)
            });
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              if (buf.length && buf.length <= maxBytes) { fs.writeFileSync(filePath, buf); qqGot = { size: buf.length }; }
            }
          }
        } catch (error) {
          log(`[file] QQ 直连失败（继续 safe-fetch）：${error?.message ?? error}`);
        }
        const got = qqGot || await safeFetchToFile(item.url, maxBytes, filePath, {
          timeoutMs: Math.max(5000, Number(fcfg.timeoutMs) || 60000),
        });
        const result = await extractFileContent({
          filePath,
          name: meta.name,
          tmpDir,
          options: {
            maxPages: fcfg.maxPages,
            renderDpi: fcfg.renderDpi,
            // 抽取层默认不限（0）；分页只在下面按 offset/maxChars 切
            maxTextChars: fcfg.maxTextChars,
            timeoutMs: Math.max(5000, Number(fcfg.timeoutMs) || 60000),
          },
        });
        const fullText = String(result.text ?? '');
        const totalChars = fullText.length;
        const pageText = pageChars > 0 ? fullText.slice(offset, offset + pageChars) : fullText.slice(offset);
        const consumed = offset + pageText.length;
        const hasMore = consumed < totalChars;
        // 扫描件渲染出来的页面图也要过「图片投喂安全区」（DSH 读大图会爆栈）
        const images = [];
        for (const [i, img] of (result.images ?? []).entries()) {
          const fitted = await fitMediaBuffer(img.buffer, '');
          if (!fitted) continue;
          images.push({
            index: i + 1,
            kind: 'image',
            mimeType: fitted.mimeType,
            data: fitted.buffer.toString('base64'),
            text: `PDF 第 ${img.page} 页（渲染图）`,
          });
        }
        log(
          `[file] ${key} ${messageId} 读取「${meta.name}」：${result.kind}${totalChars ? ` 共 ${totalChars} 字，本次给 ${pageText.length}` : ''}${images.length ? ` + ${images.length} 张页面图` : ''}`,
        );
        sendJson({
          ok: true,
          messageId,
          name: meta.name,
          size: got.bytes,
          kind: result.kind,
          pages: result.pages ?? 0,
          truncated: !!result.truncated,
          text: pageText,
          totalChars,
          offset,
          hasMore,
          ...(hasMore
            ? {
                note: `正文共 ${totalChars} 字，本次给了第 ${offset + 1} 到 ${consumed} 字；要继续读，再调用一次并传 offset=${consumed}。`,
              }
            : {}),
          notes: result.notes ?? [],
          images,
        });
      } catch (error) {
        log(`读取文件失败 ${key} ${messageId}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `读取文件失败：${error?.message ?? error}` }, 500);
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* 清理失败不影响结果 */
        }
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/images/message') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const messageId = String(url.searchParams.get('messageId') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (!messageId) {
        sendJson({ ok: false, error: 'messageId 不能为空' }, 400);
        return;
      }
      if (deps.currentMode === 'chat' && !agentToken) {
        sendJson({ ok: false, error: 'chat 模式读取图片必须携带 agent token' }, 403);
        return;
      }
      // 读图允许跨会话：用任一有效会话令牌即可（AI 可能在私聊会话里被要求看群里的图）
      if (agentToken && !agentTokenOk(key, agentToken) && !anyAgentTokenOk(agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      if (agentToken && !v2ToolEnabled('getImages')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
        return;
      }
      // 单条消息可能有很多张图（线上实例：一条「七宗罪」发了 7 张，而单次上限 5 张），
      // 所以要支持翻页，否则多出来的图对 AI 就是「被吞了」，而且它自己也拿不到。
      const imageOffset = Math.max(0, Math.round(Number(url.searchParams.get('imageOffset')) || 0));
      const wantLimit = Math.round(Number(url.searchParams.get('imageLimit')) || 0);
      const pageLimit = wantLimit > 0 ? Math.min(20, wantLimit) : 0; // 0 = 用默认上限
      const pageSize = pageLimit > 0 ? pageLimit : MAX_MEDIA_COUNT;
      // 两级读取：① 先用桥接缓存里的 media（含机器人自己发的图，已主动记录）；
      // ② 缓存没有、或缓存里的地址抓不到（过期/超限）时，改用网关 get_msg 兜底。
      let media = findMessageMedia(key, messageId);
      let images = [];
      if (media.length) {
        const page = media.slice(imageOffset, imageOffset + pageSize);
        try {
          images = await fetchMediaData(page, { maxCount: pageSize });
        } catch (error) {
          log(`图片查询（缓存）失败 ${key} ${messageId}: ${error?.message ?? error}`);
        }
      }
      if (!images.length) {
        const fallback = await fetchMediaFromOneBot(messageId);
        if (fallback.length) {
          if (!media.length) media = fallback;
          const page = fallback.slice(imageOffset, imageOffset + pageSize);
          try {
            images = await fetchMediaData(page, { maxCount: pageSize });
            if (images.length) log(`[image] 已用 get_msg 兜底读到图片（${key} ${messageId}）`);
          } catch (error) {
            log(`图片查询（get_msg 兜底）失败 ${key} ${messageId}: ${error?.message ?? error}`);
          }
        }
      }
      // 编号要接着上一批（第二批显示「图片6/图片7」，而不是又从 1 开始）
      if (imageOffset > 0) images = images.map((img) => ({ ...img, index: (Number(img.index) || 0) + imageOffset }));
      if (!media.length) {
        sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
        return;
      }
      if (!images.length) {
        sendJson({
          ok: true,
          messageId,
          media,
          images: [],
          note: '图片元数据存在，但取字节失败（链接可能已过期或超出读图体积上限）',
        });
        return;
      }
      const total = media.length;
      const loaded = Math.min(pageSize, Math.max(0, total - imageOffset));
      const hasMore = imageOffset + loaded < total;
      const nextOffset = Math.min(total, imageOffset + loaded);
      // 相册：把这次读到的图落一份到 state/album-inbox（来源＝聊天），控制台统一管理。
      // 以前这些图只下载到临时目录、看完就删；现在相册里能翻到「谁在哪条消息里发的」。
      if (cfg.socialData?.album?.enabled !== false && images.length) {
        try {
          const albumCtx = { root: process.cwd(), stateDir: STATE_DIR };
          for (const img of images) {
            const b64 = String(img?.data ?? '');
            if (!b64) continue;
            const buf = Buffer.from(b64, 'base64');
            if (!buf.length) continue;
            const mime = String(img?.mimeType ?? 'image/jpeg');
            const ext = mime.includes('png')
              ? 'png'
              : mime.includes('webp')
                ? 'webp'
                : mime.includes('gif')
                  ? 'gif'
                  : 'jpg';
            saveChatImage({
              ctx: albumCtx,
              buffer: buf,
              name: `${key.replace(':', '-')}-${messageId}-${img?.index ?? 0}.${ext}`,
            });
          }
        } catch (error) {
          log(`[album] 存聊天图失败：${error?.message ?? error}`);
        }
      }
      sendJson({
        ok: true,
        messageId,
        media,
        images,
        total,
        offset: imageOffset,
        hasMore,
        ...(hasMore
          ? {
              note: `本条消息共 ${total} 个图片/表情，本次给了第 ${imageOffset + 1}~${nextOffset} 个；要看后面的，再调用一次并传 imageOffset=${nextOffset}。`,
            }
          : {}),
      });
      return;
    }

    // 聊天里的 QQ 视频：抓下来抽帧，给视觉模型「看」。
    // 为什么单独一个端点而不是并进 /api/images/message：抽帧要下载整条视频 + 跑 ffmpeg，
    // 慢且重，必须是 AI 明确要看的动作，不能顺带在每条带媒体的消息上做。
    if (req.method === 'GET' && url.pathname === '/api/images/message-video') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const messageId = String(url.searchParams.get('messageId') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (!messageId) {
        sendJson({ ok: false, error: 'messageId 不能为空' }, 400);
        return;
      }
      if (deps.currentMode === 'chat' && !agentToken) {
        sendJson({ ok: false, error: 'chat 模式读取视频必须携带 agent token' }, 403);
        return;
      }
      if (agentToken && !agentTokenOk(key, agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      if (agentToken && !v2ToolEnabled('getMessageVideo')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_message_video' }, 403);
        return;
      }
      if (cfg.socialData?.video?.enabled === false) {
        sendJson({ ok: false, error: 'QQ 视频理解已关闭（socialData.video.enabled=false）' }, 403);
        return;
      }
      const cfgV = cfg.socialData?.video ?? {};
      // 找这条消息里的视频段（缓存优先，老消息走 get_msg 兜底）。
      let media = findMessageMedia(key, messageId).filter((m) => m && m.kind === 'video');
      if (!media.length) media = (await fetchMediaFromOneBot(messageId)).filter((m) => m && m.kind === 'video');
      if (!media.length) {
        sendJson({
          ok: true,
          messageId,
          kind: 'video',
          frames: [],
          note: '这条消息没有视频段（可能不是视频消息，或视频段已过期读不到）',
        });
        return;
      }
      const target = media[0];
      const maxBytes = Math.max(1024 * 1024, Number(cfgV.maxBytes) || 32 * 1024 * 1024);
      const wantFrames = Math.max(
        1,
        Math.min(8, Number(url.searchParams.get('frames')) || Number(cfgV.maxFrames) || 6),
      );
      const maxWidth = Math.max(
        160,
        Math.min(1600, Number(url.searchParams.get('maxWidth')) || Number(cfgV.frameMaxWidth) || 800),
      );
      const videoUrl = String(target.url || '').trim();
      let frames = [];
      let transcript = null;
      let asrNote = '';
      let note = '';
      let meta = { durationSec: 0, width: 0, height: 0, bytes: 0 };
      const hasFfmpeg = !!(await resolveFfmpegPath());
      if (videoUrl && hasFfmpeg) {
        // 视频**边下边落盘**，不整段进内存：聊天视频动辄几十 MB，这台机器总共才 1.6GB 内存，
        // 缓冲整段会把它打爆（也正是「大一点的视频看不了」的根因）。
        const tmpDir = fs.mkdtempSync(path.join(STATE_DIR, 'video-tmp-'));
        const videoFile = path.join(tmpDir, 'in.bin');
        try {
          // 注意用 safeFetchToFile/safeFetchBinary 而不是 safeFetchBuffer：后者强制「必须是图片」，mp4 会被拒。
          const fetched = await safeFetchToFile(videoUrl, maxBytes, videoFile, {
            timeoutMs: Math.max(5000, Number(cfgV.fetchTimeoutMs) || 60000),
          });
          meta.bytes = fetched.bytes;
          // 语音转写与抽帧互不影响：转写失败只降级成"只有画面"
          try {
            const asrCfg = cfg.socialData?.video?.asr ?? {};
            if (asrCfg.enabled !== false && asrCfg.url) {
              transcript = await transcribeMediaAudio(videoFile, asrCfg);
            }
          } catch (asrError) {
            asrNote = `语音转写失败（${String(asrError?.message ?? asrError).slice(0, 120)}），这段声音你听不到`;
            log(`[video] ASR 失败：${asrError?.message ?? asrError}`);
          }
          const extracted = await extractVideoFramesFromFile(videoFile, { frames: wantFrames, maxWidth, tmpDir });
          if (extracted) {
            frames = extracted.frames;
            meta = { ...meta, ...extracted.meta };
          }
        } catch (error) {
          note = `视频下载失败（${error?.message ?? error}），只能给封面。`;
          log(`[video] 下载失败 ${key} ${messageId}: ${error?.message ?? error}`);
        } finally {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            /* 清理失败不影响主流程 */
          }
        }
      } else if (!hasFfmpeg) {
        note =
          '本机没装 ffmpeg（抽帧需要它），只能给视频封面。装法：apt-get install -y ffmpeg，或在 config.json 里把 socialData.video.ffmpegPath 指到 ffmpeg 可执行文件。';
      } else {
        note = '这条视频没有可下载的直链，只能给封面。';
      }
      if (!frames.length) {
        const thumb = await fetchVideoThumb(target);
        if (thumb) {
          frames = [{ buffer: thumb.buffer, mimeType: thumb.mimeType || 'image/jpeg', atSec: null, isThumb: true }];
          note = [note, '下面是视频封面（不是抽帧）。'].filter(Boolean).join(' ');
        }
      }
      const asrLine = transcript?.text
        ? `**语音转写**（自动识别，可能有错，专有名词尤其）：${transcript.text.slice(0, 2000)}`
        : asrNote || '**没有语音转写**：这段声音你听不到，只能根据画面判断；画面之外的信息要问发视频的人。';
      if (!frames.length) {
        sendJson({
          ok: true,
          messageId,
          kind: 'video',
          hasFfmpeg,
          frames: [],
          meta,
          transcript,
          note: [note || '视频既抽不了帧、也没有封面可取。', asrLine].join(' '),
        });
        return;
      }
      sendJson({
        ok: true,
        messageId,
        kind: 'video',
        hasFfmpeg,
        meta,
        transcript,
        note: [note, asrLine].filter(Boolean).join(' '),
        frames: frames.map((f, i) => ({
          index: i + 1,
          atSec: f.atSec,
          isThumb: !!f.isThumb,
          mimeType: f.mimeType || 'image/jpeg',
          data: f.buffer.toString('base64'),
        })),
      });
      return;
    }
  }
  async function handleBiliRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/bili/status') {
      sendJson(biliStatus());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/bili/config') {
      const body = await readBody();
      let wroteCookie = false;
      if (typeof body.sessdata === 'string') {
        const v = body.sessdata.trim();
        fs.mkdirSync(path.dirname(BILI_COOKIE_FILE), { recursive: true });
        if (v) {
          // 只写值就自动补 SESSDATA=；也接受完整 cookie 串
          fs.writeFileSync(BILI_COOKIE_FILE, v.includes('=') ? v : `SESSDATA=${v}`, { mode: 0o600 });
          wroteCookie = true;
        } else {
          try {
            fs.unlinkSync(BILI_COOKIE_FILE);
          } catch {
            /* 本来就没有 */
          }
        }
      }
      if (body.targets && typeof body.targets === 'object') {
        const t = body.targets;
        const toList = (v, stripCv) =>
          (Array.isArray(v) ? v : [])
            .map((x) => String(x ?? '').trim())
            .map((x) => (stripCv ? x.replace(/^cv/i, '') : x))
            .filter(Boolean)
            .slice(0, 100);
        const clean = {
          keywords: toList(t.keywords, false),
          bvids: toList(t.bvids, false),
          mids: toList(t.mids, false),
          cvs: toList(t.cvs, true),
          sources: {
            cover: t.sources?.cover !== false,
            comments: t.sources?.comments !== false,
            dynamic: t.sources?.dynamic !== false,
            detail: t.sources?.detail === true,
          },
          limit: Math.max(1, Math.min(500, Number(t.limit) || 40)),
          dynamicPages: Math.max(1, Math.min(20, Number(t.dynamicPages) || 1)),
          commentPages: Math.max(1, Math.min(20, Number(t.commentPages) || 1)),
          minSide: Math.max(0, Math.min(4000, Number(t.minSide) || 150)),
          maxBytes: Math.max(1024, Math.min(20 * 1024 * 1024, Number(t.maxBytes) || 5242880)),
          delayMs: Math.max(0, Math.min(10000, Number(t.delayMs) || 900)),
        };
        fs.mkdirSync(path.dirname(BILI_TARGETS_FILE), { recursive: true });
        fs.writeFileSync(BILI_TARGETS_FILE, JSON.stringify(clean, null, 2));
        log(`[bili] 抓图目标已更新：BV ${clean.bvids.length} / UID ${clean.mids.length} / 专栏 ${clean.cvs.length}`);
      }
      sendJson({ ok: true, wroteCookie, ...biliStatus() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/bili/fetch') {
      if (!fs.existsSync(BILI_RUNNER)) {
        sendJson({ ok: false, error: '抓图脚本不存在：scripts/bili-fetch-run.sh' }, 500);
        return;
      }
      try {
        const child = spawn('bash', [BILI_RUNNER], { cwd: ROOT, detached: true, stdio: 'ignore' });
        child.unref();
        appendActivity('[bili] 手动触发一次抓图');
        log('[bili] 已手动触发抓图（后台运行，日志见 state/bili-fetch.log）');
        sendJson({ ok: true, started: true });
      } catch (error) {
        sendJson({ ok: false, error: `启动抓图失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 按需「学梗」：本地黑话库 → B 站（视频标题/简介 + 高赞评论）→ 存为候选词条
    // ── B站视频理解：搜索 / 元数据 / 字幕（JSON） ──────────────────────
    if (req.method === 'POST' && url.pathname === '/api/socialData/bili-video') {
      if (cfg.bili?.enabled === false) {
        sendJson({ ok: false, error: 'B站能力已关闭（bili.enabled=false）' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const op = String(body.op ?? 'info').trim();
      if (token && !agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (token && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      const needFlag = 'video'; // 搜索与读字幕已合并为一个工具
      if (token && !v2ToolEnabled(needFlag)) {
        sendJson({ ok: false, error: `工具未启用：${needFlag}` }, 403);
        return;
      }
      if (cfg.socialData?.enabled === false || deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      try {
        const v = videoToolsOf();
        if (op === 'search') {
          const word = String(body.word ?? '')
            .trim()
            .slice(0, 60);
          if (!word) {
            sendJson({ ok: false, error: 'word 不能为空' }, 400);
            return;
          }
          const list = await createBiliClient({ cookie: readBiliCookie(ROOT) }).searchVideos(word, { page: 1 });
          const n = Math.max(1, Math.min(20, Number(body.limit) || 8));
          sendJson({
            ok: true,
            op,
            word,
            items: list.slice(0, n).map((x) => ({ bvid: x.bvid, title: x.title, aid: x.aid })),
            note: 'B站是中文时事/赛事/梗的最佳源。挑一个 bvid 传回 qq_video 就能读它的字幕文字稿；想看画面再用 qq_video_frames 按时间点取帧。',
          });
          return;
        }
        const bvid = String(body.bvid ?? '').trim();
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
          sendJson({ ok: false, error: 'bvid 格式不对' }, 400);
          return;
        }
        if (op === 'info') {
          const m = await v.meta(bvid);
          // 顺带报「有没有字幕/有没有画面」，让 AI 决定走哪条路
          const [sub, sb] = await Promise.all([
            v
              .subtitle(bvid)
              .then((x) => ({
                available: x.available,
                lan: x.lan,
                chars: x.chars,
                tokensEst: x.tokensEst,
                reason: x.reason,
              }))
              .catch((e) => ({ available: false, reason: String(e.message) })),
            v
              .storyboard(bvid)
              .then((x) => ({ available: x.available, frames: x.count, frameW: x.frameW, frameH: x.frameH }))
              .catch((e) => ({ available: false, reason: String(e.message) })),
          ]);
          sendJson({ ok: true, op, video: m, subtitle: sub, frames: sb });
          return;
        }
        if (op === 'subtitle') {
          const r = await v.subtitle(bvid, {
            offset: Math.max(0, Number(body.offset) || 0),
            limit: Math.max(0, Math.min(600, Number(body.limit) || 0)),
          });
          // segments 可能很长，默认只给文字；显式要才回时间轴
          if (body.withSegments !== true) delete r.segments;
          sendJson({ ok: true, op, ...r });
          return;
        }
        sendJson({ ok: false, error: `未知 op：${op}（可选 search/info/subtitle）` }, 400);
      } catch (error) {
        sendJson({ ok: false, error: `B站视频请求失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleBiliFrameRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialData/bili-frames') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      if (token && !agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (token && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (token && !v2ToolEnabled('videoFrames')) {
        sendJson({ ok: false, error: '工具未启用：videoFrames' }, 403);
        return;
      }
      if (cfg.socialData?.enabled === false || deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      const bvid = String(body.bvid ?? '').trim();
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
        sendJson({ ok: false, error: 'bvid 格式不对' }, 400);
        return;
      }
      try {
        const r = await videoToolsOf().frames(bvid, {
          atSeconds: Math.max(0, Number(body.atSeconds) || 0),
          count: Math.max(1, Math.min(12, Number(body.count) || 4)),
          spreadSeconds: Math.max(0, Math.min(300, Number(body.spreadSeconds) || 0)),
        });
        sendJson({
          ok: true,
          bvid,
          title: r.title,
          duration: r.duration,
          requestedAt: r.requestedAt,
          pickedAt: r.pickedAt,
          failures: r.failures,
          note: '这是 B站进度条预览图切出来的帧（480×270），格 ~5 秒一帧，可能错过瞬时画面。',
          images: r.images.map((im) => ({ at: im.at, mimeType: im.mimeType, data: im.data })),
        });
      } catch (error) {
        sendJson({ ok: false, error: `取帧失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialData/lookup-meme') {
      if (cfg.slang?.enabled === false) {
        sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const word = String(body.word ?? '')
        .trim()
        .slice(0, 50);
      if (!key || !word) {
        sendJson({ ok: false, error: 'key 和 word 不能为空' }, 400);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('lookupMeme')) {
        sendJson({ ok: false, error: '工具未启用：qq_lookup_meme' }, 403);
        return;
      }
      try { deps.stampVerified?.(key); } catch { /* 忽略 */ }
      const lower = word.toLowerCase();
      // ① 内存缓存（10 分钟）：同一个梗连着查不再打网络
      const cached = memeDigestCache.get(lower);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        // 与联网路径保持同样的 JSON 形状（都包在 digest 里），避免调用方两套解析
        sendJson({
          ok: true,
          word,
          from: 'cache',
          digest: cached.digest,
          note: '来自 10 分钟内的查询缓存（同样的视频/评论结果）。',
        });
        return;
      }
      // ② 本地库：必须真的有释义才算命中（候选项只有 suggested*，不能当答案返回）
      const hasMeaning = (e) => !!(e && (e.meaning || '').trim());
      const local =
        deps.slangEntries.find((e) => hasMeaning(e) && String(e.content || '').toLowerCase() === lower) ||
        // 退一步做包含匹配（「theshy」能命中「ig theshy」），但只在词够长时，避免误配
        (lower.length >= 3
          ? deps.slangEntries.find(
              (e) =>
                hasMeaning(e) &&
                String(e.content || '')
                  .toLowerCase()
                  .includes(lower),
            )
          : null);
      if (local) {
        sendJson({
          ok: true,
          word,
          from: 'library',
          status: local.status,
          entry: {
            content: local.content,
            meaning: local.meaning || '',
            usage: local.usage || '',
            example: local.example || '',
            risk: local.risk || '',
            sources: local.sources || [],
          },
        });
        return;
      }
      // ②b 向量兜底：字面没命中、但语义很近的情况，错别字/变体/谐音（「哈鸡米」→「哈基米」）。
      // 实测这类对的余弦 0.55~0.75，无关对 ≤0.31，所以门槛取 0.5 偏保守，宁可不命中也不乱答。
      if (ragEnabled()) {
        try {
          const confirmed = deps.slangEntries.filter((e) => e.status === SLANG_STATUS.CONFIRMED && hasMeaning(e));
          const [qv] = await embedder.embed([word]);
          const best = scoreEntries({
            queryVec: qv,
            entries: confirmed,
            store: deps.vectorStore,
            key,
            minCosine: 0,
          })[0];
          const gate = Number(cfg.rag?.linkMinCosine ?? 0.5);
          if (best && best.sem >= gate) {
            const e = best.entry;
            sendJson({
              ok: true,
              word,
              from: 'vector',
              matched: e.content,
              similarity: +best.sem.toFixed(3),
              status: e.status,
              entry: {
                content: e.content,
                meaning: e.meaning || '',
                usage: e.usage || '',
                example: e.example || '',
                risk: e.risk || '',
                sources: e.sources || [],
              },
            });
            return;
          }
        } catch {
          /* 向量不可用就继续走联网检索 */
        }
      }
      // ③ 联网检索：给硬超时，保证不拖慢回复；超时就只给视频标题并转异步深度研究
      const withBudget = (promise, ms) =>
        Promise.race([
          promise,
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error('budget')), ms);
            t.unref?.();
          }),
        ]);
      try {
        const client = createBiliClient({ cookie: readBiliCookie(ROOT) });
        let k;
        try {
          k = await withBudget(
            client.lookupKnowledge(word, { videoCount: 5, commentCount: 10, commentVideos: 1 }),
            4000,
          );
        } catch {
          // 超预算：退化成只搜视频标题（快），评论放弃
          const vids = await withBudget(client.searchVideos(word, { page: 1 }), 2500).catch(() => []);
          k = {
            videos: vids
              .slice(0, 5)
              .map((v) => ({ bvid: v.bvid, aid: v.aid, title: v.title, desc: '', play: null, author: '' })),
            comments: [],
          };
          log(`[meme] 「${word}」联网超预算，已退化为仅视频标题；深度研究在词条落库后统一排队`);
        }
        const digest = {
          videos: k.videos
            .slice(0, 6)
            .map((v) => ({ bvid: v.bvid, title: v.title, desc: v.desc, play: v.play, author: v.author })),
          comments: k.comments.slice(0, 12).map((c) => ({ text: c.text, like: c.like, from: c.from })),
          sources: k.videos.slice(0, 3).map((v) => `https://www.bilibili.com/video/${v.bvid}`),
        };
        memeDigestCache.set(lower, { at: Date.now(), digest });
        // 存成候选词条：轻量结果先进库，异步管线随后做深度考究并自动转正
        try {
          const now = Date.now();
          let entry = deps.slangEntries.find((e) => String(e.content || '').toLowerCase() === lower);
          if (!entry) {
            entry = {
              id: `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
              content: word,
              meaning: '',
              usage: '',
              example: '',
              risk: '',
              status: SLANG_STATUS.CANDIDATE,
              count: 1,
              sources: digest.sources,
              createdAt: now,
              updatedAt: now,
            };
            deps.slangEntries.push(entry);
          }
          entry.sources = digest.sources;
          entry.suggestedMeaning = digest.videos[0] ? digest.videos[0].title : '';
          entry.suggestedUsage = digest.comments[0] ? `高赞评论：${digest.comments[0].text}` : '';
          entry.updatedAt = now;
          saveSlangStore();
        } catch (error) {
          log(`[meme] 写入候选词条失败：${error?.message ?? error}`);
        }
        log(`[meme] 学梗「${word}」→ 视频 ${digest.videos.length} / 评论 ${digest.comments.length}`);
        // 这次只是「够用」的轻量结果；候选词条交给异步管线做深度考究，
        // 出释义后自动转正，下次同一条梗直接命中本地库（零网络）。
        enqueueMemeResearch(word);
        sendJson({
          ok: true,
          word,
          from: 'bilibili',
          digest,
          note: '这些是 B 站的相关视频与高赞评论（最真实的用法语境）。贴吧/萌娘百科本机直连被反爬/需授权，需要时用 web_search 兜底。已同时排入后台深度考究，出释义后自动转正；同一条梗 10 分钟内再查直接命中缓存，之后命中本地库（零网络）。',
        });
      } catch (error) {
        sendJson({ ok: false, error: `学梗失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleAiImageRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/ai-images' || url.pathname.startsWith('/api/ai-images/')) {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      const action = url.pathname === '/api/ai-images' ? '' : url.pathname.slice('/api/ai-images/'.length);
      try {
        // 图片预览/下载：直接回字节流。控制台鉴权已在上面统一做过（浏览器 <img> 带 Cookie）。
        if (req.method === 'GET' && action === 'file') {
          const found = imageAdmin.fileFor({
            source: String(url.searchParams.get('source') ?? '').trim(),
            name: String(url.searchParams.get('name') ?? '').trim(),
          });
          res.writeHead(200, {
            'content-type': found.mime,
            'content-length': String(found.bytes),
            'Cache-Control': 'private, max-age=60',
            'X-Content-Type-Options': 'nosniff',
          });
          const stream = fs.createReadStream(found.abs);
          // 统计和真正读之间文件被删/被换（控制台正好删了它）时，别把异常抛到进程级
          stream.on('error', () => {
            try {
              res.destroy();
            } catch {
              /* 连接已断 */
            }
          });
          stream.pipe(res);
          return;
        }
        if (req.method === 'GET' && (action === '' || action === 'inventory')) {
          sendJson(imageAdmin.inventory());
          return;
        }
        if (req.method === 'GET' && action === 'items') {
          sendJson(
            imageAdmin.items({
              source: String(url.searchParams.get('source') ?? '').trim(),
              q: String(url.searchParams.get('q') ?? '').trim(),
              sort: String(url.searchParams.get('sort') ?? 'time').trim(),
              limit: Number(url.searchParams.get('limit')) || 300,
            }),
          );
          return;
        }
        if (req.method === 'GET' && action === 'trash') {
          sendJson(imageAdmin.listTrash());
          return;
        }
        // 补抓历史发过的图：GET 看进度，POST 启动（后台跑，接口立刻返回）
        if (req.method === 'GET' && action === 'backfill') {
          sendJson({ ok: true, backfill: sentBackfill, candidates: sentImageUrlCandidates().length });
          return;
        }
        if (req.method !== 'POST') {
          sendJson({ ok: false, error: `不支持的请求：${req.method} ${url.pathname}` }, 405);
          return;
        }
        const body = await readBody();
        if (action === 'backfill') {
          const started = startSentBackfill({ limit: body.limit, budgetMs: body.budgetMs });
          sendJson({
            ok: true,
            backfill: started,
            candidates: sentImageUrlCandidates().length,
            inventory: imageAdmin.inventory(),
          });
          return;
        }
        if (action === 'remove') {
          const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? '')].filter(Boolean);
          const result = imageAdmin.remove({
            source: String(body.source ?? '').trim(),
            names,
            reason: `控制台删除 ${names.length} 张`,
          });
          if (result.removed?.length) log(`控制台：删除 AI 图片 ${result.removed.length} 张（回收站 ${result.trash}）`);
          sendJson(result);
          return;
        }
        if (action === 'clear') {
          const result = imageAdmin.clear({
            source: String(body.source ?? '').trim(),
            reason: '控制台清空该来源',
          });
          if (result.removed?.length)
            log(`控制台：清空图片来源 ${result.source}（${result.removed.length} 张 → 回收站 ${result.trash}）`);
          sendJson(result);
          return;
        }
        if (action === 'forget') {
          const result = imageAdmin.forget({
            source: String(body.source ?? '').trim(),
            olderThanDays: body.olderThanDays,
            maxTotalMB: body.maxTotalMB,
            reason: '控制台自然清理',
          });
          if (result.ok)
            log(`控制台：AI 图片自然清理 ${result.forgotten?.files ?? 0} 张（回收站 ${result.trash || '无'}）`);
          sendJson(result);
          return;
        }
        if (action === 'restore') {
          const result = imageAdmin.restore({
            stamp: String(body.stamp ?? '').trim(),
            items: Array.isArray(body.items) ? body.items : [],
          });
          if (result.restored?.length) log(`控制台：从回收站还原 AI 图片 ${result.restored.length} 张`);
          sendJson(result);
          return;
        }
        if (action === 'purge') {
          const result = imageAdmin.purge({ stamp: String(body.stamp ?? '').trim() });
          log(`控制台：彻底删除回收站 ${result.purged?.batches ?? 0} 个批次 / ${result.purged?.files ?? 0} 张`);
          sendJson(result);
          return;
        }
        sendJson({ ok: false, error: `未知的图片管理动作：${action || '(空)'}` }, 404);
        return;
      } catch (error) {
        log('图片管理接口异常:', error?.stack ?? error);
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
        return;
      }
    }
  }
  async function handleAlbumRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (url.pathname === '/api/album' || url.pathname.startsWith('/api/album/')) {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      const action = url.pathname === '/api/album' ? '' : url.pathname.slice('/api/album/'.length);
      const metaFile = path.join(STATE_DIR, ALBUM_META_FILE);
      const readMeta = () => {
        const raw = readJsonSafe(metaFile, {});
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      };
      const albumCtx = { root: process.cwd(), stateDir: STATE_DIR };
      // 收藏表情不是磁盘文件：单独拼进来（笔记就存在 stickers.json 里）
      const itemsNow = () =>
        collectAlbumItems({ ctx: albumCtx, meta: readMeta() }).concat(
          collectStickerItems({ stickers: deps.stickerEntries, meta: readMeta() }),
        );
      try {
        // 缩略图：网格里如果直接给原图，一屏几十张就是几百 MB（线上实测相册页极卡）。
        // 用 sharp 缩到 320px 的 jpg 缓存到 state/album-thumbs/<来源>/，第二次直接读缓存。
        if (req.method === 'GET' && action === 'thumb') {
          const source = String(url.searchParams.get('source') ?? '').trim();
          const name = String(url.searchParams.get('file') ?? '').trim();
          const width = Math.max(80, Math.min(800, Number(url.searchParams.get('w')) || 320));
          const def = ALBUM_SOURCES.find((d) => d.id === source);
          if (!def || !isAlbumImageName(name)) {
            sendJson({ ok: false, error: '来源或文件名不合法' }, 400);
            return;
          }
          const dir = path.resolve(def.dir(albumCtx));
          const abs = path.resolve(dir, name);
          if (!abs.startsWith(dir + path.sep)) {
            sendJson({ ok: false, error: '路径不合法' }, 400);
            return;
          }
          const thumbDir = path.join(STATE_DIR, 'album-thumbs', source);
          const thumbFile = path.join(thumbDir, `${width}-${name.replace(/\.[^.]+$/, '')}.jpg`);
          let buf = null;
          try {
            buf = fs.readFileSync(thumbFile);
          } catch {
            buf = null;
          }
          if (!buf) {
            try {
              fs.mkdirSync(thumbDir, { recursive: true });
              buf = await sharp(abs)
                .rotate()
                .resize({ width, withoutEnlargement: true })
                .jpeg({ quality: 72, mozjpeg: true })
                .toBuffer();
              fs.writeFileSync(thumbFile, buf);
            } catch (error) {
              // 缩不出来（损坏/不支持的格式）就退化成原图，别让网格留黑洞
              try {
                buf = fs.readFileSync(abs);
              } catch {
                sendJson({ ok: false, error: '图片读不出来' }, 404);
                return;
              }
            }
          }
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': String(buf.length),
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(buf);
          return;
        }
        // 预览/下载：只允许相册来源目录里的文件（防目录穿越）
        if (req.method === 'GET' && action === 'file') {
          const source = String(url.searchParams.get('source') ?? '').trim();
          const name = String(url.searchParams.get('file') ?? '').trim();
          const def = ALBUM_SOURCES.find((d) => d.id === source);
          if (!def || !isAlbumImageName(name)) {
            sendJson({ ok: false, error: '来源或文件名不合法' }, 400);
            return;
          }
          const dir = path.resolve(def.dir(albumCtx));
          const abs = path.resolve(dir, name);
          if (!abs.startsWith(dir + path.sep)) {
            sendJson({ ok: false, error: '路径不合法' }, 400);
            return;
          }
          let buf;
          try {
            buf = fs.readFileSync(abs);
          } catch {
            sendJson({ ok: false, error: '文件不存在' }, 404);
            return;
          }
          const mime = /.png$/i.test(name)
            ? 'image/png'
            : /.webp$/i.test(name)
              ? 'image/webp'
              : /.gif$/i.test(name)
                ? 'image/gif'
                : 'image/jpeg';
          res.writeHead(200, {
            'content-type': mime,
            'content-length': String(buf.length),
            'Cache-Control': 'private, max-age=60',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(buf);
          return;
        }
        if (req.method === 'GET' && (action === '' || action === 'list')) {
          const source = String(url.searchParams.get('source') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '')
            .trim()
            .toLowerCase();
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 60));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const all = itemsNow();
          // 分类 tab 的数字要用全集算（否则只显示当前分类的条数）
          const stats = albumStats(all);
          let items = all;
          if (source) items = items.filter((it) => it.source === source);
          if (q)
            items = items.filter((it) =>
              `${it.notes} ${(it.tags || []).join(' ')} ${it.file}`.toLowerCase().includes(q),
            );
          const total = items.length;
          const page = items.slice(offset, offset + limit);
          sendJson({
            ok: true,
            sources: [
              ...ALBUM_SOURCES.map((d) => ({ id: d.id, label: d.label })),
              { id: STICKER_SOURCE.id, label: STICKER_SOURCE.label },
            ],
            stats,
            total,
            offset,
            limit,
            hasMore: offset + page.length < total,
            items: page,
          });
          return;
        }
        if (req.method === 'PATCH' && (action === '' || action === 'item')) {
          const body = await readBody();
          const source = String(body.source ?? '').trim();
          const file = String(body.file ?? '').trim();
          if (!file || !(ALBUM_SOURCES.some((d) => d.id === source) || source === STICKER_SOURCE.id)) {
            sendJson({ ok: false, error: 'source/file 不合法' }, 400);
            return;
          }
          if (source === 'sticker') {
            // 表情笔记的真源是相册（album-meta.json）：写这里，同时更新内存里的 stickerEntries
            // 供提示词/选图即时生效；stickers.json 不再存笔记（已迁移）。
            if (!deps.stickerEntries.some((e) => String(e.id ?? e.emojiId ?? e.md5) === file)) {
              sendJson({ ok: false, error: '表情不存在' }, 404);
              return;
            }
            const next = updateAlbumMeta(readMeta(), itemId('sticker', file), { notes: body.notes, tags: body.tags });
            atomicWriteJson(metaFile, next);
            const entry = applyStickerNoteChat(file, body.notes, body.tags, undefined, body.notes);
            const saved = next[itemId('sticker', file)] || {};
            sendJson({
              ok: true,
              id: itemId('sticker', file),
              item: {
                id: itemId('sticker', file),
                file,
                source: 'sticker',
                notes: saved.notes || '',
                tags: saved.tags || [],
              },
            });
            return;
          }
          const id = itemId(source, file);
          const next = updateAlbumMeta(readMeta(), id, { notes: body.notes, tags: body.tags });
          atomicWriteJson(metaFile, next);
          const item = collectAlbumItems({ ctx: albumCtx, meta: next }).find((it) => it.id === id) || null;
          sendJson({ ok: true, id, item });
          return;
        }
        if (req.method === 'POST' && action === 'delete') {
          const body = await readBody();
          const source = String(body.source ?? '').trim();
          if (source === 'sticker') {
            sendJson({ ok: false, error: '收藏表情请在 QQ 的表情管理里删除；相册里可以改备注/标签' }, 400);
            return;
          }
          const file = String(body.file ?? '').trim();
          const def = ALBUM_SOURCES.find((d) => d.id === source);
          if (!def || !isAlbumImageName(file)) {
            sendJson({ ok: false, error: 'source/file 不合法' }, 400);
            return;
          }
          const dir = path.resolve(def.dir(albumCtx));
          const abs = path.resolve(dir, file);
          if (!abs.startsWith(dir + path.sep)) {
            sendJson({ ok: false, error: '路径不合法' }, 400);
            return;
          }
          // 不直接抹盘：挪进回收站目录，能手动还原
          const trashDir = path.join(STATE_DIR, 'album-trash', source);
          fs.mkdirSync(trashDir, { recursive: true });
          try {
            fs.renameSync(abs, path.join(trashDir, `${Date.now()}-${file}`));
          } catch (error) {
            sendJson({ ok: false, error: `删除失败：${error?.message ?? error}` }, 500);
            return;
          }
          const next = updateAlbumMeta(readMeta(), itemId(source, file), { notes: '', tags: [] });
          atomicWriteJson(metaFile, next);
          sendJson({ ok: true, id: itemId(source, file), trashedTo: trashDir });
          return;
        }
        // ── 回收站：查看 / 还原 / 彻底删 / 清空 ──────────────────────
        if (req.method === 'GET' && action === 'trash') {
          const source = String(url.searchParams.get('source') ?? '').trim();
          const items = listTrash({ stateDir: STATE_DIR, source });
          sendJson({
            ok: true,
            items,
            stats: { count: items.length, bytes: items.reduce((n, x) => n + (Number(x.bytes) || 0), 0) },
          });
          return;
        }
        if (req.method === 'GET' && action === 'trash-file') {
          const source = String(url.searchParams.get('source') ?? '').trim();
          const trashName = String(url.searchParams.get('name') ?? '').trim();
          if (!trashName || trashName.includes('/') || trashName.includes('..')) {
            sendJson({ ok: false, error: '文件名不合法' }, 400);
            return;
          }
          let buf;
          try {
            buf = fs.readFileSync(trashPath({ stateDir: STATE_DIR, source, trashName }));
          } catch {
            sendJson({ ok: false, error: '文件不存在' }, 404);
            return;
          }
          const mime = /\.png$/i.test(trashName)
            ? 'image/png'
            : /\.webp$/i.test(trashName)
              ? 'image/webp'
              : /\.gif$/i.test(trashName)
                ? 'image/gif'
                : 'image/jpeg';
          res.writeHead(200, {
            'content-type': mime,
            'content-length': String(buf.length),
            'Cache-Control': 'private, max-age=60',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(buf);
          return;
        }
        if (req.method === 'POST' && action === 'trash-restore') {
          const body = await readBody();
          const r = restoreTrash({
            stateDir: STATE_DIR,
            root: process.cwd(),
            source: String(body.source ?? ''),
            trashName: String(body.trashName ?? ''),
          });
          sendJson(r.ok ? { ok: true, file: r.file } : { ok: false, error: r.error }, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && action === 'trash-purge') {
          const body = await readBody();
          const r = purgeTrash({
            stateDir: STATE_DIR,
            source: String(body.source ?? ''),
            trashName: String(body.trashName ?? ''),
          });
          sendJson(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && action === 'trash-empty') {
          const body = await readBody();
          const r = emptyTrash({ stateDir: STATE_DIR, source: String(body.source ?? '') });
          sendJson({ ok: true, removed: r.removed });
          return;
        }
        // 批量删除：网格里勾选多张一次删（全部进回收站）
        if (req.method === 'POST' && action === 'delete-batch') {
          const body = await readBody();
          const list = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
          let removed = 0;
          const failed = [];
          for (const it of list) {
            const source = String(it?.source ?? '');
            const file = String(it?.file ?? '');
            const def = ALBUM_SOURCES.find((d) => d.id === source);
            if (!def || !isAlbumImageName(file)) {
              failed.push({ source, file, error: '参数不合法' });
              continue;
            }
            const dir = path.resolve(def.dir(albumCtx));
            const abs = path.resolve(dir, file);
            if (!abs.startsWith(dir + path.sep)) {
              failed.push({ source, file, error: '路径不合法' });
              continue;
            }
            const trashDir = path.join(STATE_DIR, 'album-trash', source);
            fs.mkdirSync(trashDir, { recursive: true });
            try {
              fs.renameSync(abs, path.join(trashDir, `${Date.now()}-${file}`));
              removed += 1;
            } catch (error) {
              failed.push({ source, file, error: String(error?.message ?? error) });
            }
          }
          sendJson({ ok: true, removed, failed });
          return;
        }
        if (req.method === 'POST' && action === 'rescan') {
          const items = itemsNow();
          sendJson({ ok: true, ...albumStats(items) });
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }

  return {
    handleStickerV2Routes,
    handleStickerPickRoutes,
    handleStickerAdminRoutes,
    handleImageSearchRoutes,
    handleImageQueryRoutes,
    handleBiliRoutes,
    handleBiliFrameRoutes,
    handleAiImageRoutes,
    handleAlbumRoutes,
  };
}
