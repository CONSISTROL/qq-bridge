# MC 服务器 + B站推流：笔记本部署记录（2026-10-05）

> 把整条「MC 服务端 + AI bot + 体素渲染推流」栈从阿里云服务器迁到家里笔记本 `tzd`（`10.8.0.2`，走 WireGuard 隧道）。
> 本文记录**已完成的部署**、**踩到的坑**、以及**还剩什么没做**。

---

## 1. 当前部署形态

| 组件 | 位置 | 运行方式 | 状态 |
|---|---|---|---|
| WireGuard 服务端 | 阿里云 `10.8.0.1` | `wg-quick@wg0` | ✅ enabled |
| WireGuard 客户端 | 笔记本 `10.8.0.2` | `wg-quick@wg0` | ✅ enabled，`PersistentKeepalive=25` |
| MC 服务端 | 笔记本 | `systemd: mcserver` | ✅ active/enabled |
| AI bot (mineflayer) | 笔记本 | `systemd: mcbot` | ✅ active/enabled |
| 推流渲染 (体素→ffmpeg→RTMP) | 笔记本 | `systemd: mcstream` | ⏸ inactive/disabled（等开播换推流码） |

**笔记本硬件**：i5-9300H 8 核 / 15 GiB 内存 / Ubuntu 24.04.2 (kernel 6.8) / UTC 时区
**MC 版本**：Paper 1.20.4（`git-Paper-499`），Java 25（`openjdk-25-jre-headless`）
**世界**：从服务器完整迁移 `world` + `world_nether` + `world_the_end`

---

## 2. 关键路径（必须在这些位置，代码里是硬编码的）

```
/home/wx/mc/
├── server/            # Paper 服务端
│   ├── paper.jar
│   ├── start.sh       # 内存参数已改为 XMS=2G / XMX=6G（原 192M/384M）
│   ├── mc.sh          # start/stop/restart/status/log
│   ├── rcon-stop.py   # RCON 客户端（systemd ExecStop 用它优雅停服）
│   ├── server.properties
│   ├── logs/server.pid
│   └── world*
├── bot/
│   ├── botd.js        # 常驻 bot，默认连 127.0.0.1:25565
│   └── bot-state.json # 状态文件（桥接/控制台读它）
└── stream/
    ├── bili-live.js         # B站开播/下播/查状态（用 bili-cookie-full.txt）
    ├── render-stream.js     # 体素渲染 → ffmpeg → RTMP
    ├── stream.sh            # 手动启停（supervisor 循环）
    ├── mc-stream-launch.sh  # systemd 启动器：读 stream-config.json → 环境变量 → exec 渲染器
    ├── stream-config.json   # 画质：960x540@5fps，投射 320x180，1800k，半径 20
    ├── stream.env           # RTMP_URL（每次开播都会变，0600）
    └── bili-cookie-full.txt # B站登录 cookie（0600）
```

---

## 3. systemd 单元

三个单元都在 `/etc/systemd/system/`：

- **`mcserver.service`** — `ExecStart=start.sh`（前台 exec java）、`ExecStop=rcon-stop.py stop`（RCON 优雅停服，让 Paper 存盘）、崩溃自动重启。
- **`mcbot.service`** — `botd.js`，`VIEWER_DIST=2`，`Restart=always`，日志 append 到 `bot/bot.log`。
- **`mcstream.service`** — `mc-stream-launch.sh`，`Restart=always`，日志 append 到 `stream/stream.log`。

```bash
# 常用操作（笔记本上）
sudo systemctl status mcserver mcbot mcstream
sudo systemctl restart mcserver      # 改 server.properties 后
sudo systemctl start mcstream        # 有推流码后才启
journalctl -u mcserver -f            # 看服务端日志
```

---

## 4. 本次部署踩到的坑（都值得记住）

### 4.1 笔记本 IPv6 不通，导致 npm / apt 假死
症状：`npm ci` 卡住不动、`ss` 里一堆 `SYN-SENT` 到 IPv6 地址；aliyun IPv6 返回 `000`。
修法：
```bash
# 系统层：IPv4 优先
echo 'precedence ::ffff:0:0/96  100' | sudo tee -a /etc/gai.conf
# npm 层
echo 'dns-result-order=ipv4first' >> ~/.npmrc
# apt 层
sudo apt-get -o Acquire::ForceIPv4=true install ...
```
**并且要 export `NODE_OPTIONS=--dns-result-order=ipv4first`**（systemd 单元和启动器里已写死）。

### 4.2 apt 源两个都卡，最后用清华源
- `archive.ubuntu.com`：IPv6 上传 0 B/s，5 分钟没进展
- `mirrors.aliyun.com`：小包能用，`fonts-noto-cjk` 这种大包停滞
- `mirrors.tuna.tsinghua.edu.cn`：**装 CJK 字体时好使**

### 4.3 中文字体缺失 → HUD 全是豆腐块
`render-stream.js` 指定字体族 `"Noto Sans CJK SC"`。服务器有 30 个中文字体，**全新笔记本 0 个**，HUD 中文全变成 `□`。
```bash
sudo apt-get install -y fonts-noto-cjk fonts-noto-color-emoji
```
> 判断依据：`fc-list :lang=zh | wc -l`（服务器 30 / 笔记本修复前 0）

### 4.4 `sudo -S` 会吃掉 heredoc 的内容
`echo "$PW" | sudo -S tee file <<'EOF' ...` —— `sudo -S` 从 stdin 读密码，把 heredoc 内容顶掉，
**结果文件里写进去的是密码明文**（本次真踩到，已删除）。
**正确姿势**：先在 `/tmp` 用普通用户写好文件，再 `sudo install -m 644 file /目标`。

