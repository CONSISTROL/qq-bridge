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
