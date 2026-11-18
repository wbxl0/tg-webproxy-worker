# Telegram WEB Proxy on Cloudflare Workers

把 Telegram 桌面端 / 安卓端的 **WEB 代理**（tdesktop web-proxy 协议）中继跑在单个 Cloudflare Worker 上，零依赖、零构建。

- 协议实现来自 [ToiCF/CF-Workers-TGProxy](https://github.com/ToiCF/CF-Workers-TGProxy)（MIT）
- 本仓库在上游基础上补了**稳定性修复**和**诊断手段**，见下文「相对上游的改动」
- 客户端只需要填「服务器地址 + 密钥」，不需要端口

## 文件

```
telegram_webproxy.js        主程序：单文件 ES module，export default { fetch }
wrangler.toml               部署配置（域名/zone 改成你自己的）
scripts/tgproxy_probe.mjs   端到端自检：health → bridge → session → lane → Telegram 往返
scripts/dc_matrix.mjs       逐 DC 探测：DC1–5 × 普通/媒体 共 10 条 lane
scripts/load_probe.mjs      并发压力探测：一次开 N 条 lane，看是否互相踩
```

## 部署

### 1. 准备密钥

```bash
SECRET=$(openssl rand -hex 16)   # 32 位小写十六进制，客户端要填这个
BOOT=$(openssl rand -hex 24)     # 只用于签发页面 bootstrap/session token，不对外
```

### 2. 改 `wrangler.toml`

```toml
name = "tg-webproxy"
main = "telegram_webproxy.js"
compatibility_date = "2026-03-01"
workers_dev = true
routes = [{ pattern = "tg.example.com/*", zone_name = "example.com" }]
```

`compatibility_date` **不要晚于 2026-03-01**，原因见「兼容性」。

### 3. 部署并写入 secret

```bash
export CLOUDFLARE_API_TOKEN=...      # 需要 Workers Scripts:Edit + 该 zone 的 Workers Routes:Edit
export CLOUDFLARE_ACCOUNT_ID=...
CI=true wrangler deploy

printf '%s' "$SECRET" | wrangler secret put SECRET
printf '%s' "$BOOT"   | wrangler secret put BOOT
wrangler secret list        # 两个都应该在
```

### 4. 客户端配置

Telegram → 设置 → 数据和存储 → 代理 → **WEB 代理**（不是 MTProto / SOCKS5）：

- 服务器：`tg.example.com`
- 密钥：上一步的 `SECRET`

一键链接：`https://t.me/webproxy?server=tg.example.com&secret=<SECRET>`

客户端会自己用 `HMAC-SHA256(SECRET, "tdesktop-web-proxy-bridge-v1\n<host>")` 推 bridge 值，
`SECRET` 本身不会出现在任何 URL 里。

## 验证

不需要装 Telegram 客户端：

```bash
# 单轮 / 三轮
HOST=tg.example.com SECRET=<32hex> node scripts/tgproxy_probe.mjs
HOST=tg.example.com SECRET=<32hex> ROUNDS=3 node scripts/tgproxy_probe.mjs

# 逐 DC（DC1–5 × 普通/媒体）
HOST=tg.example.com SECRET=<32hex> node scripts/dc_matrix.mjs

# 并发 N 条 lane
HOST=tg.example.com SECRET=<32hex> N=14 node scripts/load_probe.mjs
```

判据是最后一行 `RESULT PASS` 与 `TG RTT`（Telegram 往返 600–1000ms 属正常）。
`/health` 200 只能说明 Worker 活着，**不能**说明它出得了网到 `kws*.web.telegram.org`。

## 相对上游的改动（2026-11）

1. **桥接页 `fail()` 不再全局生效**。上游版本里任意一条 lane 出错（WS 没打开、帧校验失败、队列超限）
   都会关掉全部 lane、删除 session、通知客户端断开——表现是"点开大图/下载文件，整个 Telegram 转圈重连"。
   现在：
   - lane WS 未打开时先退避重试 2 次（150ms / 300ms）
   - 队列超限（全局 32MB / 单 lane 8MB / 1024 帧）只结束该 lane，让客户端换一条重开
   - 重复 sid / 未知 lane / 非法帧只记诊断，不炸会话
2. **`/api/v1/diag` 诊断端点**。页面在 `fail()` 时上报 `e`（原因）、`q`（队列字节）、`i`（帧数）、`n`（lane 数），
   Worker 侧 `console.log('DIAG ...')`，`wrangler tail` 里直接可见。
3. **lane 关闭日志**：每条 lane 结束时打印 `LN close sid=<id> code=<close code> ms=<存活> up=<上行> dn=<下行>`，
   用来区分 `1000`（对端正常关）和 `1005`（没收到关闭帧，被中间层掐断）。

### 观察到的现象与判读

```
wrangler tail <worker-name> --format json | jq -c 'select(.logs)'
```

- `code=1000` 且存活 ~16s / ~125s：客户端自己的连接轮换，正常
- 同一时刻多条 lane 一起 `code=1005`，且 Worker 侧 `outcome=ok`、`cpuTime` 很小：不是 Worker 抛错，
  是这批连接所在的执行环境被回收，或客户端到 CF 的链路瞬断；客户端会自动重连
- 部署新版本会让旧版本上的 WebSocket 全部断开一次，排期时避开正在使用的时段

## 兼容性

`compatibility_date` 必须 ≤ `2026-03-01`：

- `2026-03-17` 起 `websocket_standard_binary_type` 默认开启，出站 WebSocket 的 `binaryType` 变 `blob`
- `2026-04-07` 起 `web_socket_auto_reply_to_close` 默认开启，对端 Close 帧会被运行时自动回复

这个中继按老语义（`arraybuffer` + 手动 close）实现，用新日期部署会在第一个加密头之后立刻收到
`END` / close `1000`。

## 安全提醒

- `SECRET` 泄露等于代理被白用，轮换方式：`wrangler secret put SECRET` 后所有客户端改密钥
- 不要把 Cloudflare 账号 ID、邮箱、真实域名、token 提交进仓库
- 该 Worker 用普通 Workers 承载 WebSocket，不保证连接长命，客户端重连属预期行为

## License

MIT，见 [LICENSE](LICENSE)。上游版权归 ToiCF/CF-Workers-TGProxy 作者所有。
