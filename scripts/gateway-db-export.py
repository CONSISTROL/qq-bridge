#!/usr/bin/env python3
# 从网关的 messages.db 导出指定时间窗内的消息（JSON lines 到 stdout），供 host 侧导入归档。
# 用法（容器内）：python3 gateway-db-export.py <lo_ts> <hi_ts> [group_id ...]
import sqlite3, json, sys

DB = '/app/data/data/2840404638/messages.db'
lo, hi = int(sys.argv[1]), int(sys.argv[2])
wanted = set(int(x) for x in sys.argv[3:])

con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
cur = con.cursor()
q = 'SELECT is_group, session_id, timestamp, data FROM messages WHERE timestamp BETWEEN ? AND ?'
rows = cur.execute(q, (lo, hi)).fetchall()
out = []
for is_group, sid, ts, data in rows:
    if wanted and int(sid) not in wanted:
        continue
    try:
        d = json.loads(data)
    except Exception:
        continue
    if d.get('post_type') != 'message':
        continue
    segs = d.get('message') or []
    text_parts = []
    for seg in segs:
        t = seg.get('type')
        dd = seg.get('data') or {}
        if t == 'text':
            text_parts.append(str(dd.get('text') or ''))
        elif t == 'at':
            text_parts.append('@' + str(dd.get('qq') or ''))
        elif t == 'image':
            text_parts.append('[图片]')
        elif t == 'face':
            text_parts.append('[表情]')
        elif t == 'record':
            text_parts.append('[语音]')
        elif t == 'video':
            text_parts.append('[视频]')
        elif t == 'file':
            text_parts.append('[文件]')
    text = ''.join(text_parts).strip() or str(d.get('raw_message') or '').strip()
    if not text:
        continue
    sender = d.get('sender') or {}
    out.append({
        'isGroup': bool(is_group),
        'session': str(sid),
        'messageId': str(d.get('message_id') or ''),
        'gwSeq': d.get('message_seq'),
        'ts': int(ts) * 1000,
        'userId': str(d.get('user_id') or ''),
        'sender': sender.get('card') or sender.get('nickname') or str(d.get('user_id') or ''),
        'isSelf': str(d.get('user_id') or '') == str(d.get('self_id') or ''),
        'text': text[:500]
    })
out.sort(key=lambda x: x['ts'])
for rec in out:
    print(json.dumps(rec, ensure_ascii=False))
print(json.dumps({'_count': len(out)}), file=sys.stderr)
