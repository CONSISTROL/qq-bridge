// 文件读取（PDF/文本）的自检脚本：纯逻辑 + 真 poppler 集成。
// 运行：node scripts/test-file-extract.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyFile, pdfInfo, extractPdfText, renderPdfPages, readTextFile, extractFileContent
} from '../src/file-extract.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-file-test-'));

/** 手搓一个最小合法 PDF（带正确 xref），避免为测试引入 PDF 生成库。 */
function makePdf(text, { fontSize = 24 } = {}) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // 内容流，下面填
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = `BT /F1 ${fontSize} Tf 20 120 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const hasPoppler = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

console.log('\n## 分类');
{
  check('.pdf → pdf', classifyFile('a.pdf') === 'pdf');
  check('application/pdf → pdf', classifyFile('无名', 'application/pdf') === 'pdf');
  check('.md → text', classifyFile('README.md') === 'text');
  check('text/plain → text', classifyFile('x', 'text/plain') === 'text');
  check('.png → image', classifyFile('a.png') === 'image');
  check('.apk → other', classifyFile('Clash Meta for Android.apk.1') === 'other');
}

console.log('\n## PDF 文字抽取（假 exec，确定性）');
{
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'pdfinfo') return { stdout: 'Title: 高性价比人生指南\nAuthor: eternity4719\nPages: 42\n' };
    if (cmd === 'pdftotext') return { stdout: '第一行   有空格\n\n\n\n第二段\n' };
    throw new Error(`未预期的命令 ${cmd}`);
  };
  const info = await pdfInfo({ filePath: '/x/a.pdf', exec });
  check('pdfinfo 解析页数', info.pages === 42, JSON.stringify(info));
  check('pdfinfo 解析标题', info.info.Title === '高性价比人生指南');

  const r = await extractPdfText({ filePath: '/x/a.pdf', exec, fromPage: 1, toPage: 4, maxChars: 10000 });
  check('保留排版参数 -layout', calls.some(([c, a]) => c === 'pdftotext' && a.includes('-layout')));
  check('显式 UTF-8', calls.some(([c, a]) => c === 'pdftotext' && a.includes('UTF-8')));
  check('页码范围被传下去', calls.some(([c, a]) => c === 'pdftotext' && a.includes('-f') && a.includes('-l')));
  check('多余空行被压掉', r.text === '第一行   有空格\n\n第二段', JSON.stringify(r.text));

  const big = await extractPdfText({ filePath: '/x/a.pdf', exec: async () => ({ stdout: 'x'.repeat(500) }), maxChars: 100 });
  check('超长要截断并标记', big.truncated === true && big.text.length === 100 && big.chars === 500);
}

console.log('\n## 扫描件兜底（抽不到文字 → 渲染页面图像）');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'scan-'));
  const exec = async (cmd, args) => {
    if (cmd === 'pdfinfo') return { stdout: 'Pages: 3\n' };
    if (cmd === 'pdftotext') return { stdout: '  \n\n' };
    if (cmd === 'pdftoppm') {
      const prefix = args[args.length - 1];
      fs.writeFileSync(`${prefix}-1.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      fs.writeFileSync(`${prefix}-2.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { stdout: '' };
    }
    throw new Error(`未预期的命令 ${cmd}`);
  };
  const r = await extractFileContent({ filePath: '/x/scan.pdf', name: 'scan.pdf', tmpDir: dir, exec, options: { maxPages: 2 } });
  check('判定 pdf', r.kind === 'pdf');
  check('没有文字就渲染图像', Array.isArray(r.images) && r.images.length === 2, JSON.stringify(r.images?.length));
  check('图像带页码', r.images[0].page === 1 && r.images[1].page === 2);
  check('说明里点出是扫描件', r.notes.join('|').includes('扫描件'), r.notes.join('|'));
  check('页数来自 pdfinfo', r.pages === 3);
}

console.log('\n## 文本文件');
{
  const p = path.join(tmp, 'a.md');
  fs.writeFileSync(p, '# 标题\n正文一段\n');
  const r = await readTextFile({ filePath: p });
  check('UTF-8 文本能读', r.text.includes('正文一段') && r.binary === false);
  const bin = path.join(tmp, 'b.bin');
  fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  check('二进制被识别（不当文本读）', (await readTextFile({ filePath: bin })).binary === true);
  const t = await extractFileContent({ filePath: p, name: 'a.md' });
  check('extractFileContent 走 text 分支', t.kind === 'text' && t.text.includes('标题'));
}

console.log('\n## 与真 poppler 的集成（有 pdftotext 才跑）');
if (!hasPoppler) {
  console.log('  ⏭  跳过：本机没有 pdftotext');
} else {
  const pdfPath = path.join(tmp, 'real.pdf');
  fs.writeFileSync(pdfPath, makePdf('Hello PDF 12345'));
  const info = await pdfInfo({ filePath: pdfPath });
  check('真 pdfinfo 认出 1 页', info.ok && info.pages === 1, JSON.stringify(info));
  const txt = await extractPdfText({ filePath: pdfPath });
  check('真 pdftotext 能抽出文字', txt.text.includes('Hello PDF 12345'), JSON.stringify(txt.text.slice(0, 80)));
  const all = await extractFileContent({ filePath: pdfPath, name: 'real.pdf', tmpDir: tmp });
  check('有文字层时不渲染图像（省钱）', all.kind === 'pdf' && all.text.includes('Hello PDF 12345') && !all.images);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
