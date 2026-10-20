// JSON / 文本文件的安全读写。
//
// 这些工具原来在 bridge / memory-admin / image-admin / sent-images / mc-state 里各抄了一份，
// 行为还有细微差别（BOM 处理、原子写临时名用 Math.random 还是 crypto）。统一到这里：
// - readJsonSafe：容错读取（BOM、缺失、损坏都不抛，required=true 时才抛）
// - atomicWriteJson / atomicWriteText：先写唯一临时文件再 rename，避免写一半断电把文件写坏
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（﻿）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
export function readJsonSafe(file, fallback = null, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，
// 也避免固定临时名被并发/符号链接攻击利用。
export function atomicWriteJson(file, obj) {
  atomicWriteText(file, JSON.stringify(obj, null, 2) + '\n');
}

// 原子写文本文件。
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