### 4.5 多个 npm 实例互相打架
一次卡住的 `npm ci` 不会因为网络恢复就退出，它会在网络恢复后**继续下载**，与后来启动的实例抢同一个 `node_modules`，
表现是"装了 10 分钟还没完"。修法：`pkill -9 -f 'npm ci'` 后单实例重跑。

### 4.6 canvas 原生模块必须编译
`prismarine-viewer` 依赖 `canvas`，需要 `binding.gyp` 编译产物 `build/Release/canvas.node`。
缺编译依赖时 `require('canvas')` 报 `Cannot find module '../build/Release/canvas.node'`。
```bash
sudo apt-get install -y build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
cd /home/wx/mc/bot && npm rebuild canvas --build-from-source
```

### 4.7 B站开播的两道门槛
1. `code=60034 系统维护仅支持直播姬开播` → **粉丝数不够的第三方开播限制**；
   `bili-live.js` 已自动用直播姬客户端签名（`platform=pc_link`）绕过。
2. `code=60043 需要人脸认证` → **账号级硬门槛，只能在手机 B站 App / 直播姬 上真人核验，无技术手段可绕**。

---

## 5. 验证记录（都实测过）

| 项目 | 结果 |
|---|---|
| MC 服务端启动 | `Done (2.980s)!`，25565 / 25575 监听正常 |
| RCON | `list` / `gamerule keepInventory` 均正常回包 |
| AI bot 连接 | `玩家加入: DeepSeek`，能进世界、推进里程碑、自主挖矿 |
| 渲染性能 | **实测 5.0–5.1 fps（丢 0 帧）**，投射 ~30–40ms + 合成 2–4ms（服务器上曾只有 4.7fps / 投射 111ms） |
| 本地录像 | 40 秒 mp4 = 5.1MB，H.264 960x540@5fps + AAC ✅ |
| **RTMP 推流链路** | 用本地 `ffmpeg -listen 1` 当接收端，25 秒推送收到 **3.6MB**、ffprobe 校验 H.264 960x540@5fps、时长 24.8s ✅ |
| HUD 中文渲染 | 修复字体后正常（"DeepSeek 玩 Minecraft · 实况"）✅ |
| 网页直播 | `http://10.8.0.2:3200`（viewer 内部 3201）✅ |

> 灰画面不是 bug：bot 在 y=27 地下挖矿时，摄像机周围全是石头，渲染出来自然是灰的；
> 第一次测试（地表 y=4）渲染出的是正常的绿色地形 + 天空。

---

## 6. 还没做的（按优先级）

1. **等 B站人脸核验**（只能用户本人手机上做）→ 然后：
   ```bash
   cd /home/wx/mc/stream
   node bili-live.js start          # 换推流码（写 stream.env）
   sudo systemctl enable --now mcstream   # 起推流并开机自启
   ```
2. **桥接衔接**：`qq-bridge/src/mc-state.js` 用 `MC_ROOT`（默认 `/home/wx/mc`）读**本地**文件。
   MC 栈搬到笔记本后，服务器上的桥接读不到 MC 状态了。两条路：
   - **过渡**：服务器上 `sshfs` 挂载笔记本的 `/home/wx/mc`，桥接设 `MC_ROOT=<挂载点>`；
   - **正规**：按《服务器瘦身与笔记本迁移方案》把 dsh / qq-bridge 也搬到笔记本，全部走 `127.0.0.1`。
3. **笔记本时区是 UTC**（比服务器慢 8 小时），跑日志/对时间建议 `sudo timedatectl set-timezone Asia/Shanghai`。
4. **旧服务器收尾**：服务器上 MC 已停（25565 未监听），内存释放到可用 507Mi；
   若要彻底下掉，可停掉相关脚本的开机自启。

---

## 7. 桥接衔接（2026-10-05 第二轮完成）

MC 栈搬到笔记本后，服务器上的 `qq-bridge` 用 `MC_ROOT` 读**本地**文件，等于瞎了。
解决方案：**单向状态镜像 + 端口桥**，桥接代码零改动。

### 7.1 架构

```
笔记本 tzd (10.8.0.2)                        阿里云服务器 (10.8.0.1)
┌──────────────────────────┐                ┌────────────────────────────────┐
│ mcserver (Paper)         │                │ qq-bridge                      │
│ mcbot   (mineflayer)     │                │  └─ src/mc-state.js            │
│  ├ bot-state.json        │  mcsync(5s)    │      读 /home/wx/mc/…          │
│  ├ bot.log               ├───────────────►│                                │
│  └ server.properties     │   rsync over   │  /home/wx/mc → /home/wx/mc-mirror
│                          │   ssh(密钥)    │  （符号链接，旧目录已移开保留） │
│ viewer :3200             │                │                                │
│ mcserver :25565          │◄───────────────┤  mc-viewer-proxy.socket :3200  │
└──────────────────────────┘  socket-proxyd └─ mc-server-proxy.socket :25565 │
                                              └────────────────────────────────┘
```

### 7.2 三层衔接分别解决什么

| 问题 | 做法 | 结果 |
|---|---|---|
| 桥接读不到 bot 状态/里程碑/日志 | 笔记本 `mcsync` 每 5 秒 rsync 到服务器 `/home/wx/mc-mirror`；`/home/wx/mc` 变成指向它的符号链接 | `bot.online/position/intent/milestones` 全部实时（约 10 秒新鲜度） |
| 桥接的 `portListening(25565)` 为 false | 服务器 `mc-server-proxy.socket` 把 `25565 → 10.8.0.2:25565` | `server.listening = true`；**外部仍可用 `139.196.173.199:25565` 连服** |
| 桥接的 `pidAlive(server.pid)` 为 false | `mc-proxy-warmup.timer` 每分钟把 25565 转发进程的 PID 写进 `server.pid` | `server.running = true` |

