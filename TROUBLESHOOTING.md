# OpenClaw + E-Claw Docker 排錯指南

## 環境資訊

| 項目 | 版本 |
|------|------|
| OpenClaw | 2026.3.23 |
| E-Claw Plugin (`@eclaw/openclaw-channel`) | 1.2.6（修復後） |
| Docker Image | `ghcr.io/openclaw/openclaw:latest` |
| Node.js（容器內） | v24.14.0 |
| Docker | 29.3.0 |
| Host OS | macOS ARM64 (Darwin 25.3.0) |
| Cloudflare Tunnel | `cloudflare/cloudflared:latest`（獨立容器） |

## 目錄結構

```
openclaw-docker/
├── docker-compose.yml
├── project-a/
│   ├── config/          # 映射到容器 /home/node/.openclaw/
│   │   └── openclaw.json
│   └── workspace/       # 映射到容器 /home/node/.openclaw/workspace/
└── project-b/
    ├── config/
    └── workspace/
```

## 常用指令

```bash
# 查看狀態
docker exec openclaw-project-a openclaw status

# 查看 log
docker logs openclaw-project-a --tail 50
docker exec openclaw-project-a tail -50 /tmp/openclaw/openclaw-2026-03-24.log

# 進入容器
docker exec -it openclaw-project-a sh

# 重啟 Gateway
docker restart openclaw-project-a

# 測試 webhook 是否通
docker exec openclaw-project-a curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://127.0.0.1:18789/eclaw-webhook \
  -H "Content-Type: application/json" -d '{"test":true}'
# 預期：200（正常）或 401/503（正常但無 token）
# 如果是 404 → webhook 路由沒註冊成功，見「坑 1」
```

---

## 踩坑紀錄

### 坑 1：Webhook 路由 404 — `auth` 聲明缺失

**症狀**：發訊息沒反應，log 裡完全沒有收訊記錄。啟動時出現：
```
[plugins] http route registration missing or invalid auth: /eclaw-webhook
```

**原因**：Plugin 的 `registerHttpRoute()` 必須聲明 `auth` 屬性，Gateway 只接受兩個值：
- `"gateway"` — 由 Gateway 驗證 token
- `"plugin"` — Plugin 自行處理認證

舊版 plugin 沒有設定 `auth`，Gateway 直接拒絕註冊路由，webhook endpoint 回傳 404。

**修復**：升級到 `@eclaw/openclaw-channel@1.2.6`+，該版本加了 `auth: 'plugin'`。

**手動修補**（如果無法升級 npm）：
```bash
docker exec openclaw-project-a sed -i \
  "s|path: '/eclaw-webhook',|path: '/eclaw-webhook', auth: 'plugin',|" \
  /home/node/.openclaw/extensions/openclaw-channel/dist/index.js
docker restart openclaw-project-a
```

**驗證**：
```bash
# 啟動 log 不應再出現 "missing or invalid auth"
docker logs openclaw-project-a 2>&1 | grep "invalid auth"

# webhook 應回傳非 404
docker exec openclaw-project-a curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://127.0.0.1:18789/eclaw-webhook \
  -H "Content-Type: application/json" -d '{}'
```

---

### 坑 2：Cloudflare Tunnel 斷線（502 Bad Gateway）

**症狀**：webhook 測試本地 OK（200），但從外部打 Cloudflare URL 回傳 502。

**原因**：Cloudflare Quick Tunnel 是臨時的，容器重啟後不會自動恢復。

**修復**：用獨立的 cloudflared 容器，並確保和 OpenClaw 容器在同一個 Docker network：

```bash
# 取得 OpenClaw 容器 IP
docker inspect openclaw-project-a --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# 例如：172.17.0.2

# 啟動 tunnel
docker run -d --name cloudflared-a --network bridge \
  cloudflare/cloudflared:latest tunnel --no-autoupdate \
  --url http://172.17.0.2:18789

# 取得新 URL
docker logs cloudflared-a 2>&1 | grep "trycloudflare.com"
```

拿到新 URL 後更新 `project-a/config/openclaw.json` 的 `webhookUrl`，然後重啟：
```bash
docker restart openclaw-project-a
```

**注意**：Quick Tunnel URL 每次重建都會變。如果需要固定 URL，考慮使用 Cloudflare Named Tunnel 或 Tailscale Funnel。

---

### 坑 3：Gateway bind 為 loopback，Tunnel 連不進來

**症狀**：cloudflared 和 OpenClaw 在不同容器，tunnel 一直 502。

**原因**：`gateway.bind` 預設為 `"loopback"`（只監聽 127.0.0.1），其他容器無法連線。

**修復**：將 `openclaw.json` 的 `gateway.bind` 改為 `"lan"`：
```json
{
  "gateway": {
    "bind": "lan"
  }
}
```

允許的值：`"auto"`, `"lan"`, `"loopback"`, `"custom"`, `"tailnet"`（不支援 `"all"` 或 `"none"`）。

---

### 坑 4：Anthropic API Key 找不到

**症狀**：第一則訊息收到 fallback 回覆，之後沒反應。Log 出現：
```
No API key found for provider "anthropic".
Auth store: /home/node/.openclaw/agents/main/agent/auth-profiles.json
```

**修復**：確認 auth-profiles.json 存在且有效：
```bash
docker exec openclaw-project-a cat \
  /home/node/.openclaw/agents/main/agent/auth-profiles.json
```

如果缺少，重新設定：
```bash
docker exec -it openclaw-project-a openclaw configure
```

---

### 坑 5：npm install 沒覆蓋 dist 檔案

**症狀**：npm install 新版 plugin 成功，但重啟後行為沒變。

**原因**：`npm install` 把新版放到 `node_modules/` 裡，沒覆蓋外層的 `dist/`。

**修復**：手動複製：
```bash
docker exec openclaw-project-a sh -c \
  "cp /home/node/.openclaw/extensions/openclaw-channel/node_modules/@eclaw/openclaw-channel/dist/* \
   /home/node/.openclaw/extensions/openclaw-channel/dist/"
docker restart openclaw-project-a
```

---

## 健康檢查清單

重啟或出問題時依序檢查：

1. **容器運行中？**
   ```bash
   docker ps --filter name=openclaw-project-a
   ```

2. **Gateway 啟動正常？**（無 error）
   ```bash
   docker logs openclaw-project-a --tail 20
   ```

3. **Plugin 載入成功？**（應看到 `[E-Claw] Account default ready!`）

4. **無 `invalid auth` 錯誤？**
   ```bash
   docker logs openclaw-project-a 2>&1 | grep "invalid auth"
   ```

5. **Webhook 路由回 200？**
   ```bash
   docker exec openclaw-project-a curl -s -o /dev/null -w "%{http_code}" \
     -X POST http://127.0.0.1:18789/eclaw-webhook \
     -H "Content-Type: application/json" -d '{}'
   ```

6. **Cloudflare Tunnel 活著？**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     "https://<your-tunnel>.trycloudflare.com/eclaw-webhook" \
     -X POST -H "Content-Type: application/json" -d '{}'
   ```

7. **API Key 有效？**（log 無 `No API key found`）
   ```bash
   docker logs openclaw-project-a 2>&1 | grep "No API key"
   ```

全部通過 → 從 E-Claw 平台發訊息測試。
