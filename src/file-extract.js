// 聊天里发来的**文件**（PDF / 文本）怎么变成 AI 能读的内容。
//
// 为什么需要这层：QQ 的 file 段只给文件名/大小/下载链接，模型看不了字节。现实需求是
// 「群里发了个 PDF 并问『这里面讲了什么』」——之前桥接只把它渲染成 `[文件 xxx.pdf]`，
// AI 什么也读不到（线上真实消息：6.5MB 的《高性价比人生指南》）。
//
// 取舍：用系统里的 poppler（pdftotext / pdftoppm）而不是纯 JS 库。
//   · pdftotext -layout 抽文字质量高、还保留排版，CJK 也正常；
//   · 扫描件抽不出文字时用 pdftoppm 渲染成图片，交给视觉模型看（这是兜底，也是关键）；
//   · 纯 JS 方案（pdfjs）抽文字尚可，但渲染页面要 canvas（原生依赖），扫描件就没辙。
// exec 做成可注入的，测试里用假实现跑确定性用例，线上默认真调 poppler。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExec = promisify(execFile);

/** 按扩展名/MIME 归类。只为「怎么处理」服务，不追求完备。 */
export function classifyFile(name = '', mimeType = '') {
  const n = String(name ?? '').toLowerCase();
  const m = String(mimeType ?? '').toLowerCase();
  if (m.includes('pdf') || n.endsWith('.pdf')) return 'pdf';
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(n)) return 'image';
  if (m.startsWith('text/') || /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|ini|conf|cfg|xml|html?|srt|vtt)$/.test(n)) return 'text';
  return 'other';
}

/** pdfinfo：页数与文档属性（标题/作者/生成器）。解析失败不抛，返回空信息。 */
// poppler-utils 没装时 spawn 会抛 ENOENT，原始信息是 `spawn pdftotext ENOENT`——
// 对排查毫无帮助（线上真事：bot 回「pdf 打不开」，日志就这一行）。这里统一翻译成可执行的提示。
const PDF_DEPS_HINT = '本机缺少 poppler-utils（pdftotext/pdfinfo），PDF 读不了。安装：apt-get install -y poppler-utils';
function explainPdfError(error, tool = 'pdftotext') {
  const msg = String(error?.message ?? error);
  if (error?.code === 'ENOENT' || /ENOENT/.test(msg)) return PDF_DEPS_HINT;
  return `${tool} 执行失败：${msg.slice(0, 300)}`;
}