> **为什么 `server.pid` 不能从笔记本镜像过来**：镜像的是笔记本 java 的 PID，在服务器上无意义（`kill -0` 直接失败）。
> 踩过的坑：一开始把 `server/logs/server.pid` 放进了 mcsync 的同步清单，结果笔记本的 PID 每 5 秒把服务器侧正确的 PID 覆盖掉，
> 表现为 `server.running` 一直在 true/false 之间跳。**已从同步清单移除。**
>
> **为什么用"端口桥进程活着"代表服务端在跑**：语义上成立（桥活=笔记本 MC 可达），
> 且不需要改桥接代码。副作用：若笔记本 MC 挂了但转发进程还在，`server.running` 会短暂误报 true，
> 此时 `bot.online` 会同时变 false，控制台仍能看出异常。

### 7.3 新增的 systemd 单元

**笔记本**（用户 wx）：
- `mcsync.service` — 状态镜像守护（`/usr/local/bin/mcsync-daemon.sh`，每 5s）
- `mc-write-pid.service` + `.timer` — 每 10s 把 mcserver 的 MainPID 写进 `logs/server.pid`（本地用途）

**服务器**（root）：
- `mc-server-proxy.socket` / `.service` — 25565 端口桥（`--exit-idle-time=infinity` 常驻）
- `mc-viewer-proxy.socket` / `.service` — 3200 端口桥（nginx 的 `/mc/` 反代依赖它）
- `mc-proxy-warmup.service` + `.timer` — 每分钟预热端口桥并刷新 `server.pid`

### 7.4 密钥与权限

- 服务器生成专用密钥 `mcsync@server-to-laptop`，私钥放笔记本 `~/.ssh/mcsync_key`(600)，公钥追加到服务器 `~/.ssh/authorized_keys`
- **没有复用** GitHub 用的 `id_ed25519`，避免把能推代码的密钥散到笔记本
- 镜像目录属主 `wx`（服务器 uid 1001），桥接以 root 读，无权限问题

### 7.5 实测证据

```
桥接 getMcStatus():
  bot.online       : true | pos {"x":87.7,"y":21,"z":39.7}
  server.running   : true (pid 61972)
  server.listening : true
  milestone.current: 2 | done [1]
  viewer.running   : true
  数据新鲜度       : 11 秒前
  🎉 四项全部就绪

Minecraft 协议握手（服务器 127.0.0.1:25565 → 笔记本）:
  ✅ 版本: Paper 1.20.4 | 在线人数: 1/8 | 玩家: ["DeepSeek"]

viewer 三条路径:
  https://anihub.xin/mc/  → 200 (0.27s)
  127.0.0.1:3200 (服务器)  → 200
  10.8.0.2:3200 (笔记本)   → 200
```

### 7.6 回滚办法

```bash
# 桥接恢复读服务器本地旧 MC 目录
sudo rm /home/wx/mc
sudo mv /home/wx/mc.old-server-<时间戳> /home/wx/mc
# 停掉端口桥与镜像
sudo systemctl disable --now mc-server-proxy.socket mc-viewer-proxy.socket mc-proxy-warmup.timer
# 笔记本侧
ssh wx@10.8.0.2 'sudo systemctl disable --now mcsync mc-write-pid.timer'
```

配置与脚本副本存于 `docs/mc-laptop-deploy/`。

---

## 8. 第三轮：开机自启加固与链路复验（2026-10-05）

### 8.1 笔记本的 WireGuard 是「双管理」——已澄清

排查开机自启时发现笔记本上 `wg-quick@wg0` 是 **failed** 状态，一度以为是配置问题。实际原因：

```
Oct 05 13:18:26 wg-quick[11432]: wg-quick: `wg0' already exists
```

- 笔记本的 wg0 实际由 **NetworkManager** 创建（`nmcli` 里有连接 `wg0:wireguard:wg0`）
- 那条 NM 连接的 `connection.autoconnect = no`，且**没有落盘**到 `/etc/NetworkManager/system-connections/`（内存连接）
- 它在本次会话里被反复创建（11:00、11:10、11:21、12:19… 每次 `new WireGuard device`），合盖唤醒后又重建

**结论（开机路径是通的，不用改）**：
| 来源 | 位置 | 重启后是否保留 | 何时生效 |
|---|---|---|---|
| `wg-quick@wg0`（enabled） | `/etc/wireguard/wg0.conf`（落盘） | ✅ 是 | **开机时**，它是重启后唯一的持久来源 |
| NetworkManager 连接 wg0 | 内存 | ❌ 否 | 仅本次会话运行期 |

`wg-quick@wg0` 那个 failed 只是**我在 13:18 手动 restart 时接口已被 NM 建好**所致，不是开机失败。
> 遗留的整洁性问题：两者都"拥有"wg0 有潜在竞争。如果要彻底干净，应二选一
> （推荐：删掉 NM 的内存连接 `nmcli connection delete wg0`，统一由 wg-quick 管）。

### 8.2 修掉笔记本上 mcserver.service 的旧版本

笔记本上的单元还是**我编辑前的版本**（`StartLimitIntervalSec` 留在 `[Service]` 段，systemd 会忽略并告警）。
已同步为修正版（移到 `[Unit]`），`systemd-analyze verify` 四个单元全部通过：

```
✅ mcserver.service   ✅ mcbot.service   ✅ mcstream.service   ✅ mcsync.service
```

### 8.3 自动开推链路复验（模拟"开播后自动推流"）

用户完成人脸核验并 `bili-live.js start` 之后，`mcstream` 会自动开推。为确认这条路径真的通，
用本地 RTMP 接收端代替 B站做了完整复验（备份并还原了真实 `stream.env`）：

```
推送端: ▶ 64 帧（丢 0） 实测 5.1fps  耗时: 投射 7ms + 合成 1ms  HUD 在线
        ■ 到达 20s，收工   ffmpeg 退出 code=0
