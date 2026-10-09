// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 图片来源白名单 image-allow 纯函数（AI 存聊天里的图被白名单拦掉的回归）
// 3) 配置项与 MCP 工具描述存在性
// 4) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  removeSticker,
  stickerNeedsRemark,
  markStickerUsed
} from '../src/sticker-lib.js';
import {
  DEFAULT_REFERER_ALLOW,
  DEFAULT_REFERER_HOSTS,
  hostInImageAllowList,
  hostNeedsImageReferer,
  isQqImageCdnHost,
  imageAllowRejectHint,
  normalizeImageLimits
} from '../src/image-allow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

// 本地备注（localRemark）：只给 AI 看的短名，跟 QQ 官方 desc 分开——
// 控制台「表情包」分区主要就是靠它把表情起个准名字给 AI 用。
console.log('## 本地备注 localRemark');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', desc: 'QQ备注', localRemark: '  捂耳朵猫  ' });
  ok(raw.localRemark === '捂耳朵猫', 'normalizeStickerEntry 保留并 trim 本地备注');
  ok(normalizeStickerEntry({ emoji_id: 'a2', localRemark: 'x'.repeat(80) }).localRemark.length === 40, '本地备注超长截断到 40');

  const synced = mergeStickerLibrary([raw], [{ emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: 'QQ备注改了' }]);
  ok(synced[0].localRemark === '捂耳朵猫', '同步 QQ 收藏不覆盖本地备注');
  ok(synced[0].desc === 'QQ备注改了', '同步会更新 QQ 备注');

  const noted = applyStickerNote(synced, 'a', { localRemark: '不想听' });
  ok(noted.entry.localRemark === '不想听', 'applyStickerNote 能写本地备注');
  const kept = applyStickerNote(noted.entries, 'a', { note: '只改笔记' });
  ok(kept.entry.localRemark === '不想听', '只改笔记时本地备注不被清空');

  const listed = formatStickerList(noted.entries, '不想听', 10);
  ok(listed.matched === 1 && listed.stickers[0].localRemark === '不想听', '本地备注可被搜索且随列表返回');
  const ctx = buildStickerContext(noted.entries, 8);
  ok(ctx.includes('不想听') && !ctx.includes('QQ备注改了'), 'AI 摘要优先用本地备注，而不是 QQ 备注');

  const removed = removeSticker(noted.entries, 'a');
  ok(removed.entry?.id === 'a' && removed.entries.length === 0, 'removeSticker 删掉本地条目并返回被删项');
  ok(removeSticker(noted.entries, '不存在').entry === null, 'removeSticker 找不到时不报错');
}

