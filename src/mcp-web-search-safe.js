// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
import { extractHtmlText, extractHtmlMeta, extractJsonLd, detectRenderHint, detectAccessHint, looksLikeHtml } from './html-text.js';
import { browserAvailable, renderPage } from './browser-render.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bing 对「裸 Mozilla/5.0」会返回没有自然结果的降级页（实测：0 个 <li class="b_algo">，
// 而完整 Chrome UA 能拿到 10 个）。所以这里必须给完整 UA，否则搜索会静默返回空结果。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function bingSearch(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000, { headers: { 'user-agent': BROWSER_UA } });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.5' });

server.tool(
  'web_search',
  '只读联网搜索，返回 Bing 搜索结果（标题/URL/摘要）。用途不限：查网络用语/梗的含义，也用来查你训练数据里没有的**实时事实**——赛事比分、战队/选手近况、版本更新、新闻、价格、谁是某某等。搜到结果后如果需要正文细节，再用 web_fetch / web_render 打开具体链接。仅只读，不执行任何本地操作。',
  { query: z.string().describe('搜索词。可以是想确认含义的梗/黑话，也可以是实时事实（如「BLG HLE 比赛结果」）') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

// 无头浏览器是否可用：**惰性**探测。
// 刻意不在模块顶层 await —— 审计装置会用 vm.runInNewContext 直接加载本文件，
// 顶层 await 在那里是语法错误；而且探测结果只影响「renderHint 里怎么建议」与
// web_render 的报错文案，没必要挡在注册流程前面。
let renderReadyCache = null;
async function renderToolAvailable() {
  if (renderReadyCache === null) {
    try {
      renderReadyCache = typeof browserAvailable === 'function' ? await browserAvailable() : false;
    } catch {
      renderReadyCache = false;
    }
  }
  return renderReadyCache;
}

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。'
    + '返回里 `text` 是已剥离脚本/标签的可读正文（优先读它），`meta` 是页面标题/描述，`body` 是原始响应。'
    + '若返回 `renderHint`，说明该页是前端渲染（SPA）或正文为空，纯 HTTP 拿不到内容——'
    + '别反复重试同一个 URL，按 renderHint 里的建议换路子（web_render / 搜标题 / 请对方复制文字）。'
    + '若返回 `accessHint`，说明被目标站点的**反爬/安全验证**拦了（例如贴吧按 IP 风控）：'
    + '这种情况换 web_render 也没用（滑块验证过不了），按 accessHint 里给的可用入口走。'
    + '贴吧实测：热榜 `https://tieba.baidu.com/hottopic/browse/topicList?res_type=1` 与话题详情 '
    + '`https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=<id>` 都能直接抓（含帖子正文）；'
    + '但 `/f?kw=`（吧列表）、`/p/`（帖子详情）、吧内搜索被 IP 风控拦死，需要贴吧登录 cookie。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      const html = String(result.body ?? '');
      const isHtml = looksLikeHtml('', html);
      // 非 HTML（JSON/纯文本）本身就是可读内容，不做剥离
      const text = isHtml ? extractHtmlText(html) : html.slice(0, 12000);
      const meta = isHtml ? extractHtmlMeta(html) : {};
      const jsonLd = isHtml ? extractJsonLd(html) : '';
      // 反爬/验证页优先判定：这类页面文本很少，会被误当成 SPA，得先说是被拦了
      const accessHint = detectAccessHint({ statusCode: result.statusCode, text, body: html, url: result.url });
      const renderHint = accessHint
        ? ''
        : detectRenderHint({ text, contentType: '', body: html, meta, jsonLd, renderToolAvailable: await renderToolAvailable() });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated,
            text,
            meta,
            ...(jsonLd ? { jsonLd } : {}),
            ...(accessHint ? { accessHint } : {}),
            ...(renderHint ? { renderHint } : {}),
            body: result.body,
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

{
  server.tool(
    'web_render',
    '用**无头浏览器**真正渲染页面后再取正文（只读，禁用图片/字体/媒体，不执行任何本地操作）。'
      + '当前端渲染（SPA）页面用 web_fetch 拿不到正文时用它：web_fetch 返回的 `renderHint` 会明确提示。'
      + '代价：慢（通常 3~10 秒）且吃内存，因此**同一时刻只渲染一个页面**、空闲 60 秒自动关闭浏览器；'
      + '只有在确实需要时才调用，别拿它当默认抓取工具。返回 `text`（渲染后的正文）、`meta`、`jsonLd`。'
      + '页面里 JS 发起的请求全部经过本地过滤代理，碰不到内网/本机地址。',
    {
      url: z.string().describe('要渲染的 http(s) URL'),
      settleMs: z.number().optional().describe('网络静默后额外等待毫秒数，默认 1200；内容加载慢的站点可加大'),
    },
    async ({ url, settleMs }) => {
      try {
        if (!(await renderToolAvailable())) {
          return {
            content: [{ type: 'text', text: '无头浏览器不可用：未安装 puppeteer / Chromium。请在 qq-bridge 目录执行 `npm install`（puppeteer 在 optionalDependencies，含约 150MB Chromium），或改用 web_search / 请对方截图。' }],
            isError: true,
          };
        }
        const result = await renderPage(url, { settleMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `渲染失败：${error?.message ?? error}` }],
          isError: true,
        };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
