#!/usr/bin/env python3
"""极简 RCON 客户端：给正在运行的 MC 服务端发一条命令（默认 stop）。
用法: rcon-stop.py [命令...]   默认 "stop"
配置来源: /home/wx/mc/server/server.properties 的 rcon.port / rcon.password
"""
import socket
import struct
import sys
import re

PROPS = "/home/wx/mc/server/server.properties"


def read_props(path):
    cfg = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    except OSError:
        pass
    return cfg


def pack(req_id, ptype, body: str) -> bytes:
    payload = struct.pack("<ii", req_id, ptype) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("连接被关闭")
        buf += chunk
    return buf


def read_packet(sock):
    (length,) = struct.unpack("<i", recv_exact(sock, 4))
    return recv_exact(sock, length)


def main():
    cfg = read_props(PROPS)
    host = "127.0.0.1"
    port = int(cfg.get("rcon.port", "25575"))
    password = cfg.get("rcon.password", "")
    command = " ".join(sys.argv[1:]) or "stop"

    if not password:
        print("rcon.password 为空，无法认证", file=sys.stderr)
        return 2

    try:
        sock = socket.create_connection((host, port), timeout=5)
    except OSError as e:
        print(f"连接 RCON 失败: {e}", file=sys.stderr)
        return 3

    with sock:
        sock.settimeout(5)
        # 认证
        sock.sendall(pack(1, 3, password))
        resp = read_packet(sock)
        req_id = struct.unpack("<i", resp[:4])[0]
        if req_id == -1:
            print("RCON 认证失败（密码不对）", file=sys.stderr)
            return 4
        # 发命令
        sock.sendall(pack(2, 2, command))
        out = read_packet(sock)
        print(out[8:].decode("utf-8", "replace").strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
