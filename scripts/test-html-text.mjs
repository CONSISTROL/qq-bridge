// HTML 正文抽取 / SPA 识别自检（纯离线）。
//
// 回归背景：`web_fetch` 原来只回原始 HTML，遇到前端渲染的分享页（小黑盒/小红书这类）
// 只给模型一坨 `<div id="app"></div>`，模型只能说「我点进去了但抓不到正文」然后卡住。
// 这里守住：正常页面能抽出正文、SPA 页面能被识别并给出可行建议、元信息/JSON-LD 能兜底。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractHtmlText,
  extractHtmlMeta,
  extractJsonLd,
  detectRenderHint,
  looksLikeHtml,
  looksLikeSpaShell,
  detectAccessHint,
  decodeEntities,
  MIN_USABLE_TEXT
} from '../src/html-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// 真实 SPA 空壳：2026-09 实测小黑盒分享页（去掉脚本后可见文本只有 11 字）
const SPA_SHELL = '<!doctype html><html lang="en"><head><title>小黑盒 - 玩家高能聚集地</title>'
  + '<script type="module" crossorigin src="https://static.example/app/index.js"></script>'
  + '<script>!function(){var a=1;window.x=a}();</script>'
  + '<link rel="stylesheet" href="https://static.example/app.css"></head>'
  + '<body><div id="app"></div><script nomodule src="https://static.example/legacy.js"></script></body></html>';

console.log('## 正常页面：抽正文');
{
  const html = `<!doctype html><html><head>
    <title>某篇文章标题</title>
    <meta name="description" content="这是页面描述&amp;带实体">
    <style>body{color:red}</style>
    <script>var tracking=1;</script>
    </head><body>
    <article><h1>真正的标题</h1><p>第一段正文。</p><p>第二段 &#8220;带引号&#8221; 的正文。</p>
    <ul><li>要点一</li><li>要点二</li></ul></article>
    <footer>版权所有</footer></body></html>`;
  const text = extractHtmlText(html);
  ok(text.includes('真正的标题') && text.includes('第一段正文') && text.includes('要点二'), '抽出正文', text.slice(0, 120));
  ok(!text.includes('var tracking'), '脚本内容被剥离');
  ok(!text.includes('color:red'), '样式内容被剥离');
  ok(text.includes('“带引号”'), 'HTML 实体被解开', text);
  ok(text.includes('\n'), '块级标签转成换行（不糊成一坨）');
  const meta = extractHtmlMeta(html);
  ok(meta.title === '某篇文章标题', '抽到 title', meta.title);
  ok(meta.description === '这是页面描述&带实体', '抽到 description 并解实体', meta.description);
  ok(detectRenderHint({ text, contentType: 'text/html', body: html, meta }) === '', '正常页面不产生 SPA 提示', detectRenderHint({ text, contentType: 'text/html', body: html, meta }));
  // 短文章 + 无前端渲染特征 → 不能误判成 SPA（宁可漏报也不误报）
  const shortPage = '<html><head><title>短公告</title></head><body><p>今天停服维护。</p></body></html>';
  ok(detectRenderHint({ text: extractHtmlText(shortPage), contentType: 'text/html', body: shortPage, meta: {} }) === '', '短静态文章不被误判为 SPA');
  ok(looksLikeSpaShell(SPA_SHELL) === true, '空挂载点 + 多 script → 判定为 SPA 空壳');
  ok(looksLikeSpaShell('<html><body><article>' + '正文'.repeat(100) + '</article></body></html>') === false, '正文充足时不判 SPA');
}

console.log('## SPA 空壳：识别 + 给出路');
{
  const text = extractHtmlText(SPA_SHELL);
  ok(text.replace(/\s/g, '').length < MIN_USABLE_TEXT, `空壳可见文本确实很少（${text.replace(/\s/g, '').length} 字）`, text);
  const hint = detectRenderHint({ text, contentType: 'text/html; charset=utf-8', body: SPA_SHELL, meta: extractHtmlMeta(SPA_SHELL) });
  ok(hint.includes('前端渲染'), '明确说是前端渲染', hint);
  ok(hint.includes('web_search'), '给出「搜标题」的替代路径');
  ok(hint.includes('截图') || hint.includes('复制'), '给出「请对方截图/复制」的替代路径');
  ok(hint.includes('不要反复重试'), '明确劝阻反复重试同一个 URL');
  ok(hint.includes('11 字') || /\d+ 字/.test(hint), '带上实际可见字数，便于判断');
}

