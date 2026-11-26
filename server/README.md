# 配置云同步服务端 · 部署指南

单文件 Python 标准库实现，零第三方依赖，SQLite 存储。插件设置页的「账号与云同步」对接此服务。

## 安全模型

- 密码：PBKDF2-HMAC-SHA256（10 万轮，随机盐）存储，不存明文
- token：随机 256bit，数据库只存 SHA256 哈希，30 天滑动过期
- **配置端到端加密（E2E）**：插件在本地用「密码 + 用户名」派生 AES-256-GCM 密钥加密后上传，**服务端只存密文，无法读取用户的 API Key**

## 1. 运行（本地 / 测试）

```bash
python3 sync_server.py --host 127.0.0.1 --port 8000
```

数据库自动创建于 `./sync_data/sync.db`。

## 2. 生产部署（nginx 反代 + HTTPS）

把 `sync_server.py` 上传到服务器（如 `/opt/ai-tr-sync/`），然后：

### systemd 服务 `/etc/systemd/system/ai-tr-sync.service`

```ini
[Unit]
Description=AI Translator Config Sync
After=network.target

[Service]
WorkingDirectory=/opt/ai-tr-sync
ExecStart=/usr/bin/python3 /opt/ai-tr-sync/sync_server.py --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3
# 可选：注册需要邀请码
# Environment=INVITE_CODE=your-secret-code

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-tr-sync
```

### nginx 站点（sync.rextian.com）

```nginx
server {
    listen 443 ssl;
    server_name sync.rextian.com;

    ssl_certificate     /etc/letsencrypt/live/sync.rextian.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.rextian.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

HTTPS 证书可用 certbot 免费签发：`sudo certbot --nginx -d sync.rextian.com`

## 3. 插件端配置

当前插件不再要求填写服务器地址：
- 身份认证与配置存储固定使用 `https://sso.rextian.com`
- 用户在网页完成注册，返回插件输入邮箱/用户名和密码登录
- 账号返回 `mfa_required` 时，插件会要求输入 6 位验证码，并通过 `mfa_code` 再次提交
- 配置使用登录密码派生加密密钥，登录后自动上传或拉取配置

本目录的 Python 服务是早期独立 token 体系的参考实现，不是当前插件默认的 `sso.rextian.com` 后台。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/register` | 注册 `{username, password}` → `{token}` |
| POST | `/api/login` | 登录 → `{token}` |
| POST | `/api/logout` | 注销 token（Bearer） |
| GET | `/api/config` | 拉取配置（Bearer）→ `{ciphertext, updatedAt}` |
| PUT | `/api/config` | 上传配置（Bearer）`{ciphertext, updatedAt}` |

## 4. REXTIAN SSO exchange（旧版参考接口）

当前插件在后台使用 `oauth/token.php` 的密码模式（按需附加 `mfa_code`），不调用本服务的 `/api/sso/exchange`。以下配置仅适用于仍需使用该参考服务的旧版客户端：

```bash
SSO_CLIENT_ID=client_6ffc31c8d2983e52 \
SSO_CLIENT_SECRET=<在主站 OAuth 应用管理中复制的 Secret> \
SSO_TOKEN_URL=https://sso.rextian.com/oauth/token.php \
SSO_USERINFO_URL=https://sso.rextian.com/oauth/userinfo.php \
python3 sync_server.py --host 127.0.0.1 --port 8000
```

**安全要点**：`client_secret` 只配置在这个同步服务端（systemd 的 `Environment=` 或 shell 环境变量），**绝不写入插件代码或提交到公开仓库**。授权码交换（code → access_token → userinfo）全部在服务端完成。

流程：
1. 插件 `chrome.identity.launchWebAuthFlow` 打开 `oauth/authorize.php`（仅携带公开的 client_id）
2. 回调拿到授权码 code → 插件 POST 到本服务 `/api/sso/exchange`
3. 本服务用 secret 换 access_token、拉取用户信息，签发同步 token

SSO 登录的端到端加密：用户首次登录后需设置一个**独立「同步加密密码」**（与 SSO 密码无关），用于本地派生加密密钥——服务端仍无法解密配置。

## 备注

- 若只想自己/小范围使用，设置 `INVITE_CODE` 环境变量后，注册必须携带该邀请码，防止公开注册被滥用
- 数据库备份：直接拷贝 `sync_data/` 目录即可（WAL 模式建议先 `sqlite3 sync.db ".backup backup.db"`）