接收端: ✅ 收到 1984793 bytes
        codec_name=h264  width=960  height=540  r_frame_rate=5/1  (+ aac)
stream.env: ✅ 已还原为 rtmp://txy2.live-push.bilivideo.com（148 bytes）
```

> 投射耗时 7ms 是本机直连（bot 与摄像机同机）的结果，比之前经隧道时更快。

### 8.4 一处遗留限制：公网 25565 需要安全组放行

端口桥让服务器本机 `127.0.0.1:25565` 通了（桥接与局域网可用），但**公网连不上**：

```
ufw: 25565/tcp ALLOW ✅
实测 : 139.196.173.199:25565 → ❌ 建连失败
```

**原因**：阿里云**安全组**入方向没放行 25565/tcp（ufw 管不到安全组）。
这是**迁移前就存在的限制**（旧服务器同样如此，见 `README.md` 「公网开放还差一步」）。
需要在阿里云控制台 → 该实例 → 安全组 → 入方向 → 添加 `TCP 25565`（授权对象 `0.0.0.0/0`）后，外网玩家才能直连。

顺带建议：**别把 3080（DSH GUI）暴露到公网**，走 WireGuard 或 `ssh -L` 转发。

---

## 9. 闭环达成（2026-10-05 15:0x）

### 9.1 直播间已上线，且确认播的就是本机渲染流

用户手动开播后，`mcstream` **自动检测到开播并开推**（等待 570 秒后自动开始，无需人工干预）：

```
[launcher] ⏸ 已等待 540s，仍在等开播…
[launcher] ✅ 房间已开播（等待了 570s），开始推流
[15:03:06] ▶ 目标: RTMP（串流码已隐去）
[15:03:07] 摄像机 bot 已进入: {"x":83.5,"y":20,"z":39.5}
[15:07:37] ▶ 1340 帧（丢 0）　实测 5.0fps　耗时: 投射 31ms + 合成 2ms　HUD 在线
```

**验证"直播间播的确实是这条推流"**（不靠推断，直接抓画面）：
`scripts` 里新增 `bili-grab-frame.py`（走 `Room/playUrl` + `getRoomPlayInfo` 取真实 CDN 地址 → ffmpeg 抽 1 帧），
两次抓帧结果都是本机体素渲染画面：

```
房间状态: live_status=1 标题='大肥鱼探索中' 在线=8 分区=我的世界
画面内容: HUD「DeepSeek 玩 Minecraft · 实况」「已播 2.3 分 → 4.3 分」
          「里程碑 #2 挖矿」「坐标 94,27,38 → 90,22,38」「5fps」+ 右侧 41×41 小地图
```

### 9.2 收尾修掉的两个"跨机陷阱"

改完这两处，桥接控制台的 MC 与推流视图才真正完整。

| 问题 | 现象 | 修法 |
|---|---|---|
| 桥接 `hasPushUrl=false`、`push.stats=null` | `stream.env`/`stream.log` 没在同步清单里 | mcsync 清单加入 `stream/stream.env`、`stream/stream.log`（**故意不加 `stream.pid`**） |
| 桥接 `push.running=false` | 桥接用 `pidAlive(stream.pid)`，而镜像的笔记本 PID 在服务器上无意义 | `mc-proxy-warmup.sh` 改成用**服务器侧客观信号**合成：镜像 `stream.log` 新鲜度（<90s）+ 端口桥进程活着 → 写 PID，否则清空 |

修复后桥接推流视图：

```
push.running : True | pid 61972 | logAgeSec 6
stats        : {"frames": 1265, "dropped": 0, "fps": 5, "rayMs": 41, "composeMs": 2, "gridBuilds": 87}
hasPushUrl   : True
room         : liveStatus 1 | 大肥鱼探索中
```

**⚠️ 已知的跨机限制（未改代码，需知悉）**：
桥接控制台的「启停推流」按钮走 `runStreamAction()` → 在**服务器本地**执行 `stream.sh start/stop`，
而推流进程在**笔记本**上，所以这两个按钮**管不到实际推流**。
日常不需要它们（`mcstream` 是 systemd 常驻 + 自动检测开播）；
若真要用控制台控制，需要把 `STREAM_SH` 指到跨机通道（如 `ssh wx@10.8.0.2 ...`），属于改桥接代码的范畴。

### 9.3 最终状态

```
笔记本: mcserver ✅ mcbot ✅ mcstream ✅ mcsync ✅ mc-write-pid.timer ✅   （全部 enabled）
服务器: mc-server-proxy.socket ✅ mc-viewer-proxy.socket ✅ mc-proxy-warmup.timer ✅
桥接  : bot.online=true  server.running=true  listening=true  viewer.running=true
        push.running=true  room.liveStatus=1
