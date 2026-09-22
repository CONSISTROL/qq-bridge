// 从 ModelScope 拉取本地 embedding 模型（HuggingFace 在部分国内机器上不可达）。
//
// 用法：
//   node scripts/fetch-embed-model.mjs            # 缺什么拉什么
//   node scripts/fetch-embed-model.mjs --force    # 全部重拉
//
// 只拉文本编码需要的那几个文件（不含 fp16/q4 等其它精度变体）：
// 合计约 23MB，其中 onnx/model_quantized.onnx 占 22.9MB。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Xenova/bge-small-zh-v1.5';
const DEST = path.join(ROOT, 'models', REPO);
const FORCE = process.argv.includes('--force');

// ModelScope 的仓库文件下载端点
const urlFor = (file) =>
  `https://www.modelscope.cn/api/v1/models/${REPO}/repo?Revision=master&FilePath=${encodeURIComponent(file)}`;

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'quantize_config.json',
  'onnx/model_quantized.onnx'
];

async function download(file) {
  const dest = path.join(DEST, file);
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  ✓ 已存在  ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(urlFor(file), { redirect: 'follow' });
  if (!res.ok) throw new Error(`${file} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 出错时 ModelScope 会返回 JSON 错误体，别把错误信息当模型存下来
  if (buf.length < 64 && buf.toString('utf8').trimStart().startsWith('{')) {
    throw new Error(`${file} → 返回的不是文件内容：${buf.toString('utf8').slice(0, 200)}`);
  }
  fs.writeFileSync(dest, buf);
  console.log(`  ↓ ${file}  ${(buf.length / 1048576).toFixed(2)} MB`);
}

console.log(`拉取 ${REPO} → models/${REPO}\n`);
try {
  for (const f of FILES) await download(f);
} catch (error) {
  console.error(`\n失败：${error.message}`);
  console.error('如果 ModelScope 也不可达，可手动把对应文件放进 models/' + REPO + '/ 后重试。');
  process.exit(1);
}
const onnx = path.join(DEST, 'onnx', 'model_quantized.onnx');
if (!fs.existsSync(onnx)) { console.error('\n缺少 onnx/model_quantized.onnx'); process.exit(1); }
console.log(`\n完成。模型就绪：${onnx}`);
