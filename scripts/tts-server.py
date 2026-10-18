#!/opt/asr-venv/bin/python
"""QQ 桥接的语音合成服务（跑在 tzd 上）。

链路：文本 → edge-tts 合成中文 → RVC 变声（aiyi 音色）→ wav 字节返回给桥接。
桥接再把它作为 QQ 的 record 段发出去。

为什么放 tzd：RVC（torch + aiyi 模型 + GTX 1650）和 edge-tts 都装在这台 8 核/16G 的机器上，
云主机只有 2 核/460MB，跑不动。

协议：
  GET  /health                        → {"ok":true,"models":["aiyi"],"voice":...}
  POST /tts      body={"text":..., "voice":..., "model":"aiyi", "transpose":0}
        header x-tts-token: <token>     → audio/wav 字节（头 x-tts-fallback: 1 表示 RVC 失败了、只给了 TTS 原声）
"""
import base64
import json
import os
import threading
import re
import subprocess
import tempfile
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RVC_BASE = os.environ.get("RVC_BASE", "http://127.0.0.1:7865")
RVC_DIR = os.environ.get("RVC_DIR", "/root/rvc")
VOCALS_DIR = os.path.join(RVC_DIR, "assets", "weights")
INDEX_DIR = os.path.join(RVC_DIR, "logs")
EDGE_TTS = os.environ.get("EDGE_TTS_BIN", "/root/rvc/venv/bin/edge-tts")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
DEFAULT_MODEL = os.environ.get("TTS_MODEL", "aiyi")
TOKEN = os.environ.get("TTS_TOKEN", "")
PORT = int(os.environ.get("TTS_PORT", "8766"))
BIND = os.environ.get("TTS_BIND", "0.0.0.0")
MAX_TEXT = int(os.environ.get("TTS_MAX_TEXT", "300"))
# RVC WebUI 的「当前模型」是全局状态：两个请求并发时，A 切到 aiyi、B 又切走，
# A 的转换就会用错模型（线上表现：私聊对、群里那条音色不对）。所以整段"切模型+转换"必须串行。
RVC_LOCK = threading.Lock()


def available_models():
    try:
        return [f[:-4] for f in os.listdir(VOCALS_DIR) if f.endswith(".pth")]
    except OSError:
        return []


def index_for(model):
    for base in (INDEX_DIR, VOCALS_DIR):
        p = os.path.join(base, f"{model}.index")
        if os.path.exists(p):
            return p
    return ""


def gradio(fn_index, data, timeout=600):
    payload = json.dumps({"fn_index": fn_index, "data": data, "session_hash": "qq-bridge-tts"}).encode()
    req = urllib.request.Request(f"{RVC_BASE}/api/predict", data=payload, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def tts_to_wav(text, voice):
    """edge-tts → mp3 → ffmpeg → 16k 单声道 wav（RVC 的输入要求）。"""
    with tempfile.TemporaryDirectory() as tmp:
        mp3 = os.path.join(tmp, "tts.mp3")
        subprocess.run([EDGE_TTS, "--voice", voice, "--text", text, "--write-media", mp3],
                       check=True, capture_output=True, timeout=120)
        wav = os.path.join(tmp, "tts.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ar", "16000", "-ac", "1", wav],
                       check=True, capture_output=True, timeout=120)
        with open(wav, "rb") as f:
            return f.read()


def rvc_convert(wav_bytes, model, transpose):
    """RVC 变声：先切模型，再转换；返回 wav 字节或 None（失败时降级为纯 TTS）。"""
    index = index_for(model)
    if not index:
        return None
    b64 = base64.b64encode(wav_bytes).decode()
    try:
        with RVC_LOCK:
            gradio(6, [f"{model}.pth", 0.33, 0.33])  # infer_change_voice：选模型
            result = gradio(3, [  # infer_convert
                0, None,
                {"data": "data:audio/wav;base64," + b64, "name": "in.wav"},
                float(transpose), "rmvpe", index, 0.75, 0, 0.25, 0.33,
            ])
    except Exception as error:  # noqa: BLE001 - 任何 RVC 异常都降级，不能让桥接发不出语音
        print(f"[tts] RVC failed: {error}", flush=True)
        return None
    for item in result.get("data") or []:
        if isinstance(item, dict) and item.get("name"):
            try:
                with open(item["name"], "rb") as f:
                    return f.read()
            except OSError as error:
                print(f"[tts] read RVC output failed: {error}", flush=True)
                return None
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({"ok": True, "models": available_models(), "voice": DEFAULT_VOICE,
                               "rvc": RVC_BASE}, ensure_ascii=False).encode()
            return self._send(200, body, {"content-type": "application/json; charset=utf-8"})
        self._send(404, b'{"ok":false}')

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._send(404, b'{"ok":false}')
        if TOKEN and self.headers.get("x-tts-token") != TOKEN:
            return self._send(403, b'{"ok":false,"error":"bad token"}', {"content-type": "application/json"})
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 1024 * 1024:
            return self._send(400, b'{"ok":false,"error":"bad body"}', {"content-type": "application/json"})
        try:
            body = json.loads(self.rfile.read(n))
        except json.JSONDecodeError:
            return self._send(400, b'{"ok":false,"error":"bad json"}', {"content-type": "application/json"})
        text = str(body.get("text") or "").strip()[:MAX_TEXT]
        if not text:
            return self._send(400, b'{"ok":false,"error":"empty text"}', {"content-type": "application/json"})
        voice = str(body.get("voice") or DEFAULT_VOICE)
        model = str(body.get("model") or DEFAULT_MODEL)
        try:
            transpose = int(float(body.get("transpose") or 0))
        except (TypeError, ValueError):
            transpose = 0
        try:
            wav = tts_to_wav(text, voice)
        except subprocess.CalledProcessError as error:
            return self._send(500, json.dumps({"ok": False, "error": f"edge-tts failed: {error.stderr.decode('utf-8', 'ignore')[:200]}"}).encode(),
                              {"content-type": "application/json; charset=utf-8"})
        converted = rvc_convert(wav, model, transpose)
        if converted:
            print(f"[tts] {len(text)} 字 → RVC({model}) {len(converted)}B", flush=True)
            return self._send(200, converted, {"content-type": "audio/wav"})
        print(f"[tts] {len(text)} 字 → TTS 原声（RVC 不可用）", flush=True)
        return self._send(200, wav, {"content-type": "audio/wav", "x-tts-fallback": "1"})


if __name__ == "__main__":
    print(f"[tts] listening on {BIND}:{PORT} models={available_models()}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