直播间: https://live.bilibili.com/21803677 （在线 8，分区「我的世界」）
```

---

## 10. 画质提升：540p@5fps → 720p@30fps（2026-10-05 15:1x）

用户反馈"分辨率和帧率太低"。做了一轮**基准测试**再定方案，不是拍脑袋调参。

### 10.1 先确认 B站侧的画质上限

用 `getRoomPlayInfo` 查观众侧可拉到的流：`qn=10000`，其 `detail_desc` 是 **「720P 原画」**。
说明**这个账号的原画档就是 720P** —— 推 1080p/2K 也不会变成原画（B站只会转码压回 720P）。
所以目标定为 **720p + 高帧率**，而不是盲目堆分辨率。

### 10.2 基准测试（每档实跑 18~25 秒）

| 档位 | 输出 | 投射 | 实测 | 丢帧 | 投射耗时 |
|---|---|---|---|---|---|
| A 现状 | 960x540@5 | 320x180 | 5.1fps | 0 | 36ms |
| B | 1280x720@30 | 640x360 | 21.7fps | 69 | 49ms |
| C | 1920x1080@30 | 960x540 | 8.7fps | 83 | 106ms |
| D | 1920x1080@60 | 960x540 | 10.6fps | 94 | 87ms |
| E | 2560x1440@30 | 1280x720 | 6.0fps | 66 | 155ms |
| — | 1280x720@30 | **320x180** | **31.4fps** | **0** | 9ms |
| — | 1280x720@30 | **400x225** | **30.4fps** | **0** | 14ms |
| — | 1280x720@30 | 480x270 | 30.4fps | 1 | 22ms |
| — | 1080p 输出@30 | 480x270 | 29.2fps | 131 | 23ms |
| — | 1440p 输出@30 | 480x270 | 25.2fps | 177 | 39ms |

**结论：唯一瓶颈是"光线投射像素数"（单线程 DDA，耗时严格线性）。输出分辨率几乎不花钱** ——
但输出拉到 1080p 以上时合成+编码开销开始丢帧，而 B站原画只有 720p，得不偿失。

### 10.3 最终配置（已生效）

```json
{ "w": 1280, "h": 720, "rw": 400, "rh": 225, "fps": 30, "bitrate": "3500k", "radius": 24 }
```

选 `400x225` 而不是 `480x270`：后者偶发丢帧（1/346），前者在两轮共 60 秒测试里**稳定丢 0**。

### 10.4 实测验证

```
笔记本推流侧: [15:14:51] ▶ 806 帧（丢 7）实测 30.0fps 耗时: 投射 13ms + 合成 3ms
             （"丢 7" 是重启切换瞬间的，之后稳定不再增长）
直播间拉流侧: codec_name=h264  width=1280  height=720  r_frame_rate=30/1
画面确认    : HUD「已播 0.7 分」「31fps」「坐标 94,27,38」中文完好
```

**提升幅度：帧率 5 → 30（6 倍），像素量 960x540 → 1280x720（2.4 倍）。**

### 10.5 还能再高吗

- **帧率**：720p 下投射 320x180 能到 31.4fps、400x225 是 30.4fps —— 30fps 已经贴着当前投射分辨率的上限。
  想上 60fps，需要把投射降到约 320x180（画面更"糊"），或改渲染器做多线程（单线程 DDA 是硬限制）。
- **分辨率**：受 B站原画档（720P）限制，再高只会被转码。
- **画质观感**：投射 400x225 → 输出 1280x720 是 3.2 倍放大，所以体素边缘偏软。
  若想更锐利，可牺牲帧率换投射（如 720p@20fps + 投射 560x315）。

---

## 11. 为什么推流画面比不上网页地图（重要认知）

用户反馈"B站直播间看到的游戏内容分辨率很低，和 https://anihub.xin/mc/ 看到的不一样"。
**这不是参数没调好，而是两条完全不同的渲染管线。**

| | `/mc/` 网页地图 | B站推流 |
|---|---|---|
| 渲染器 | **prismarine-viewer**（Three.js 真 3D） | 自研 CPU 体素光线投射（`render-stream.js`）|
| 几何 | 真实方块网格 + **真实材质贴图** | 逐像素 DDA，纯色 + 8×8 明暗抖动"假贴图" |
| 光照 | 平滑光照/AO | 按方块光值 + 环境光下限 0.45 |
| 光栅化 | **GPU**（浏览器 WebGL） | **CPU 单线程** |
| 分辨率 | 跟浏览器窗口自适应（可 1080p+） | 投射分辨率（本例 800x450）再放大到 1280x720 |
| 帧率 | 浏览器能跑多少就多少 | 受 CPU 投射耗时限制 |

所以网页地图**天然**更清晰、更平滑。要让推流画面追上它，只有两条路：

1. **提高投射分辨率**（本次已做，见下）——受单线程 CPU 限制，是线性成本；
2. **换渲染管线**——用无头浏览器 + WebGL 跑 prismarine-viewer 再抓帧，画质能对齐，
   但复杂度高（Xvfb/headless GL + 截图/编码链路），属于重做推流部分。

### 11.1 本次调整（投射 400x225 → 800x450）

用已测的成本模型（约 0.15~0.19µs/像素，超线性）定参数，不再盲目试：

```json
{ "w": 1280, "h": 720, "rw": 800, "rh": 450, "fps": 15, "bitrate": "3500k", "radius": 24 }
```

| 指标 | 调整前 | 调整后 |
|---|---|---|
| 投射分辨率 | 400x225（90k 像素） | **800x450（360k 像素，4×）** |
| 放大倍率 | 3.2× | **1.6×** |
| 帧率 | 30fps | 15fps |
| 实测 | 30.0fps / 投射 14ms | **14.4~15.1fps / 投射 45~62ms** |
| 直播间拉流 | 1280x720@30 | 1280x720@15 |

画面锐度明显改善（方块边缘、小地图、HUD 都更利落），代价是帧率减半。

### 11.2 半成品：`--band` 多进程并行投射（已加但未接线）

`render-stream.js` 已支持 `--band k/n`（只渲染第 k 段横条，写入 `img.data` 对应偏移），
**默认 `0/1` 行为与改动前完全一致**（已回归测试）。这是为"多进程分摊投射"准备的接口。

> **未做下去的原因**：白名单只放行 `DeepSeek` / `DeepSeekCam` 两个账号，
> 测试进程无法用独立相机名进服（`You are not whitelisted`），
> 而用同一个名字会和直播进程抢账号（`multiplayer.disconnect.duplicate_login`）。
> 要做多进程渲染，先得给白名单加一个专用测试账号，或让主进程统一持有相机 bot、子进程只做纯计算。

预期收益（按实测成本外推）：4 个进程分摊 800x450 → 单进程一份投射约 14ms，
**理论上能同时拿到 720p 分辨率 + 30fps**；再往上 1024x576@30 也可行。机器有 8 核，目前只用了约 1.5 核。

---

## 12. GPU 渲染管线（路线 3）：已打通，卡在 Secure Boot

目标：推流画质对齐 `https://anihub.xin/mc/`（真 3D + 真实方块贴图 + 高分辨率）。

