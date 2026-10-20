// 黑话库与群知识库：控制台管理 + AI 侧查询沉淀。
//
// 从 bridge.js 抽出的控制台路由。依赖由工厂函数注入：
// 稳定的函数/常量按值传入；会被重新赋值的绑定用 getter/setter（模块内以 deps.xxx 访问）。

export function createSlangKnowledgeRoutes(deps) {
  const {
    ANSWER_MAX,
    DEFAULT_KINDS,
    KNOWLEDGE_KINDS,
    KNOWLEDGE_STATUS,
    KNOWLEDGE_STATUSES,
    QUESTION_MAX,
    ROOT,
    SLANG_STATUS,
    VECTOR_MODEL,
    agentTokenOk,
    allowKnowledgeSubmit,
    allowSlangSubmit,
    appendActivity,
    asIndexEntry,
    atomicWriteJson,
    buildKnowledgeContext,
    buildSlangContext,
    cfg,
    confirmedKnowledgeList,
    confirmedSlangListV2,
    createKnowledgeEntry,
    createSlangEntry,
    embedder,
    findKnowledgeMatch,
    formatKnowledgeTable,
    formatSlangTable,
    invalidateSlangLearnerSession,
    isActiveStatus,
    kbEntryById,
    knowledgeEnabled,
    knowledgeOptions,
    knowledgeReady,
    knowledgeRemindMinAskers,
    knowledgeRemindThreshold,
    listKnowledgeConflicts,
    log,
    markKnowledgeDirty,
    mergeEvidence,
    modeAllowed,
    nearDuplicates,
    path,
    planRebuild,
    publicKnowledgeEntry,
    publicSlangEntry,
    questionFingerprint,
    queueSlangTask,
    ragEnabled,
    ragReady,
    ragStatus,
    readJsonSafe,
    rebuildKnowledgeIndex,
    rebuildRagIndex,
    redactKnownTokensOnly,
    runSlangExtraction,
    runSlangResearch,
    saveKnowledgeStore,
    saveSlangStore,
    scheduleKnowledgeRebuild,
    scoreEntries,
    selectForInjection,
    shouldRemindRepeat,
    slangExtractionCooldowns,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    upsertKnowledge,
  } = deps;

  async function handleSlangRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/slang') {
      const status = url.searchParams.get('status') || '';
      const list = status ? deps.slangEntries.filter((e) => e.status === status) : deps.slangEntries;
      sendJson({ entries: list, config: cfg.slang });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang') {
      const body = await readBody();
      const content = String(body.content ?? '').trim();
      if (!content) {
        sendJson({ ok: false, error: '黑话内容不能为空' }, 400);
        return;
      }
      if (deps.slangEntries.some((e) => e.content === content)) {
        sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400);
        return;
      }
      const entry = createSlangEntry({
        content,
        meaning: String(body.meaning ?? '').trim(),
        usage: String(body.usage ?? '').trim(),
        example: String(body.example ?? '').trim(),
        risk: String(body.risk ?? '').trim(),
        sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
        // 手动添加默认落到**候选**：已确认的条目会被注入提示词、被 AI 当成事实使用，
        // 所以「刚敲进去、还没复核」的词条不该直接变成已确认，AI 自己提交的词也走
        // 同一条候选→确认的复核路径（见 /api/socialV2/slang/submit）。
        // 只有显式传 confirmed 才直接入库为已确认（例如从别处导入一批已核实的词）。
        status: body.status === SLANG_STATUS.CONFIRMED ? SLANG_STATUS.CONFIRMED : SLANG_STATUS.CANDIDATE,
        source: 'manual',
        evidence: Array.isArray(body.evidence) ? body.evidence : [],
      });
      deps.slangEntries.push(entry);
      saveSlangStore();
      log(`控制台：新增黑话「${content}」（${entry.status === SLANG_STATUS.CANDIDATE ? '候选' : '已确认'}）`);
      sendJson({ ok: true, entry });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
      const body = await readBody();
      const status = String(body.status ?? '').trim();
      if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
        sendJson(
          { ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` },
          400,
        );
        return;
      }
      let removedCount = 0;
      if (status) {
        removedCount = deps.slangEntries.filter((e) => e.status === status).length;
        deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
      } else {
        removedCount = deps.slangEntries.length;
        deps.slangEntries = [];
        // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
        slangWindows.clear();
        slangExtractionCooldowns.clear();
        slangSubmitTimes.clear();
        slangResearchingIds.clear();
      }
      saveSlangStore();
      log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
      sendJson({ ok: true, removedCount });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const status = String(body.status ?? '').trim();
      if (ids.length) {
        const idSet = new Set(ids);
        const before = deps.slangEntries.length;
        deps.slangEntries = deps.slangEntries.filter((e) => !idSet.has(e.id));
        const removedCount = before - deps.slangEntries.length;
        if (!removedCount) {
          sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404);
          return;
        }
        saveSlangStore();
        log(`控制台：批量删除黑话 ${removedCount} 条`);
        sendJson({ ok: true, removedCount });
        return;
      }
      if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
        return;
      }
      if (!status) {
        sendJson({ ok: false, error: '请提供 ids 或 status' }, 400);
        return;
      }
      const removedCount = deps.slangEntries.filter((e) => e.status === status).length;
      deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
      saveSlangStore();
      log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
      sendJson({ ok: true, removedCount });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) {
        sendJson({ ok: false, error: '请选择要确认的黑话' }, 400);
        return;
      }
      let confirmedCount = 0;
      let skippedCount = 0;
      const skipped = [];
      for (const id of ids) {
        const idx = deps.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) {
          skippedCount++;
          skipped.push({ id, reason: '不存在' });
          continue;
        }
        const entry = deps.slangEntries[idx];
        if (entry.status !== SLANG_STATUS.CANDIDATE) {
          skippedCount++;
          skipped.push({ id, content: entry.content, reason: '不是候选' });
          continue;
        }
        if (!entry.meaning || !String(entry.meaning).trim()) {
          skippedCount++;
          skipped.push({ id, content: entry.content, reason: '缺少含义' });
          continue;
        }
        entry.status = SLANG_STATUS.CONFIRMED;
        entry.updatedAt = new Date().toISOString();
        confirmedCount++;
      }
      if (confirmedCount) saveSlangStore();
      log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
      sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) {
        sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400);
        return;
      }
      let rejectedCount = 0;
      for (const id of ids) {
        const idx = deps.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) continue;
        const entry = deps.slangEntries[idx];
        if (entry.status === SLANG_STATUS.REJECTED) continue;
        entry.status = SLANG_STATUS.REJECTED;
        entry.updatedAt = new Date().toISOString();
        rejectedCount++;
      }
      if (rejectedCount) saveSlangStore();
      log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
      sendJson({ ok: true, rejectedCount });
      return;
    }
    const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
    if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) {
        sendJson({ ok: false, error: '黑话不存在' }, 404);
        return;
      }
      const body = await readBody();
      const entry = { ...deps.slangEntries[idx] };
      if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
      if (body.content !== undefined && deps.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
        sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
        return;
      }
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined)
        entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
      if (
        body.status !== undefined &&
        [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)
      )
        entry.status = body.status;
      if (!entry.content) {
        sendJson({ ok: false, error: '黑话内容不能为空' }, 400);
        return;
      }
      entry.updatedAt = new Date().toISOString();
      deps.slangEntries[idx] = entry;
      saveSlangStore();
      log(`控制台：更新黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return;
    }
    if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) {
        sendJson({ ok: false, error: '黑话不存在' }, 404);
        return;
      }
      const body = await readBody();
      const entry = deps.slangEntries[idx];
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined)
        entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
      if (!entry.meaning) {
        sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
        return;
      }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      saveSlangStore();
      log(`控制台：确认黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return;
    }
    if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) {
        sendJson({ ok: false, error: '黑话不存在' }, 404);
        return;
      }
      const entry = deps.slangEntries[idx];
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      saveSlangStore();
      log(`控制台：拒绝黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return;
    }
    if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) {
        sendJson({ ok: false, error: '黑话不存在' }, 404);
        return;
      }
      const [removed] = deps.slangEntries.splice(idx, 1);
      saveSlangStore();
      log(`控制台：删除黑话「${removed.content}」`);
      sendJson({ ok: true, removed });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
      if (cfg.slang?.enabled === false) {
        sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (key && slangWindows.has(key)) {
        queueSlangTask(() => runSlangExtraction(key));
        sendJson({ ok: true, key });
      } else {
        const firstKey = slangWindows.keys().next().value;
        if (!firstKey) {
          sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400);
          return;
        }
        queueSlangTask(() => runSlangExtraction(firstKey));
        sendJson({ ok: true, key: firstKey });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/research') {
      if (cfg.slang?.enabled === false) {
        sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400);
        return;
      }
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const force = body.force === true;
      const isCandidate = (e) => e && e.status === SLANG_STATUS.CANDIDATE;
      // 指定 ids = 明确要研究这几个（允许重研）；不指定 = 「研究全部候选」，
      // 这时**跳过已经研究到当前次数、且没有新证据的**，否则点一次就把几十条
      // 已经研究过的（多半是「研究过但无定论」）重新烧一遍 token。
      const needResearch = (e) => force || (Number(e.count) || 0) > (Number(e.lastInferenceCount) || 0);
      const candidates = ids.length
        ? deps.slangEntries.filter((e) => ids.includes(e.id) && isCandidate(e))
        : deps.slangEntries.filter((e) => isCandidate(e) && needResearch(e));
      if (!candidates.length) {
        const pending = deps.slangEntries.filter((e) => isCandidate(e) && !needResearch(e)).length;
        sendJson(
          {
            ok: false,
            error: pending
              ? `没有需要研究的候选：剩下 ${pending} 条都已经研究过了（结论多为「拿不准/不是梗」）。想强制重研请点「强制重研全部候选」，或指定具体词条。`
              : '没有可研究的候选黑话',
          },
          400,
        );
        return;
      }
      queueSlangTask(() => runSlangResearch(candidates));
      sendJson({ ok: true, count: candidates.length });
      return;
    }
    // ── 本地向量检索（RAG）：状态 / 重建 / 检索调试 / 近义聚类 ──────────
    if (req.method === 'GET' && url.pathname === '/api/slang/rag-status') {
      const probe = ragReady() ? await embedder.probe(2000) : null;
      sendJson({ ok: true, ...ragStatus(), probe });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/rag-rebuild') {
      if (!ragEnabled()) {
        sendJson({ ok: false, error: 'RAG 未启用（config.rag.enabled=false）' }, 400);
        return;
      }
      const body = await readBody();
      try {
        const res = await rebuildRagIndex({ force: body.force === true });
        log(`控制台：向量索引重建完成（${res.embedded} 条，${res.ms}ms）`);
        sendJson({ ok: true, ...res, status: ragStatus() });
      } catch (error) {
        sendJson({ ok: false, error: `重建失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 检索调试：同一个查询，并排给出「旧的按频次」和「新的向量」各自会注入什么。
    // 这是判断 RAG 有没有用的唯一手段，也是调 minCosine/topK 的依据。
    if (req.method === 'POST' && url.pathname === '/api/slang/debug-search') {
      const body = await readBody();
      const query = String(body.query ?? '').trim();
      const key = String(body.key ?? '').trim();
      const max = Math.max(1, Math.min(30, Number(body.max) || Number(cfg.slang?.injectMax) || 8));
      if (!query) {
        sendJson({ ok: false, error: 'query 不能为空' }, 400);
        return;
      }
      const confirmed = deps.slangEntries.filter(
        (e) => e.status === SLANG_STATUS.CONFIRMED && e.content && String(e.meaning || '').trim(),
      );
      const baseline = confirmed
        .slice()
        .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
        .slice(0, max)
        .map((e) => ({ id: e.id, content: e.content }));
      let vector = null;
      let error = '';
      if (ragEnabled()) {
        try {
          const [qv] = await embedder.embed([query.slice(0, 1000)]);
          const ranked = scoreEntries({
            queryVec: qv,
            entries: confirmed,
            store: deps.vectorStore,
            key,
            minCosine: Number(cfg.rag?.minCosine ?? 0.5),
            weights: cfg.rag?.weights,
          });
          const { picked } = selectForInjection({
            queryVec: qv,
            entries: confirmed,
            store: deps.vectorStore,
            key,
            max,
            minFill: Number(cfg.rag?.minFill ?? 3),
            minCosine: Number(cfg.rag?.minCosine ?? 0.5),
            weights: cfg.rag?.weights,
          });
          const pickedIds = new Set(picked.map((p) => p.entry.id));
          vector = {
            picked: picked.map((p) => ({
              id: p.entry.id,
              content: p.entry.content,
              meaning: String(p.entry.meaning || '').slice(0, 120),
              score: +p.score.toFixed(4),
              sem: +p.sem.toFixed(4),
              conv: p.conv,
              filler: !!p.filler,
              inThisConv: !!p.inThisConv,
            })),
            // 候选里没被选中的前几条，方便看「差在哪」
            runnersUp: ranked
              .filter((r) => !pickedIds.has(r.entry.id))
              .slice(0, 5)
              .map((r) => ({
                id: r.entry.id,
                content: r.entry.content,
                score: +r.score.toFixed(4),
                sem: +r.sem.toFixed(4),
                conv: r.conv,
              })),
            eligible: ranked.length,
            minCosine: Number(cfg.rag?.minCosine ?? 0.5),
            block: formatSlangTable(picked.map((p) => p.entry)),
          };
        } catch (e) {
          error = String(e?.message ?? e);
        }
      }
      sendJson({
        ok: true,
        query,
        key,
        max,
        baseline,
        baselineBlock: buildSlangContext(confirmed, max),
        vector,
        error: error || undefined,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/slang/near-duplicates') {
      const threshold = Math.max(0.3, Number(url.searchParams.get('threshold')) || 0.62);
      const confirmed = deps.slangEntries.filter(
        (e) => e.status === SLANG_STATUS.CONFIRMED && e.content && String(e.meaning || '').trim(),
      );
      sendJson({
        ok: true,
        threshold,
        pairs: nearDuplicates({ entries: confirmed, store: deps.vectorStore, threshold, limit: 60 }),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/slang/config') {
      const body = await readBody();
      const oldPreset = cfg.slang?.learnerPreset;
      const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const merged = { ...(file.slang ?? {}), ...body };
      if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
      else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.extractMinMessages !== undefined)
        merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
      if (merged.extractCooldownMs !== undefined)
        merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
      if (merged.injectMax !== undefined)
        merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
      if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
      // explore：主题探索（种子关键词 → 联网把这一圈的梗与关联主题学回来）
      if (body.explore && typeof body.explore === 'object') {
        const curExplore = readJsonSafe(configFile, null, true)?.slang?.explore ?? {};
        merged.explore = { ...curExplore, ...body.explore };
        if (merged.explore.enabled !== undefined) merged.explore.enabled = merged.explore.enabled !== false;
        for (const k of ['maxDepth', 'maxTopics', 'maxJobsPerHour', 'maxConcurrent', 'turnTimeoutMs']) {
          if (merged.explore[k] !== undefined) {
            const n = Number(merged.explore[k]);
            merged.explore[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : Number(curExplore[k]) || 0;
          }
        }
      }
      if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
      if (merged.workspaceTitle !== undefined)
        merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
      if (body.inferenceThresholds !== undefined) {
        const raw = Array.isArray(body.inferenceThresholds)
          ? body.inferenceThresholds
          : String(body.inferenceThresholds).split(/[,，\s]+/);
        merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort(
          (a, b) => a - b,
        );
        if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
      }
      file.slang = merged;
      atomicWriteJson(configFile, file);
      cfg.slang = { ...cfg.slang, ...merged };
      if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
        invalidateSlangLearnerSession();
        log('黑话学习 preset 已变更，已重置学习会话');
      } else if (
        body.workspaceTitle !== undefined &&
        String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')
      ) {
        invalidateSlangLearnerSession();
        log('黑话学习工作区名已变更，已重置学习会话');
      }
      log('控制台：黑话系统配置已更新');
      sendJson({ ok: true, config: cfg.slang });
      return;
    }
  }
  async function handleKnowledgeRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/knowledge') {
      const status = String(url.searchParams.get('status') ?? '').trim();
      const kind = String(url.searchParams.get('kind') ?? '').trim();
      let list = status ? deps.knowledgeEntries.filter((e) => e.status === status) : deps.knowledgeEntries;
      if (kind) list = list.filter((e) => e.kind === kind);
      const confirmed = deps.knowledgeEntries.filter((e) => isActiveStatus(e.status) && e.question && e.answer);
      const { toEmbed, orphans } = planRebuild(confirmed.map(asIndexEntry), deps.knowledgeVectorStore);
      sendJson({
        entries: list,
        config: cfg.knowledge,
        kinds: DEFAULT_KINDS,
        statuses: KNOWLEDGE_STATUSES,
        stats: {
          total: deps.knowledgeEntries.length,
          confirmed: confirmed.length,
          // 候选数是控制台最该显眼的数字：积压的待确认条目没人处理，知识库就慢慢停更
          candidates: deps.knowledgeEntries.filter((e) => e.status === KNOWLEDGE_STATUS.CANDIDATE).length,
          archived: deps.knowledgeEntries.filter((e) => e.status === KNOWLEDGE_STATUS.ARCHIVED).length,
          conflicts: listKnowledgeConflicts().length,
          repeats: confirmed.filter((e) =>
            shouldRemindRepeat(e, knowledgeRemindThreshold(), knowledgeRemindMinAskers()),
          ).length,
          totalHits: confirmed.reduce((sum, e) => sum + (Number(e.hitCount) || 0), 0),
        },
        conflicts: listKnowledgeConflicts(),
        rag: {
          enabled: knowledgeEnabled() && cfg.rag?.enabled !== false,
          ready: knowledgeReady(),
          model: VECTOR_MODEL,
          dim: deps.knowledgeVectorStore.dim,
          builtAt: deps.knowledgeVectorStore.builtAt,
          indexed: Object.keys(deps.knowledgeVectorStore.vectors || {}).length,
          stale: toEmbed.length,
          orphans: orphans.length,
          dirty: deps.knowledgeDirty,
          lastError: deps.knowledgeLastError,
        },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge') {
      const body = await readBody();
      const question = String(body.question ?? '').trim();
      const answer = String(body.answer ?? '').trim();
      if (!question) {
        sendJson({ ok: false, error: '问题不能为空' }, 400);
        return;
      }
      if (!answer) {
        sendJson({ ok: false, error: '答案不能为空' }, 400);
        return;
      }
      const kind = DEFAULT_KINDS.includes(String(body.kind ?? '')) ? String(body.kind) : KNOWLEDGE_KINDS.FACT;
      const entry = createKnowledgeEntry({
        question,
        answer,
        kind,
        tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [],
        aliases: Array.isArray(body.aliases) ? body.aliases.map(String).filter(Boolean) : [],
        sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
        status: KNOWLEDGE_STATUSES.includes(String(body.status)) ? String(body.status) : KNOWLEDGE_STATUS.CONFIRMED,
        source: 'manual',
      });
      deps.knowledgeEntries.push(entry);
      saveKnowledgeStore();
      markKnowledgeDirty(`控制台新增「${question.slice(0, 30)}」`);
      log(`控制台：新增知识「${question.slice(0, 40)}」`);
      sendJson({ ok: true, entry: publicKnowledgeEntry(entry) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge/update') {
      const body = await readBody();
      const id = String(body.id ?? '').trim();
      const entry = kbEntryById(id);
      if (!entry) {
        sendJson({ ok: false, error: '知识条目不存在' }, 404);
        return;
      }
      if (body.question !== undefined) {
        const q = String(body.question ?? '').trim();
        if (!q) {
          sendJson({ ok: false, error: '问题不能为空' }, 400);
          return;
        }
        entry.question = q.slice(0, QUESTION_MAX);
      }
      if (body.answer !== undefined) {
        const a = String(body.answer ?? '').trim();
        if (!a) {
          sendJson({ ok: false, error: '答案不能为空' }, 400);
          return;
        }
        entry.answer = a.slice(0, ANSWER_MAX);
      }
      if (body.kind !== undefined && DEFAULT_KINDS.includes(String(body.kind))) entry.kind = String(body.kind);
      const statusBefore = entry.status;
      if (body.status !== undefined && KNOWLEDGE_STATUSES.includes(String(body.status)))
        entry.status = String(body.status);
      // 数组字段是「整体替换」语义（控制台编辑框就是全量提交），不做合并
      if (body.tags !== undefined)
        entry.tags = [
          ...new Set([entry.kind, ...(Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [])]),
        ].slice(0, 8);
      if (body.aliases !== undefined)
        entry.aliases = (Array.isArray(body.aliases) ? body.aliases.map(String).filter(Boolean) : []).slice(0, 12);
      if (body.sources !== undefined)
        entry.sources = (
          Array.isArray(body.sources) ? body.sources.map(String).filter((s) => /^https?:\/\//i.test(s)) : []
        ).slice(-10);
      if (body.confidence !== undefined) entry.confidence = body.confidence === 'low' ? 'low' : 'normal';
      // 人工改过答案即视为已裁定：清掉待处理冲突标记。
      // 并且顺手把候选转正，控制台编辑一条候选项，意思就是「我确认过这条了」；
      // 不转正的话你得再点一次「启用」，而大多数人不会想到还要再点。
      if (body.resolveConflict === true || body.answer !== undefined) {
        entry.conflict = null;
        if (entry.status === KNOWLEDGE_STATUS.CANDIDATE && body.status === undefined)
          entry.status = KNOWLEDGE_STATUS.CONFIRMED;
      }
      // 手工把候选改成其他状态时，也当作已裁定
      if (statusBefore === KNOWLEDGE_STATUS.CANDIDATE && entry.status !== KNOWLEDGE_STATUS.CANDIDATE)
        entry.conflict = null;
      entry.tags = [...new Set([entry.kind, ...(entry.tags || [])])].slice(0, 8);
      entry.updatedAt = new Date().toISOString();
      saveKnowledgeStore();
      markKnowledgeDirty(`控制台修改「${entry.question.slice(0, 30)}」`);
      log(`控制台：修改知识「${entry.question.slice(0, 40)}」`);
      sendJson({ ok: true, entry: publicKnowledgeEntry(entry) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge/delete') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const id = String(body.id ?? '').trim();
      if (id) ids.push(id);
      if (!ids.length) {
        sendJson({ ok: false, error: '请提供要删除的 id 或 ids' }, 400);
        return;
      }
      const idSet = new Set(ids);
      const before = deps.knowledgeEntries.length;
      deps.knowledgeEntries = deps.knowledgeEntries.filter((e) => !idSet.has(e.id));
      const removedCount = before - deps.knowledgeEntries.length;
      if (!removedCount) {
        sendJson({ ok: false, error: '没有匹配到要删除的知识条目' }, 404);
        return;
      }
      saveKnowledgeStore();
      markKnowledgeDirty(`控制台删除 ${removedCount} 条`);
      log(`控制台：删除知识 ${removedCount} 条`);
      sendJson({ ok: true, removedCount });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge/rag-rebuild') {
      if (!(knowledgeEnabled() && cfg.rag?.enabled !== false)) {
        sendJson({ ok: false, error: 'RAG 未启用（config.rag.enabled=false）' }, 400);
        return;
      }
      const body = await readBody();
      try {
        const res = await rebuildKnowledgeIndex({ force: body.force === true });
        log(`控制台：知识库向量索引重建完成（${res.embedded} 条，${res.ms}ms）`);
        sendJson({ ok: true, ...res });
      } catch (error) {
        sendJson({ ok: false, error: `重建失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 检索调试：给定问题，看知识库会注入哪几条（判断去重与检索是否按预期工作）。
    if (req.method === 'POST' && url.pathname === '/api/knowledge/debug-search') {
      const body = await readBody();
      const query = String(body.query ?? '').trim();
      const key = String(body.key ?? '').trim();
      const max = Math.max(1, Math.min(30, Number(body.max) || Number(cfg.knowledge?.injectMax) || 6));
      if (!query) {
        sendJson({ ok: false, error: 'query 不能为空' }, 400);
        return;
      }
      const exact = findKnowledgeMatch(deps.knowledgeEntries, query, {
        similarityThreshold: Number(cfg.knowledge?.similarityThreshold) || 0.62,
      });
      let vector = null;
      if (knowledgeReady()) {
        try {
          const [qv] = await embedder.embed([query]);
          const pool = deps.knowledgeEntries.filter(
            (e) => isActiveStatus(e.status) && e.question && String(e.answer || '').trim(),
          );
          vector = scoreEntries({
            queryVec: qv,
            entries: pool.map(asIndexEntry),
            store: deps.knowledgeVectorStore,
            key,
            minCosine: Number(cfg.rag?.minCosine ?? 0.5),
          })
            .slice(0, max)
            .map((r) => {
              const full = kbEntryById(r.entry.id);
              return full ? { question: full.question, hitCount: full.hitCount, similarity: +r.sem.toFixed(3) } : null;
            })
            .filter(Boolean);
        } catch {
          vector = null;
        }
      }
      sendJson({
        ok: true,
        query,
        fingerprint: questionFingerprint(query),
        exact: exact ? { match: exact.match, sim: exact.sim ?? null, entry: publicKnowledgeEntry(exact.entry) } : null,
        vector,
        block: formatKnowledgeTable(
          (vector || []).map((v) => deps.knowledgeEntries.find((e) => e.question === v.question)).filter(Boolean),
          knowledgeOptions(),
        ),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge/config') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const merged = { ...(file.knowledge ?? {}), ...body };
      if (merged.enabled !== undefined) merged.enabled = merged.enabled === true || merged.enabled === 'true';
      if (merged.autoWrite !== undefined) merged.autoWrite = merged.autoWrite === true || merged.autoWrite === 'true';
      if (merged.injectMax !== undefined)
        merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 6)));
      if (merged.remindHitCount !== undefined)
        merged.remindHitCount = Math.max(1, Math.round(Number(merged.remindHitCount) || 3));
      if (merged.remindMinAskers !== undefined)
        merged.remindMinAskers = Math.max(1, Math.round(Number(merged.remindMinAskers) || 2));
      if (merged.similarityThreshold !== undefined)
        merged.similarityThreshold = Math.min(0.95, Math.max(0.3, Number(merged.similarityThreshold) || 0.62));
      if (merged.conflictMinCosine !== undefined)
        merged.conflictMinCosine = Math.min(0.99, Math.max(0.5, Number(merged.conflictMinCosine) || 0.8));
      file.knowledge = merged;
      atomicWriteJson(configFile, file);
      cfg.knowledge = { ...cfg.knowledge, ...merged };
      log('控制台：知识库配置已更新');
      sendJson({ ok: true, config: cfg.knowledge });
      return;
    }
  }
  async function handleSlangAiRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const q = String(url.searchParams.get('q') ?? '')
        .trim()
        .toLowerCase();
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) {
        sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403);
        return;
      }
      const list = confirmedSlangListV2(q ? 2000 : 60).filter((e) => {
        if (!q) return true;
        return (
          e.content.toLowerCase().includes(q) ||
          e.meaning.toLowerCase().includes(q) ||
          e.usage.toLowerCase().includes(q) ||
          e.example.toLowerCase().includes(q)
        );
      });
      const confirmedTotal = deps.slangEntries.filter(
        (e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning,
      ).length;
      // 字面过滤一无所获时用向量兜底：找语义相近的词（「猫」→「哈基米」这类），
      // 而不是直接告诉 AI「没这个词」。命中会标注 semantic:true，方便区分。
      let semantic = null;
      if (q && !list.length && ragEnabled()) {
        try {
          const pool = deps.slangEntries.filter(
            (e) => e.status === SLANG_STATUS.CONFIRMED && e.content && String(e.meaning || '').trim(),
          );
          const [qv] = await embedder.embed([q]);
          const gate = Number(cfg.rag?.linkMinCosine ?? 0.5);
          const hits = scoreEntries({ queryVec: qv, entries: pool, store: deps.vectorStore, key, minCosine: gate })
            .slice(0, 8)
            .map((r) => ({ ...publicSlangEntry(r.entry), similarity: +r.sem.toFixed(3), semantic: true }));
          if (hits.length) semantic = hits;
        } catch {
          /* 向量不可用就照旧返回空结果 */
        }
      }
      sendJson({
        ok: true,
        key,
        total: list.length + (semantic?.length ?? 0),
        confirmedTotal,
        semantic,
        entries: list,
        note: q
          ? list.length
            ? ''
            : `没有匹配「${q}」的已确认黑话；可以试试 qq_lookup_meme 联网现学。`
          : `共 ${confirmedTotal} 条已确认黑话，这里按出现次数给出前 ${list.length} 条；找具体的词请传 q 过滤。`,
        block: buildSlangContext(deps.slangEntries, cfg.slang?.injectMax ?? 8),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
      const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) {
        sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403);
        return;
      }
      if (cfg.slang?.enabled === false) {
        sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403);
        return;
      }
      if (!content) {
        sendJson({ ok: false, error: 'content 不能为空' }, 400);
        return;
      }
      if (content.length > 50) {
        sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400);
        return;
      }
      if (!allowSlangSubmit(key)) {
        sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429);
        return;
      }
      const existing = deps.slangEntries.find((e) => e.content === content);
      if (existing) {
        if (existing.status === SLANG_STATUS.CONFIRMED) {
          sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
          return;
        }
        if (existing.status === SLANG_STATUS.REJECTED) {
          sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
          return;
        }
        // candidate：累计出现次数并追加语境证据
        existing.count = (Number(existing.count) || 0) + 1;
        if (context) {
          existing.evidence = mergeEvidence(existing.evidence, [
            { key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() },
          ]);
        }
        existing.updatedAt = new Date().toISOString();
        saveSlangStore();
        if (cfg.slang?.autoResearch !== false) {
          const thresholds = Array.isArray(cfg.slang?.inferenceThresholds)
            ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean)
            : [2, 4, 8];
          if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
            queueSlangTask(() => runSlangResearch([existing]));
          }
        }
        log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
        sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
        return;
      }
      const entry = createSlangEntry({
        content,
        source: 'ai',
        status: SLANG_STATUS.CANDIDATE,
        evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : [],
      });
      deps.slangEntries.push(entry);
      saveSlangStore();
      if (cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch([entry]));
      }
      log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
      appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
      sendJson({ ok: true, entry: publicSlangEntry(entry) });
      return;
    }
  }
  async function handleKnowledgeAiRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/knowledge/query') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const q = String(url.searchParams.get('q') ?? '').trim();
      const kind = String(url.searchParams.get('kind') ?? '')
        .trim()
        .toLowerCase();
      const limitParam = Number(url.searchParams.get('limit'));
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && deps.currentMode !== 'reserved2') {
        sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('knowledge')) {
        sendJson({ ok: false, error: '工具未启用：qq_knowledge_query' }, 403);
        return;
      }
      const confirmedTotal = deps.knowledgeEntries.filter(
        (e) => isActiveStatus(e.status) && e.question && e.answer,
      ).length;
      const want =
        Number.isFinite(limitParam) && limitParam > 0 ? Math.min(2000, Math.floor(limitParam)) : q ? 2000 : 40;
      const lower = q.toLowerCase();
      let candidates = confirmedKnowledgeList(want);
      if (kind) candidates = candidates.filter((e) => e.kind === kind);
      // 字面匹配按「词元」而不是整串 includes：
      // 中文问句换个语序或插个字（「DeepSeek 是什么时候开源的」vs「deepseek 什么时候开源」）
      // 用整串 includes 永远匹配不上，而它俩显然是同一个问题。
      // 这里按标点/空白切词元，命中覆盖率过半才算相关，再按覆盖率排序。
      let list = candidates;
      let matched = 0;
      if (q) {
        const tokens = String(lower)
          .split(/[\s,，。？?！!、；;：:]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        const scored = [];
        for (const e of candidates) {
          const hay = [
            String(e.question || '').toLowerCase(),
            String(e.answer || '').toLowerCase(),
            (e.aliases || []).join(' ').toLowerCase(),
            (e.tags || []).join(' ').toLowerCase(),
          ].join('\n');
          let hits = 0;
          for (const t of tokens) if (hay.includes(t)) hits += 1;
          // 单字/整句 query 切不出词元时，退回整串 includes
          const coverage = tokens.length ? hits / tokens.length : hay.includes(lower) ? 1 : 0;
          const wholeHit = tokens.length !== 1 && hay.includes(lower) ? 0.5 : 0;
          if (coverage + wholeHit > 0) scored.push({ e, score: coverage + wholeHit });
        }
        scored.sort((a, b) => b.score - a.score);
        list = scored.map((s) => s.e);
        // 「命中」= 覆盖率过半：只有零星沾词的条目不算命中，
        // 否则会把一批只沾一个词的条目当答案返回，比「没找到」更危险。
        matched = scored.filter((s) => s.score >= 0.5).length;
      }
      // 字面没有一条够格时用向量兜底：找语义相近的问题（「ds啥时开源」→「DeepSeek 何时开源」）。
      // 判定条件是 matched，不是 list.length：list 只是「取到的候选」，
      // 用 list.length 判空会让「取到了候选但一条都不沾边」直接跳过兜底（这是修掉的真 bug）。
      let semantic = null;
      if (q && !matched && knowledgeReady()) {
        try {
          if (deps.knowledgeDirty && cfg.rag?.autoRebuild !== false) scheduleKnowledgeRebuild();
          const [qv] = await embedder.embed([q]);
          if (qv && qv.length) {
            const pool = deps.knowledgeEntries.filter(
              (e) => isActiveStatus(e.status) && e.question && String(e.answer || '').trim(),
            );
            const gate = Number(cfg.rag?.linkMinCosine ?? 0.5);
            semantic = scoreEntries({
              queryVec: qv,
              entries: pool.map(asIndexEntry),
              store: deps.knowledgeVectorStore,
              key,
              minCosine: gate,
            })
              .slice(0, 8)
              .map((r) => {
                const full = kbEntryById(r.entry.id);
                return full ? { ...publicKnowledgeEntry(full), similarity: +r.sem.toFixed(3), semantic: true } : null;
              })
              .filter(Boolean);
            if (!semantic.length) semantic = null;
          }
        } catch {
          /* 向量不可用就照旧返回空结果 */
        }
      }
      // 字面没沾边、但被向量捞回来的条目也要放进 entries，
      // 否则调用方只看 entries 会以为「没有」，而 total 又不是 0（自相矛盾）。
      if (q && !matched && semantic?.length) list = semantic;
      // 需要提醒 AI 的重复问题：达到阈值但本次没被查（AI 没主动问），也要让它知道。
      const repeats = list
        .map((e) => kbEntryById(e.id))
        .filter((e) => e && shouldRemindRepeat(e, knowledgeRemindThreshold(), knowledgeRemindMinAskers()))
        .map((e) => ({ id: e.id, question: e.question, hitCount: e.hitCount, askerCount: e.askers.length }));
      const total = list.length + (semantic?.length ?? 0);
      sendJson({
        ok: true,
        key,
        total,
        confirmedTotal,
        kind: kind || '',
        entries: list,
        semantic,
        repeats,
        conflicts: listKnowledgeConflicts().slice(0, 20),
        note: total
          ? ''
          : q
            ? `没有匹配「${q}」的已沉淀答案，说明这是个新问题；按你查到的结果正常回答，答完用 qq_knowledge_submit 存一条。`
            : `知识库现有 ${confirmedTotal} 条已确认答案。找具体问题请传 q。`,
        block: buildKnowledgeContext(deps.knowledgeEntries, cfg.knowledge?.injectMax ?? 6, knowledgeOptions()),
      });
      return;
    }
    // ── 群知识库：AI 沉淀答案（全自动写入，可人工删改） ──────────────────
    if (req.method === 'POST' && url.pathname === '/api/socialV2/knowledge/submit') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const question = String(body.question ?? '').trim();
      const answer = String(body.answer ?? '').trim();
      const asker = redactKnownTokensOnly(String(body.asker ?? '')).trim();
      const evidence = redactKnownTokensOnly(String(body.evidence ?? '')).trim();
      const conflictOf = String(body.conflictOf ?? '').trim();
      const kind = String(body.kind ?? '')
        .trim()
        .toLowerCase();
      const tags = Array.isArray(body.tags)
        ? body.tags
            .map((t) => String(t ?? '').trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const aliases = Array.isArray(body.aliases)
        ? body.aliases
            .map((a) => String(a ?? '').trim())
            .filter(Boolean)
            .slice(0, 12)
        : [];
      const sourcesRaw = Array.isArray(body.sources) ? body.sources : body.source ? [body.source] : [];
      // 只保留 http(s) 来源，避免把任意字符串当 URL 存进库里再注入
      const sources = sourcesRaw
        .map((s) => String(s ?? '').trim())
        .filter((s) => /^https?:\/\//i.test(s))
        .slice(-10);
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && deps.currentMode !== 'reserved2') {
        sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
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
      if (req.headers['x-agent-token'] && !v2ToolEnabled('knowledge')) {
        sendJson({ ok: false, error: '工具未启用：qq_knowledge_submit' }, 403);
        return;
      }
      if (!knowledgeEnabled()) {
        sendJson({ ok: false, error: '知识库已关闭（knowledge.enabled=false）' }, 403);
        return;
      }
      if (!question) {
        sendJson({ ok: false, error: 'question 不能为空' }, 400);
        return;
      }
      if (!answer) {
        sendJson({ ok: false, error: 'answer 不能为空' }, 400);
        return;
      }
      if (question.length > QUESTION_MAX) {
        sendJson({ ok: false, error: `question 过长（最多 ${QUESTION_MAX} 字）` }, 400);
        return;
      }
      if (answer.length > ANSWER_MAX) {
        sendJson({ ok: false, error: `answer 过长（最多 ${ANSWER_MAX} 字）` }, 400);
        return;
      }
      if (!allowKnowledgeSubmit(key)) {
        sendJson({ ok: false, error: '知识提交过于频繁，请稍后再试' }, 429);
        return;
      }
      const res = upsertKnowledge({ question, answer, kind, tags, aliases, sources, asker, key, evidence, conflictOf });
      if (!res.entry) {
        sendJson({ ok: false, error: '写入失败：问题或答案被清洗后为空' }, 400);
        return;
      }
      const pub = publicKnowledgeEntry(res.entry);
      const repeat = shouldRemindRepeat(res.entry, knowledgeRemindThreshold(), knowledgeRemindMinAskers());
      log(
        `[kb] ${res.created ? '新增' : '合并'}「${question.slice(0, 40)}」(${key})，累计 ${res.entry.hitCount} 次${res.conflict ? '（标记冲突待裁定）' : ''}`,
      );
      appendActivity(`${key} [kb] ${res.created ? '沉淀' : '更新'}答案：${question.slice(0, 60)}`);
      sendJson({
        ok: true,
        created: res.created,
        duplicate: !res.created,
        match: res.match,
        conflict: res.conflict,
        repeat,
        hitCount: res.entry.hitCount,
        askerCount: Array.isArray(res.entry.askers) ? res.entry.askers.length : 0,
        entry: pub,
        note: res.created
          ? '已沉淀入库，之后有人问同样的问题会直接命中这条答案。'
          : `已合并到已有条目（${res.match}），这条已被问过 ${res.entry.hitCount} 次。`,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (deps.currentMode === 'reserved2' && !agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
        return;
      }
      if (token && !agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      sendJson({ ok: true, key });
      return;
    }
  }

  return { handleSlangRoutes, handleKnowledgeRoutes, handleSlangAiRoutes, handleKnowledgeAiRoutes };
}