console.log('## 元信息 / JSON-LD 兜底');
{
  const withMeta = SPA_SHELL.replace('<title>', '<meta property="og:description" content="og 摘要：这篇文章讲了什么"><title>');
  const meta = extractHtmlMeta(withMeta);
  ok(meta.description === 'og 摘要：这篇文章讲了什么', 'og:description 优先兜底', meta.description);
  const hint = detectRenderHint({ text: extractHtmlText(withMeta), contentType: 'text/html', body: withMeta, meta });
  ok(hint.includes('页面 meta 描述'), 'SPA 提示里带上 meta 线索', hint);

  const ld = '<script type="application/ld+json">{"@type":"NewsArticle","headline":"结构化标题","description":"结构化摘要","articleBody":"' + '正文内容'.repeat(20) + '"}</script>';
  const jsonLd = extractJsonLd(SPA_SHELL.replace('</head>', ld + '</head>'));
  ok(jsonLd.includes('结构化标题') && jsonLd.includes('结构化摘要') && jsonLd.includes('正文内容'), 'JSON-LD 抽出标题/摘要/正文', jsonLd.slice(0, 80));
  const hint2 = detectRenderHint({ text: extractHtmlText(SPA_SHELL), contentType: 'text/html', body: SPA_SHELL, meta: {}, jsonLd });
  ok(hint2.includes('JSON-LD'), 'SPA 提示里带上 JSON-LD 线索');
  ok(extractJsonLd('<script type="application/ld+json">{坏 json</script>') === '', '坏 JSON-LD 不抛错');
}

console.log('## 边界与判定');
{
  ok(decodeEntities('&lt;a&gt; &amp; &#65; &#x42; &nbsp;') === '<a> & A B  ', 'decodeEntities 处理命名/十进制/十六进制');
  ok(extractHtmlText('').length === 0 && extractHtmlText(null).length === 0, '空输入不抛错');
  ok(extractHtmlMeta('').title === '', '空输入 meta 为空');
  ok(looksLikeHtml('application/json', '{"a":1}') === false, 'JSON 不算 HTML');
  ok(looksLikeHtml('text/html', '') === true, 'content-type 为准');
  ok(looksLikeHtml('', '<!DOCTYPE html><html>') === true, '无 content-type 时看内容特征');
  const long = extractHtmlText('<p>' + 'x'.repeat(50000) + '</p>', { max: 100 });
  ok(long.length <= 101 && long.endsWith('…'), '超长文本按 max 截断并带省略号');
  ok(detectRenderHint({ text: 'x'.repeat(MIN_USABLE_TEXT), contentType: 'text/html', body: '<html>' }) === '', `刚好达到 ${MIN_USABLE_TEXT} 字不算空壳`);
  ok(detectRenderHint({ text: '', contentType: 'application/json', body: '{}' }) === '', '非 HTML 不做 SPA 判定');
}

console.log('## 反爬 / 安全验证页识别');
{
  // 真实样本：贴吧对无登录态的本机 IP 返回 403 + 百度安全验证滑块页
  const tiebaBlock = '<!DOCTYPE html><html><head><title>百度安全验证</title></head>'
    + '<body>百度安全验证 请完成下方验证后继续操作 正在验证... 请向右滑动完成拼图</body></html>';
  const tiebaText = extractHtmlText(tiebaBlock);
  const hint = detectAccessHint({ statusCode: 403, text: tiebaText, body: tiebaBlock, url: 'https://tieba.baidu.com/f?kw=%E5%8E%9F%E7%A5%9E' });
  ok(hint.includes('反爬') || hint.includes('安全验证'), '识别出反爬验证页', hint.slice(0, 60));
  ok(hint.includes('web_render'), '明确说明换 web_render 也没用（别再浪费一次渲染）');
  ok(hint.includes('hottopic/browse/topicList'), '贴吧场景给出**可直接抓**的热议榜入口');
  ok(hint.includes('hottopic?topic_id='), '给出可直接抓的**话题详情**入口（热榜话题下的帖子正文）');
  ok(hint.includes('BDUSS'), '说明具体吧需要登录 cookie');
  ok(!/疑似\*\*前端渲染/.test(hint), '反爬提示不会被误判成 SPA 提示');

  // Cloudflare 风格
  const cf = '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>';
  ok(detectAccessHint({ statusCode: 503, text: extractHtmlText(cf), body: cf, url: 'https://example.com/' }).includes('反爬'), '识别 Cloudflare 拦截页');
  // 非贴吧站点不给贴吧 URL
  const other = detectAccessHint({ statusCode: 403, text: '安全验证', body: '<html>安全验证请完成下方验证</html>', url: 'https://foo.example/' });
  ok(other && !other.includes('hottopic'), '非百度站点不塞贴吧入口', other?.slice(0, 50));
  // 正常页面不误报
  const normal = '<html><body><article>' + '正常正文'.repeat(60) + '</article></body></html>';
  ok(detectAccessHint({ statusCode: 200, text: extractHtmlText(normal), body: normal, url: 'https://example.com/' }) === '', '正常页面不产生反爬提示');
  ok(detectAccessHint({ statusCode: 200, text: '', body: '', url: 'https://example.com/' }) === '', '空响应不误报');
}

console.log('## web_fetch 接线');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  ok(src.includes('extractHtmlText(html)'), 'web_fetch 返回 text（已剥离标签）');
  ok(src.includes('extractHtmlMeta(html)'), 'web_fetch 返回 meta');
  ok(src.includes('detectRenderHint('), 'web_fetch 返回 renderHint');
  ok(/renderHint/.test(src.slice(src.indexOf("'web_fetch'"), src.indexOf("'web_fetch'") + 900)), '工具描述里说明了 renderHint 怎么用');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