### 12.1 为什么必须换管线

之前的推流是**自研 CPU 体素光线投射器**（`render-stream.js`）：逐像素 DDA、纯色+抖动假贴图、单线程。
而 `/mc/` 网页地图是 **prismarine-viewer（Three.js + GPU 光栅化 + 真实材质）**——两者不是同一个量级，
所以"推流画面比网页地图糊"是**架构差异**，调参解决不了。

### 12.2 已搭建的管线（全部实测）

```
Xvfb :99 (1920x1080x24, -ac 无鉴权)        ← systemd: xvfb.service
   └─ Chrome --kiosk (prismarine-viewer 页面) ← systemd: mcviewer.service
        └─ 窗口 "Prismarine Viewer" 1919x1079+0+0
             └─ ffmpeg -f x11grab → libx264 → RTMP → B站
```

| 组件 | 状态 | 证据 |
|---|---|---|
| NVIDIA 驱动 | ✅ 装好但**未加载** | `nvidia-driver-580` + `nvidia-dkms-580`，`dkms status: installed` |
| Xvfb | ✅ systemd 常驻 | `:99` 1920x1080x24，`xdpyinfo` 正常 |
| Chrome | ✅ 154.0.8037.97 | kiosk 窗口出现在 `:99`（`xwininfo` 可见） |
| WebGL | ✅ 真实渲染 | `ANGLE (Mesa, llvmpipe ...) OpenGL 4.5` |
| **viewer 帧率** | ✅ **28~44fps** | CDP 实测 `requestAnimationFrame`：43.7fps / 28.2fps（软件光栅化） |
| **端到端推流** | ✅ **1920x1080@30fps** | 本地 RTMP 接收端收到 2.01MB、25 秒、H.264 |
| 画面内容 | ✅ 真 3D | 截图可见方块**真实材质**（工作台/草/树/花）、HUD 正常 |

**抓屏方式**：`ffmpeg -f x11grab -video_size 1920x1080 -i :99`（`-ac` 让抓屏不需要 Xauthority）

### 12.3 卡点：Secure Boot 拒绝未登记的内核模块

```
modprobe: ERROR: could not insert 'nvidia': Key was rejected by service
SecureBoot enabled
```

模块**已签名**（DKMS 生成 `CN = tzd Secure Boot Module Signature key`），但这把 MOK **未登记进 UEFI**。
未加载驱动的后果：WebGL 退回 SwiftShader/llvmpipe 软件渲染，**Chrome 吃 455% CPU**（4.5 核）才换来 28fps。

**解除方式（二选一，都需要人在笔记本前操作一次）**：

- **A. BIOS 关掉 Secure Boot**：重启狂按 F2 → Security → Secure Boot → Disabled → 保存
- **B. 登记 MOK**（保留 Secure Boot）：
  ```bash
  sudo mokutil --import /var/lib/shim-signed/mok/MOK.der   # 设一个一次性密码
  sudo reboot
  # 开机自动进蓝色 MOK Manager：Enroll MOK → Continue → 输密码 → Reboot
  ```

### 12.4 踩坑记录（本轮新增）

1. **`dpkg` 卡在 `needrestart`**：Ubuntu 经典挂起。装大包要 `NEEDRESTART_MODE=l` + `DEBIAN_FRONTEND=noninteractive`。
   我还误判成"编译挂起"而杀了父 dpkg，导致 debconf 变成孤儿进程挂在坏管道上（`fd 0 -> pipe`、`fd 1 -> (deleted)`）。
2. **`systemctl reboot` 报 "already a shutdown in progress"**：之前某次 reboot 留下了挂起计划；
   `shutdown -c` 取消 + 杀掉 `unattended-upgrade-shutdown --wait-for-signal` 后才能重启。
3. **systemd 的 `Environment=DISPLAY=:99` 实测不生效**（`systemctl show -p Environment` 为空），
   Chrome 一直报 `Missing X server or $DISPLAY`。**改用包装脚本里 export**（`/usr/local/bin/mc-viewer-launch.sh`）解决。
4. **`scp` + 长链 `ssh 'cmd1 && cmd2'` 容易整体超时**，导致"以为装了其实没装"（单元文件版本对不上，排查了很久）。
   教训：**分步执行**，每步单独确认退出码。
5. **`setsid nohup ... &` 在 SSH 非交互会话里仍会被杀**：测试脚本要写成"后台跑 + 轮询读结果"，别在同一个 SSH 命令里等它。
6. **`--cam-name` 进不了服**：白名单只放行 `DeepSeek`/`DeepSeekCam`，用别的名字会被踢
   （`You are not whitelisted`），同名又会 `duplicate_login`。已加白名单账号 `BenchCam`（离线 UUID `1c69dd3d-7a27-384f-bad5-aad83f29c139`）备用。

### 12.5 ⚠️ 重要发现：GPU 驱动未加载时，viewer 与 CPU 推流抢 CPU

在软件渲染（llvmpipe）下同时跑 viewer 和 CPU 投射推流，两者抢 CPU 导致**直播崩到 3.8fps（丢 2710 帧）**：

```
[16:06:33] ▶ 1436 帧（丢 2710）实测 3.8fps  耗时: 投射 203ms + 合成 55ms   ← 被 viewer 抢 CPU
[16:06:48] ▶ 1474 帧（丢 2752）实测 12.5fps 耗时: 投射 74ms               ← 停掉 viewer 后恢复
```

CPU 分布（8 核）：
- viewer（Chrome 软渲染）：**455%**（4.5 核）
- CPU 投射推流（node）：100%（1 核）
- MC 服务端（java）：23%