// 没备注的收藏表情要由 AI 自己看图补上：这里钉住「什么算没备注」「怎么捞出来」「提示里有没有催」。
console.log('## 没备注的表情（AI 自己补）');
{
  ok(stickerNeedsRemark({ id: 'a' }) === true, '三样都没有 = 需要补');
  ok(stickerNeedsRemark({ id: 'a', localRemark: '短名' }) === false, '有本地备注就不算');
  ok(stickerNeedsRemark({ id: 'a', desc: 'QQ备注' }) === false, '有 QQ 备注就不算');
  ok(stickerNeedsRemark({ id: 'a', localNote: '长笔记' }) === false, '有长笔记就不算');
  ok(stickerNeedsRemark({ id: 'a', localRemark: '   ' }) === true, '空白字符不算备注');
  ok(stickerNeedsRemark(null) === true, '空对象按需要补处理，不崩');

  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', desc: '有备注' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', localNote: '我记的' }),
    normalizeStickerEntry({ emoji_id: 'd', resId: 'd', url: 'https://x/d' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.unlabeled === 2, '总数里能报出还欠几条备注');
  ok(all.stickers.find((s) => s.id === 'b')?.needsRemark === true, '列表项带 needsRemark 标记');

  const only = formatStickerList(list, '', 10, { onlyUnlabeled: true });
  ok(only.onlyUnlabeled === true && only.matched === 2, 'onlyUnlabeled 只列没备注的');
  ok(only.stickers.every((s) => s.needsRemark), '返回的每一条都确实没备注');
  ok(only.total === 4, 'total 仍是整个库的数量（不是过滤后的）');

  // 提示里既要有常规清单，又要有「还欠 N 条、怎么补」的催办。
  // 写法是拿线上行为换来的：第一版只说「有空就补」，模型推理里直接写
  // 「could label later, not now … but it costs image tokens, let me skip」——于是这里
  // 逐条钉住那几个真能推动它的杠杆：具体 id、挂到闲置回合、明说成本可忽略。
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('有 2 个表情还没有任何备注'), '提示要报出欠账数量');
  ok(ctx.includes('onlyUnlabeled=true'), '要给出捞全部的方法');
  ok(ctx.includes('get_sticker_image') && ctx.includes('qq_sticker_note'), '要给出看图与写备注的工具');
  ok(ctx.includes('本次就补这 2 个') && ctx.includes('`b`') && ctx.includes('`d`'), '要直接给出具体 id，省掉一次清单调用（模型对具体文本敏感、对抽象指令不敏感）');
  ok(ctx.includes('群里没人等你') && ctx.includes('别拖到「以后」'), '要把动作挂到「闲置回合」上，否则「有空」永远不有空');
  ok(ctx.includes('成本') && ctx.includes('几百 token'), '要明说图片成本可忽略，否则它会替我们省 token 一直拖着');
  ok(ctx.includes('一轮最多补 2 个'), '要限制节奏，别刷成打标签');
  ok(ctx.includes('不要覆盖'), '已有备注不许覆盖');
  ok(ctx.includes('别照文件名'), '必须看图写，不许照哈希文件名猜');
  ok(ctx.includes('别把补备注的进度发到群里'), '补备注是内部动作，不许发到群里');

  // 控制台开关：关掉「AI 空闲时自己补备注」后，提示里连欠账都不提（已写的备注不受影响）
  ok(!buildStickerContext(list, 8, { autoLabel: false }).includes('还没有任何备注'), '关掉后不再催 AI 补备注');
  ok(buildStickerContext(list, 8).includes('还没有任何备注'), '默认（不传）按开启处理');
  // 一轮补几个可配（socialV2.sticker.autoLabelPerTurn，1~6）：提示里的具体 id 数量要跟着变，
  // 否则控制台调大/调小都没用——线上「每次只补两个」就是这么来的。
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((i) => normalizeStickerEntry({ emoji_id: i, resId: i, url: `https://x/${i}` }));
  const four = buildStickerContext(many, 8, { labelPerTurn: 4 });
  ok(four.includes('一轮最多补 4 个'), '提示里的「一轮最多」跟着配置走');
  ok(four.includes('本次就补这 4 个') && four.includes('`d`') && !four.includes('`e`'), '具体 id 只给 4 个');
  const one = buildStickerContext(many, 8, { labelPerTurn: 1 });
  ok(one.includes('一轮最多补 1 个') && one.includes('本次就补这个'), '调成 1 个时措辞要通顺（不是「这 1 个」）');
  ok(buildStickerContext(many, 8, { labelPerTurn: 99 }).includes('一轮最多补 6 个'), '上限压到 6，不能无限往上抬');
  ok(buildStickerContext(many, 8).includes('一轮最多补 2 个'), '默认 2 个');

  // 线上真事故：AI 先把两张图都看完、再一起写备注，结果把 A 的描述写到 B 上
  // （faker_憋笑 ↔ 柴郡猫猫_点赞 笔记互换）。提示里必须点明「看完一张立刻写掉」。
  ok(ctx.includes('一张一张来') && ctx.includes('立刻'), '要求看完一张立刻写掉，别攒着一起写');
  ok(ctx.includes('写到 B 上') && ctx.includes('互换'), '把「会写串」这件事说破并给真实例子，模型才当回事');

  const labeled = [normalizeStickerEntry({ emoji_id: 'z', resId: 'z', url: 'https://x/z', desc: '都有备注' })];
  ok(!buildStickerContext(labeled, 8).includes('还没有任何备注'), '全都有备注时不要多嘴');
}

console.log('## 配置文件');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  ok(tools.listStickers === true, 'config listStickers=true');
  ok(tools.getStickerImage === true, 'config getStickerImage=true');
  ok(tools.sendSticker === true, 'config sendSticker=true');
  ok(tools.stickerNote === true, 'config stickerNote=true');
  ok(tools.setStickerRemark === false, 'config setStickerRemark=false（默认禁用）');
  ok(cfg.socialV2?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');
}

