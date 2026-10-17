#!/opt/asr-venv/bin/python
"""QQ 桥接的语音转写服务（跑在 tzd 上，不走公网）。

为什么放 tzd：这台云主机只有 2 核 / 460MB 可用内存 / 磁盘 94%，跑不动 ASR；
tzd 是 8 核 / 16G / 197G 空闲，还带 GTX 1650。桥接只负责用 ffmpeg 抽音轨 + 调这个服务。

协议（极简，避免额外依赖）：
  GET  /health                          → {"ok":true,"model":...}
  POST /transcribe?lang=zh              body=音频字节(wav/mp3/flac/ogg 均可，ffmpeg 解码)
        header x-asr-token: <ASR_TOKEN>  → {"ok":true,"text":...,"duration":...,"tookMs":...}
一次只转一段（模型不是线程安全的），并发请求排队。
"""
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get("ASR_MODEL", "small")
DEVICE = os.environ.get("ASR_DEVICE", "cpu")
COMPUTE = os.environ.get("ASR_COMPUTE", "int8")
TOKEN = os.environ.get("ASR_TOKEN", "")
PORT = int(os.environ.get("ASR_PORT", "8765"))
BIND = os.environ.get("ASR_BIND", "0.0.0.0")
MAX_BODY = int(os.environ.get("ASR_MAX_BODY", str(200 * 1024 * 1024)))
LOCK = threading.Lock()

print(f"[asr] loading model={MODEL} device={DEVICE} compute={COMPUTE}", flush=True)
_t0 = time.time()
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=max(2, (os.cpu_count() or 4) - 2))
print(f"[asr] model ready in {time.time() - _t0:.1f}s", flush=True)


def decode_to_pcm(data):
    """用 ffmpeg 把任意音频/视频字节解成 16kHz 单声道 float32。

    不走 faster-whisper 自带的 PyAV 解码：线上实测 faster-whisper 1.2.1 与已装 PyAV 版本不兼容
    （`open() got an unexpected keyword argument 'metadata_errors'`）。ffmpeg 解码更稳，也顺带支持
    视频容器/各种编码——桥接直接扔视频或者语音的原始字节过来都行。
    """
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
         "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
        input=data, capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg decode failed: " + proc.stderr.decode("utf-8", "ignore")[:200])
    pcm = np.frombuffer(proc.stdout, dtype=np.int16)
    if pcm.size == 0:
        raise RuntimeError("no audio track in the uploaded media")
    return pcm.astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "model": MODEL, "device": DEVICE})
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            return self._json(404, {"ok": False, "error": "not found"})
        if TOKEN and self.headers.get("x-asr-token") != TOKEN:
            return self._json(403, {"ok": False, "error": "bad token"})
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {"ok": False, "error": f"bad body size: {n}"})
        data = self.rfile.read(n)
        qs = parse_qs(urlparse(self.path).query)
        lang = (qs.get("lang") or ["zh"])[0] or "zh"
        started = time.time()
        try:
            with LOCK:
                audio = decode_to_pcm(data)
                segments, info = model.transcribe(
                    audio, language=lang, vad_filter=True, beam_size=1, condition_on_previous_text=False
                )
                text = "".join(seg.text for seg in segments).strip()
            took = int((time.time() - started) * 1000)
            print(f"[asr] {lang} {len(data)}B -> {len(text)} 字 / {took}ms", flush=True)
            self._json(200, {
                "ok": True,
                "text": text,
                "lang": getattr(info, "language", lang),
                "duration": round(float(getattr(info, "duration", 0) or 0), 2),
                "tookMs": took,
                "model": MODEL,
            })
        except Exception as error:  # 转写失败要把原因回给桥接，便于降级
            print(f"[asr] transcribe failed: {error}", flush=True)
            self._json(500, {"ok": False, "error": str(error)[:300]})


if __name__ == "__main__":
    print(f"[asr] listening on {BIND}:{PORT}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