**结论**：
- **GPU 驱动加载前**：viewer 和 CPU 推流**不能同时跑**（会互相饿死）。当前 `mcviewer` 保持 `disabled` 且已停止，直播用原 CPU 投射版（720p/800x450/15fps）。
- **GPU 驱动加载后**：Chrome 的渲染搬到 GPU，CPU 占用预期大幅下降，届时两者可共存，
  再把推流切到 X11 抓屏版（`ffmpeg -f x11grab -i :99 → RTMP`）。

**切换步骤（MOK 登记完、驱动加载后执行）**：
```bash
# 1) 验证 GPU 已加载
nvidia-smi -L && glxinfo -B | grep -i "OpenGL renderer"   # 应显示 NVIDIA，而不是 llvmpipe

# 2) 起 viewer
sudo systemctl enable --now mcviewer

# 3) 停掉 CPU 投射推流，改用抓屏推流（两者二选一，别同时跑）
sudo systemctl stop mcstream
# 抓屏推流命令（串流码从 stream.env 读）：
#   DISPLAY=:99 ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :99 \
#     -c:v libx264 -preset veryfast -tune zerolatency -b:v 6000k -g 60 -pix_fmt yuv420p \
#     -f flv "$RTMP_URL"
```

---

## 13. 已切换：推流改用 prismarine-viewer 管线（1080p@30，真 3D）

**关键认识**：即使 GPU 驱动还没加载（Secure Boot 卡着），软件渲染下 viewer 独占 CPU 时也能跑到 **91.6fps @ 1920x1080**——
比旧的 CPU 体素投射器（12fps）好太多。所以**不必等 GPU 就能达成目标画质**。

### 13.1 新的推流链路（已上线）

```
Xvfb :99 (1920x1080x24)
  └─ Chrome kiosk → prismarine-viewer 页面      ← mcviewer.service
       └─ ffmpeg -f x11grab → libx264 → B站 RTMP ← mccapture.service
```

| 服务 | 作用 | 状态 |
|---|---|---|
| `xvfb.service` | 虚拟显示 :99 | enabled |
| `mcviewer.service` | Chrome kiosk 开 viewer 页面 | **enabled**（开机自启） |
| `mccapture.service` | 抓屏 → x264 → RTMP | **enabled**（开机自启） |
| `mcstream.service` | 旧 CPU 体素投射推流 | **disabled**（与 mccapture 互斥，`Conflicts=`） |

### 13.2 实测对比

| | 旧（CPU 体素投射） | 新（prismarine-viewer） |
|---|---|---|
| 分辨率 | 1280x720 | **1920x1080** |
| 帧率 | 12~15fps | **30fps**（viewer 自身可达 91.6fps） |
| 画面 | 纯色 + 抖动假贴图 | **真实方块材质 + 真 3D** |
| 原画档标签 | 720P 原画 | **1080P 原画** |
| CPU | node 100%（1 核） | Chrome 510% + ffmpeg 197%（约 7 核） |

> ⚠️ 代价：软渲染把 CPU 吃得比较满（8 核用了约 7 核）。**加载 GPU 驱动后 Chrome 的占用会大幅下降**，
> 这也是仍然值得完成 MOK 登记的原因。

### 13.3 验证证据

```
观众侧拉流（ffprobe）: width=1920 height=1080 r_frame_rate=30/1 codec=h264 profile=High
B站原画档标签        : 1080P 原画
画面截图            : 真 3D 石材质感 + HUD，与 /mc/ 一致
本地端到端（20 秒）  : 590 帧 / 30fps / 5029 kbps / 收到 11.99 MB
```

### 13.4 切换/回滚

```bash
# 切到新管线（viewer + 抓屏）
sudo systemctl stop mcstream
sudo systemctl start mccapture          # 会自动拉起 xvfb/mcviewer 依赖

# 回滚到旧 CPU 投射
sudo systemctl stop mccapture
sudo systemctl start mcstream
```

画质参数在 `mccapture.service` 的 Environment 里：
`MC_CAPTURE_FPS=30`、`MC_CAPTURE_SIZE=1920x1080`、`MC_CAPTURE_BITRATE=6000k`。

---

## 14. 【成功】迁移到联想 80N8 笔记本（GPU 全链路打通）

前一台（1650 笔记本）最终失败：Secure Boot 开着一晚没解开，且 GPU 拿不到。本机 **80N8（i7-4720HQ / 15G / GTX 960M）** 一次性打通。

### 14.1 为什么这台成了

| | 前一台 1650 | **80N8** |
|---|---|---|
| Secure Boot | ✅ 开着 → 驱动被拒载（`Key was rejected`） | ❌ **已关** → 驱动直接可用 |
| 驱动加载 | 需 MOK 登记（要接显示器 + UEFI 界面） | ✅ 装完重启即生效 |
| NVENC | ❌ TU117 阉割，只能软编 | ✅ **可用**（实测编码成功） |
| GPU 渲染 | ❌ 只能 llvmpipe 软渲 | ✅ **Xorg + NVIDIA 虚拟屏** |

**根因就一条：Secure Boot。** 开着就永远拿不到 GPU。

### 14.2 关键技术突破：NVIDIA 加速的虚拟显示

Xvfb **不支持** NVIDIA 驱动（GLX 永远是 Mesa/llvmpipe）。解法是**用 Xorg + NVIDIA + 虚拟显示**：

```ini
# /etc/X11/xorg-nvidia.conf
Section "Device"
    Identifier "nvidia0"
    Driver     "nvidia"
    BusID      "PCI:1:0:0"
    Option "ConnectedMonitor" "DFP-0"
    Option "UseDisplayDevice" "none"          # 关键：不需要真实显示器
    Option "ModeValidation" "NoVesaModes,NoXServerModes,NoVertRefreshCheck,NoHorizSyncCheck,AllowNonEdidModes"
    Option "AllowEmptyInitialConfiguration" "true"
EndSection
Section "Screen"
    ...
    SubSection "Display"
        Depth 24
        Modes "1920x1080"
        Virtual 1920 1080
    EndSubSection
EndSection
```

