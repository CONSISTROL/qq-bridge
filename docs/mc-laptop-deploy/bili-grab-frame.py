#!/usr/bin/env python3
"""拉取 B站直播间当前画面的一帧，用于验证"推流是否真的上屏"。

流程：room/v1/Room/playUrl 取真实流地址 → 优先 HLS → ffmpeg 抽 1 帧
"""
import json
import subprocess
import sys
import urllib.request

ROOM = int(sys.argv[1]) if len(sys.argv) > 1 else 21803677
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/live-frame.png"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": f"https://live.bilibili.com/{ROOM}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    # 先确认房间状态
    info = get(f"https://api.live.bilibili.com/room/v1/Room/get_info?room_id={ROOM}")
    d = info.get("data") or {}
    print(f"房间状态: live_status={d.get('live_status')} 标题={d.get('title')!r} 在线={d.get('online')}")
    if d.get("live_status") != 1:
        print("房间未开播，无法拉流")
        return 2

    # 取流地址
    play = get(f"https://api.live.bilibili.com/room/v1/Room/playUrl?cid={ROOM}&qn=10000&platform=web")
    pd = play.get("data") or {}
    hls = (pd.get("durl") or [{}])[0].get("url")
    # hls 接口在另一个端点
    try:
        h = get(f"https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo"
                f"?room_id={ROOM}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web")
        streams = (((h.get("data") or {}).get("playurl_info") or {}).get("playurl") or {}).get("stream") or []
        for st in streams:
            for fmt in st.get("format", []):
                for code in fmt.get("codec", []):
                    for u in code.get("url_info", []):
                        cand = u.get("host", "") + code.get("base_url", "") + u.get("extra", "")
                        if cand:
                            hls = hls or cand
                            if fmt.get("format_name") in ("ts", "fmp4"):
                                hls = cand
                            print(f"候选流: {fmt.get('format_name')}/{code.get('codec_name')} {cand[:100]}")
    except Exception as e:
        print("解析 getRoomPlayInfo 失败:", e)

    if not hls:
        print("❌ 没拿到流地址（主播可能没在推流）")
        return 3

    print(f"使用流地址: {hls[:120]}")
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-headers", f"Referer: https://live.bilibili.com/{ROOM}\r\nUser-Agent: {UA}\r\n",
         "-i", hls, "-frames:v", "1", "-vf", "scale=640:-1", OUT],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        print("ffmpeg 拉帧失败:", r.stderr[-400:])
        return 4
    print(f"✅ 已保存直播画面: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
