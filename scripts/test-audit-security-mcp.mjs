// Exercise MCP callbacks with a fake transport: no network, config or stdio server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';
import * as htmlText from '../src/html-text.js';
import * as browserRender from '../src/browser-render.js';

// mcp-web-search-safe.js 会被剥掉 import 后丢进 vm 跑，所以它依赖的模块函数
// 必须在这里显式注入（和 bridge 审计装置同一套做法）。overrides 用于替换
// 无头浏览器这类会真起进程的能力。
function loadWebTools(safeFetch, overrides = {}) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    safeFetch, McpServer, StdioServerTransport: class {}, z, URL,
    ...htmlText, ...browserRender, ...overrides,
  });
  return async (name, arguments_) => {
    const tool = tools.get(name);
    assert.ok(tool, `工具 ${name} 未注册`);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

test('MCP search uses bounded shared safeFetch after query sanitization', async () => {
  const calls = [];
  const callTool = loadWebTools(async (url, maxChars) => {
    calls.push({ url, maxChars });
    return { statusCode: 200, body: '<li class="b_algo"><h2><a href="https://example.com/">Fixture title</a></h2><p>Fixture summary</p></li>' };
  });
  const result = await callTool('web_search', { query: '  fixture [CQ:at,qq=1]\n phrase  ' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.query, 'fixture phrase');
  assert.equal(parsed.results[0].title, 'Fixture title');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'fixture phrase');
  assert.equal(calls[0].maxChars, 512000);
});

test('MCP fetch extracts readable text and flags SPA shells', async () => {
  const page = '<!doctype html><html><head><title>正常页面</title><meta name="description" content="描述"></head>'
    + '<body><article><h1>标题</h1><p>正文段落。</p></article><script>var x=1;</script></body></html>';
  const callTool = loadWebTools(async () => ({ statusCode: 200, body: page, url: 'https://example.com/', truncated: false }));
  const parsed = JSON.parse((await callTool('web_fetch', { url: 'https://example.com/' })).content[0].text);
  assert.match(parsed.text, /正文段落/);
  assert.doesNotMatch(parsed.text, /var x=1/, '脚本不应出现在正文里');
  assert.equal(parsed.meta.title, '正常页面');
  assert.equal(parsed.renderHint, undefined, '正常页面不该有 renderHint');

  // SPA 空壳：应给出 renderHint，并在无头浏览器可用时首推 web_render
  const shell = '<!doctype html><html><head><title>壳</title></head><body><div id="app"></div>'
    + '<script src="/a.js"></script><script src="/b.js"></script></body></html>';
  const callTool2 = loadWebTools(async () => ({ statusCode: 200, body: shell, url: 'https://spa.example/', truncated: false }), {
    browserAvailable: async () => true,
  });
  const shellParsed = JSON.parse((await callTool2('web_fetch', { url: 'https://spa.example/' })).content[0].text);
  assert.match(shellParsed.renderHint, /前端渲染/);
  assert.match(shellParsed.renderHint, /web_render/, '无头浏览器可用时应首推 web_render');
});

test('web_render is registered and reports a clear error when the browser is missing', async () => {
  const callTool = loadWebTools(async () => ({ statusCode: 200, body: '', url: '', truncated: false }), {
    browserAvailable: async () => false,
    renderPage: async () => { throw new Error('should not be called'); },
  });
  const result = await callTool('web_render', { url: 'https://example.com/' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /无头浏览器不可用/);
});

test('MCP fetch uses shared transport and exposes rejection as a tool error', async () => {
  const callTool = loadWebTools(async () => { throw new Error('fixture: internal redirect rejected'); });
  for (const [name, args] of [['web_fetch', { url: 'http://example.com' }], ['web_search', { query: 'fixture' }]]) {
    const result = await callTool(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /internal redirect rejected/);
  }
});

test('empty searches are rejected without calling the transport', async () => {
  const callTool = loadWebTools(async () => { assert.fail('Unexpected transport call'); });
  const result = await callTool('web_search', { query: '[CQ:at,qq=1]\n ' });
  assert.equal(result.isError, true);
});