用 systemd 跑：`Xorg :99 -config /etc/X11/xorg-nvidia.conf -noreset -novtswitch`

结果：
```
OpenGL vendor string:   NVIDIA Corporation
OpenGL renderer string: NVIDIA GeForce GTX 960M/PCIe/SSE2
```

### 14.3 性能对比（这就是"能不能用 GPU"的答案）

| 指标 | 前一台（软渲+软编） | **80N8（GPU 渲+NVENC 编）** |
|---|---|---|
| viewer 渲染帧率 | 43 fps（llvmpipe） | **1109 fps**（NVIDIA） |
| 渲染 CPU | chrome **460%** | chrome **~85%** |
| 编码 | libx264 **183% CPU** | **NVENC（GPU 编码器 9%）** |
| 总 CPU | **~643%**（load 12.9） | **~200%**（load 2.0） |
| 温度 | 接近 100°C | **62°C** |
| 直播画质 | 1080p30（勉强） | **1080p30 稳定** |

### 14.4 一个关键教训：**viewer 必须限速**

虚拟屏没有刷新率概念，Chrome 的 `requestAnimationFrame` 会**跑到 1100+ fps** ——
而推流只需要 30fps，**97% 的渲染是纯浪费**，全部变成热量：

| | 限速前 | 限速后 |
|---|---|---|
| CPU 温度 | **89°C** ⚠️ | **62°C** |
| GPU 温度 | 89°C | **53°C** |
| GPU 利用率 | 81% | 17% |

**解法**：用 CDP 在页面加载前注入 rAF 限速（`/usr/local/bin/cap-fps.mjs`，
由 viewer 启动器自动调用，见 `launch80n8.sh`）。

### 14.5 最终服务清单（全部 enabled + 开机自启）

| 服务 | 作用 |
|---|---|
| `wg-quick@wg0` | WireGuard 隧道（10.8.0.3） |
| `ssh` | 远程管理 |
| `xorg-nvidia` | **NVIDIA 虚拟显示 :99**（GPU 渲染基础） |
| `mcserver` | Paper 1.20.4 服务端 |
| `mcbot` | mineflayer bot（里程碑推进 + viewer） |
| `mcviewer` | Chrome kiosk 打开 viewer（GPU 渲染 + rAF 限速） |
| `mccapture` | 抓屏 → **NVENC** → B站 RTMP |
| `mcsync` | 状态镜像到服务器（供 qq-bridge 读） |
| `thermal-guard` | 温度看门狗（>85°C 停推流） |
| `battery-conservation` | 联想养护模式（充电上限 ~60%） |

### 14.6 电源/散热加固（按用户要求）

| 需求 | 实现 |
|---|---|
| 合盖不休眠 | `/etc/systemd/logind.conf.d/10-lid-ignore.conf`（三条规则全 ignore） |
| 禁止自动挂起 | `sleep/suspend/hibernate/hybrid-sleep.target` 全 masked |
| 温度/风扇 | ⚠️ **风扇无法控制**（EC 不暴露 pwm），改用：**RAPL 功耗墙 35W**（`thermal-profile.sh`）+ **温度看门狗** + **rAF 限速** |
| 电池寿命 | `conservation_mode=1`（联想养护模式，上限 ~60%） |

### 14.7 双机并存配置

服务端同时接受两台（详见第 12 节）：
- tzd（旧机，可能复活）→ `10.8.0.2`
- **80N8（在用）→ `10.8.0.3`**

端口桥（25565/3200）指向当前在用的 80N8。要切回 tzd 只需把 `/etc/systemd/system/mc-*-proxy.{service,socket}` 里的 `10.8.0.3` 改回 `10.8.0.2` 并重启那两个 socket。

### 14.8 排障：直播间出现"紫色方块"

**现象**：直播画面里有洋红色（品红）色块。

**根因**：洋红 `RGB(255,0,255)` 是 Minecraft 标准的"**缺失材质**"占位色。
在 prismarine-viewer 里，它表示**该位置没有区块数据可渲染**，通常出现在视野边缘。

具体是**视距配置不匹配**：

| 项 | 值 | 说明 |
|---|---|---|
| `mcbot.service` 的 `VIEWER_DIST` | **2 区块** | token 为了省内存设的（旧机器只有 1.6G） |
| 服务端 `view-distance` | 4 区块 | Paper 渲染距离 |
| 服务端 `simulation-distance` | 3 区块 | |

viewer 只渲染 2 区块内 → 超出部分无数据 → 洋红占位。

**修法**（有了 GPU 后视距可以放心调大）：
```ini
# /etc/systemd/system/mcbot.service
Environment=VIEWER_DIST=8          # 原为 2
Environment=BOT_VIEW_DISTANCE=8    # 让 bot 自身也请求更多区块
```
```bash
sudo systemctl daemon-reload && sudo systemctl restart mcbot
```

**验证**（用像素扫描，客观可复现）：
```
修复前: 洋红像素 ~17（采样）, 区域 x872~1354 y236~688（画面右上远景）
修复后: 洋红像素 0
```
扫描脚本：`/tmp/scan-magenta.py`（判据 `r>150 && b>150 && g<100`）

**性能影响**（视距 2→8 之后）：CPU 69°C、负载 ~1.5、内存 5.5G/15G —— 几乎无压力，
因为渲染已走 GPU（GPU 利用率仅个位数%）。

> 教训：旧机器上为省内存把 `VIEWER_DIST` 压到 2，迁到 GPU 机器后忘了调回来，
> 于是出现"紫色方块"。**这类"以前为了省资源做的妥协"，迁移后要复查一遍。**