console.log('## 图片来源白名单（image-allow 纯函数）');
{
  // 真实踩过的坑：AI 拿聊天消息里的 media.url（腾讯 CDN）去调 qq_save_sticker，
  // 被 refererAllow 拒掉，于是「存不了群友发的表情」。
  ok(hostInImageAllowList('multimedia.nt.qq.com.cn', DEFAULT_REFERER_ALLOW), '腾讯图片 CDN 默认在允许列表内');
  ok(hostInImageAllowList('i0.hdslb.com', DEFAULT_REFERER_ALLOW), 'B 站图床默认在允许列表内');
  ok(hostInImageAllowList('example.com', []) === true, '空白名单 = 不限制站点（旧语义保留）');
  ok(hostInImageAllowList('example.com', DEFAULT_REFERER_ALLOW) === false, '未列出的站点被拒');
  ok(hostInImageAllowList('i0.hdslb.com', ['i0.hdslb.com']) === true, '白名单条目允许只写域名');
  ok(hostInImageAllowList('evil-i0.hdslb.com', ['i0.hdslb.com']) === false, '白名单是精确 hostname 匹配');

  ok(hostNeedsImageReferer('i0.hdslb.com', DEFAULT_REFERER_HOSTS) === true, 'B 站图床要带 Referer');
  ok(hostNeedsImageReferer('multimedia.nt.qq.com.cn', DEFAULT_REFERER_HOSTS) === false, '腾讯 CDN 不带 Referer（带了会被判盗链）');
  ok(hostNeedsImageReferer('evil-hdslb.com', DEFAULT_REFERER_HOSTS) === false, 'Referer 后缀匹配不会被子域名伪装骗过');
  ok(hostNeedsImageReferer('x.hdslb.com', []) === true, 'refererHosts 为空时回落到默认表');

  ok(isQqImageCdnHost('multimedia.nt.qq.com.cn') === true && isQqImageCdnHost('gchat.qpic.cn') === true, '识别 QQ 图片 CDN');
  ok(isQqImageCdnHost('i0.hdslb.com') === false, 'B 站图床不算 QQ CDN');
  ok(/qq_collect_sticker/.test(imageAllowRejectHint('multimedia.nt.qq.com.cn')), '被拒时提示改用 qq_collect_sticker');
  ok(/refererAllow/.test(imageAllowRejectHint('example.com')), '非腾讯站点提示怎么加白名单');

  const limits = normalizeImageLimits({ maxBytes: 1024, allowRemoteUrl: true, refererAllow: ['x.com'] });
  ok(limits.maxBytes === 1024 && limits.allowRemoteUrl === true && limits.imageReferer === 'https://www.bilibili.com', 'normalizeImageLimits 归一化');
  ok(normalizeImageLimits({}).refererHosts.join(',') === DEFAULT_REFERER_HOSTS.join(','), 'refererHosts 缺省回落默认');
  const allowed = normalizeImageLimits({}).refererAllow;
  ok(allowed.length === 0, '配置没写 refererAllow 时保持旧语义（空=不限制），默认表只在 defaultConfig 里');
}

console.log('## 表情单气泡约束');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const sendStickerBlock = mcp.slice(mcp.indexOf("'qq_send_sticker'"), mcp.indexOf("'qq_sticker_note'"));
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark', 'qq_collect_sticker', 'qq_save_sticker']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
  // 模型最容易犯的错：拿聊天里的 media.url 去调 qq_save_sticker。描述必须把它推回 qq_collect_sticker。
  const collectBlock = mcp.slice(mcp.indexOf("'qq_collect_sticker'"), mcp.indexOf("'qq_save_sticker'"));
  ok(/首选工具/.test(collectBlock), 'qq_collect_sticker 描述标明是收藏聊天图的首选');
  const saveBlock = mcp.slice(mcp.indexOf("'qq_save_sticker'"), mcp.indexOf("'qq_send_image'"));
  ok(/qq_collect_sticker/.test(saveBlock), 'qq_save_sticker 描述把聊天图指向 qq_collect_sticker');
}

console.log('## bridge 路由/函数存在性');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const s of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/stickers', 'syncStickerLibrary', 'sendStickerV2']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
  ok(bridge.includes('imageAllowRejectHint'), 'bridge 的图片来源被拒时给出可执行提示');
  ok(bridge.includes('hostNeedsImageReferer'), 'bridge 按图床决定是否带 Referer');
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
