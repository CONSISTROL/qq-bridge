#!/usr/bin/env python3
# 本地 Qwen 向量 + 重排服务（GPU）。
# 协议与 embedder.js 一致：stdin/stdout 每行一个 JSON
#   请求 {"id":1,"op":"embed","texts":[...]}
#   响应 {"id":1,"vectors":[[...]]}
#   请求 {"id":2,"op":"rerank","query":"...","documents":[...],"topN":3}
#   响应 {"id":2,"results":[{"index":0,"score":0.9}, ...]}
#   请求 {"id":3,"op":"stats"} / {"id":4,"op":"ping"}
import sys, json, os, math
sys.modules.setdefault('torchaudio', None)   # rvc venv 的 torchaudio 与新 torch 不匹配，避免 transformers 去导入它

EMB_DIR = os.environ.get("QWEN_EMB_DIR", "/root/mem-models/Qwen3-Embedding-0.6B")
RER_DIR = os.environ.get("QWEN_RER_DIR", "/root/mem-models/Qwen3-Reranker-0.6B")
EMB_DEV = os.environ.get("QWEN_EMB_DEV", "cuda")
RER_DEV = os.environ.get("QWEN_RER_DEV", "cuda")

import torch  # noqa
from transformers import AutoTokenizer, AutoModel, AutoModelForCausalLM

def log(*a):
    print(*a, file=sys.stderr, flush=True)

_emb = _emb_tok = None
_rer = _rer_tok = None

def load_emb():
    global _emb, _emb_tok
    if _emb is not None: return
    _emb_tok = AutoTokenizer.from_pretrained(EMB_DIR, padding_side="left")
    _emb = AutoModel.from_pretrained(EMB_DIR, torch_dtype=torch.float16 if EMB_DEV == "cuda" else torch.float32).to(EMB_DEV).eval()
    log("embedding ready on", EMB_DEV)

def load_rer():
    global _rer, _rer_tok
    if _rer is not None: return
    _rer_tok = AutoTokenizer.from_pretrained(RER_DIR, padding_side="left")
    _rer = AutoModelForCausalLM.from_pretrained(RER_DIR, torch_dtype=torch.float16 if RER_DEV == "cuda" else torch.float32).to(RER_DEV).eval()
    log("reranker ready on", RER_DEV)

def last_token_pool(last_hidden, attention_mask):
    left = attention_mask[:, -1].sum() == attention_mask.shape[0]
    if left:
        return last_hidden[:, -1]
    lens = attention_mask.sum(dim=1) - 1
    return last_hidden[torch.arange(last_hidden.shape[0]), lens]

def embed(texts):
    load_emb()
    out = []
    batch = 8
    for i in range(0, len(texts), batch):
        chunk = [str(t)[:2000] for t in texts[i:i+batch]]
        enc = _emb_tok(chunk, padding=True, truncation=True, max_length=384, return_tensors="pt").to(EMB_DEV)
        with torch.no_grad():
            hidden = _emb(**enc).last_hidden_state
        vec = last_token_pool(hidden, enc["attention_mask"]).float()
        vec = torch.nn.functional.normalize(vec, p=2, dim=1)
        out.extend(vec.cpu().tolist())
    return out

RER_TMPL_PREFIX = "<|im_start|>system\n判断下面这段材料是否与查询相关，只回答 yes 或 no。<|im_end|>\n<|im_start|>user\n"
RER_TMPL_MID = "<|im_end|>\n<|im_start|>assistant\n"

def rerank(query, documents, topN=3):
    load_rer()
    scores = []
    batch = 16
    for i in range(0, len(documents), batch):
        docs = [str(d)[:200] for d in documents[i:i+batch]]
        pairs = [f"{RER_TMPL_PREFIX}<Query>{query}</Query>\n<Document>{d}</Document>{RER_TMPL_MID}" for d in docs]
        enc = _rer_tok(pairs, padding=True, truncation=True, max_length=384, return_tensors="pt").to(RER_DEV)
        with torch.no_grad():
            logits = _rer(**enc).logits[:, -1, :].float()
        yes = _rer_tok.convert_tokens_to_ids("yes")
        no = _rer_tok.convert_tokens_to_ids("no")
        p = torch.softmax(torch.stack([logits[:, no], logits[:, yes]], dim=1), dim=1)[:, 1]
        scores.extend(p.cpu().tolist())
    order = sorted(range(len(scores)), key=lambda i: -scores[i])[:topN]
    return [{"index": i, "score": float(scores[i])} for i in order]

def main():
    log("loading models…")
    load_emb()
    if os.environ.get("QWEN_PRELOAD_RER", "1") == "1":
        load_rer()
    print(json.dumps({"ready": True, "emb": EMB_DEV, "rer": RER_DEV}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            op = req.get("op")
            rid = req.get("id")
            if op == "ping":
                print(json.dumps({"id": rid, "ok": True}), flush=True); continue
            if op == "stats":
                print(json.dumps({"id": rid, "ok": True, "emb": EMB_DEV, "rer": RER_DEV,
                                  "vram": torch.cuda.memory_allocated() // 1024 // 1024 if torch.cuda.is_available() else 0}),
                      flush=True); continue
            if op == "embed":
                print(json.dumps({"id": rid, "vectors": embed(req.get("texts") or [])}), flush=True); continue
            if op == "rerank":
                print(json.dumps({"id": rid, "results": rerank(req.get("query") or "", req.get("documents") or [], int(req.get("topN") or 3))}), flush=True); continue
            print(json.dumps({"id": rid, "error": "unknown op"}), flush=True)
        except Exception as e:
            print(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "error": str(e)}), flush=True)

main()