export async function pdfInfo({ filePath, exec = defaultExec, timeoutMs = 20000 }) {
  try {
    const { stdout } = await exec('pdfinfo', [filePath], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    const out = String(stdout ?? '');
    const pages = Number((/^Pages:\s+(\d+)/m.exec(out) || [])[1] || 0);
    const info = {};
    for (const line of out.split('\n')) {
      const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
      if (m && m[2]) info[m[1].trim()] = m[2].trim();
    }
    return { ok: true, pages, info };
  } catch (error) {
    return { ok: false, pages: 0, info: {}, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * 抽 PDF 文字。`-layout` 保留排版（表格/分栏不至于糊成一团）。
 * @returns {{text:string, chars:number, truncated:boolean}}
 */
export async function extractPdfText({ filePath, exec = defaultExec, fromPage = 1, toPage = 0, maxChars = 20000, timeoutMs = 60000 }) {
  const args = ['-layout', '-enc', 'UTF-8', '-f', String(Math.max(1, fromPage))];
  if (toPage >= fromPage) args.push('-l', String(toPage));
  args.push(filePath, '-');
  let stdout;
  try {
    ({ stdout } = await exec('pdftotext', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(explainPdfError(error, 'pdftotext'));
  }
  const raw = String(stdout ?? '').replace(/\u0000/g, '');
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const truncated = maxChars > 0 && text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, chars: text.length, truncated };
}

/**
 * 把 PDF 页面渲染成 JPEG（扫描件的兜底：没有文字层时至少让视觉模型看到画面）。
 * @returns {Promise<Array<{page:number, buffer:Buffer, mimeType:string}>>}
 */
export async function renderPdfPages({ filePath, exec = defaultExec, tmpDir, fromPage = 1, toPage = 4, dpi = 110, timeoutMs = 120000 }) {
  const outDir = tmpDir || path.join(path.dirname(filePath), `pdf-pages-${process.pid}-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = path.join(outDir, 'page');
  await exec('pdftoppm', ['-jpeg', '-r', String(dpi), '-f', String(Math.max(1, fromPage)), '-l', String(Math.max(fromPage, toPage)), filePath, prefix], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  });
  const files = (await fs.promises.readdir(outDir))
    .filter((f) => /^page-?\d*\.jpe?g$/i.test(f))
    .sort((a, b) => (Number(/(\d+)/.exec(a)?.[1] || 0)) - (Number(/(\d+)/.exec(b)?.[1] || 0)));
  const images = [];
  for (const f of files) {
    const buf = await fs.promises.readFile(path.join(outDir, f));
    if (!buf.length) continue;
    images.push({ page: Number(/(\d+)/.exec(f)?.[1] || images.length + 1), buffer: buf, mimeType: 'image/jpeg' });
  }
  return images;
}

/** 文本文件：按 UTF-8 读，带二进制嗅探（含 NUL 或大量替换字符就判定不可读）。 */
export async function readTextFile({ filePath, maxChars = 20000 }) {
  const buf = await fs.promises.readFile(filePath);
  const sample = buf.subarray(0, 4096);
  const binary = sample.includes(0) || sample.toString('utf8').includes('\uFFFD');
  if (binary) return { text: '', chars: 0, truncated: false, binary: true };
  const raw = buf.toString('utf8').replace(/\r\n?/g, '\n');
  // maxChars=0 ＝ 不限（同 PDF 分支；owner 要求不要字数限制）
  const truncated = maxChars > 0 && raw.length > maxChars;
  return { text: truncated ? raw.slice(0, maxChars) : raw, chars: raw.length, truncated, binary: false };
}

/**
 * 统一入口：把一个本地文件变成「给 AI 的内容」。
 * @returns {Promise<{kind:string, text?:string, truncated?:boolean, pages?:number, info?:object, images?:Array, notes:string[]}>}
 */
export async function extractFileContent({ filePath, name = '', mimeType = '', tmpDir, exec = defaultExec, options = {} }) {
  const kind = classifyFile(name, mimeType);
  // maxTextChars = 0 表示**不限**（owner 要求：不要字数限制）。>0 才截断。
  const rawMax = Number(options.maxTextChars);
  const maxChars = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(5_000_000, Math.max(500, rawMax)) : 0;
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages) || 4));
  const renderDpi = Math.max(60, Math.min(200, Number(options.renderDpi) || 110));
  const notes = [];
  if (kind === 'text') {
    const r = await readTextFile({ filePath, maxChars });
    if (r.binary) notes.push('这个文件看着不是纯文本（可能是二进制），没有按文本读');
    if (r.truncated) notes.push(`正文过长，只给了前 ${maxChars} 字`);
    return { kind, text: r.text, truncated: r.truncated, notes };
  }
  if (kind !== 'pdf') return { kind, notes };

  const info = await pdfInfo({ filePath, exec, timeoutMs: options.timeoutMs });
  if (info.info?.Title) notes.push(`PDF 标题：${String(info.info.Title).slice(0, 120)}`);
  if (info.info?.Author) notes.push(`作者：${String(info.info.Author).slice(0, 60)}`);
  const { text, chars, truncated } = await extractPdfText({
    filePath, exec,
    fromPage: 1,
    toPage: maxPages > 0 && info.pages > 0 ? Math.min(info.pages, 200) : 0,
    maxChars,
    timeoutMs: options.timeoutMs
  });
  if (truncated) notes.push(`正文过长，只给了前 ${maxChars} 字（共 ${chars} 字）`);
  // 有文字层就直接给文字（便宜、准）；抽不出文字（扫描件/纯图 PDF）才渲染页面图像。
  // 阈值取得很低（10 个非空字符）：扫描件通常只能抽出页码之类的一两个字符，而**短文档**
  // （一页便签、只有标题的 PDF）本来就是几个字——不能因为「短」就判成扫描件去渲染图片。
  if (text.replace(/\s+/g, '').length >= 10) return { kind, text, truncated, pages: info.pages, info: info.info, notes };
  const images = await renderPdfPages({ filePath, exec, tmpDir, fromPage: 1, toPage: maxPages, dpi: renderDpi, timeoutMs: options.timeoutMs })
    .catch((error) => { notes.push(`渲染页面失败：${String(error?.message ?? error).slice(0, 120)}`); return []; });
  if (!images.length) notes.push('这是扫描件（没有文字层），页面渲染也没成功');
  else notes.push(`这是扫描件（没有文字层），已渲染前 ${images.length} 页图像给视觉模型`);
  return { kind, text: text.trim(), truncated, pages: info.pages, info: info.info, images, notes };
}
