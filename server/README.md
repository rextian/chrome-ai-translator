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

设置页 →「账号与云同步」：
- 服务器：`https://sync.rextian.com`（已预填）
- 注册用户名 + 密码（≥8 位）→ 自动上传当前配置
- 其他设备安装插件后登录同一账号 → 自动拉取云端配置

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/register` | 注册 `{username, password}` → `{token}` |
| POST | `/api/login` | 登录 → `{token}` |
| POST | `/api/logout` | 注销 token（Bearer） |
| GET | `/api/config` | 拉取配置（Bearer）→ `{ciphertext, updatedAt}` |
| PUT | `/api/config` | 上传配置（Bearer）`{ciphertext, updatedAt}` |

## 备注

- 若只想自己/小范围使用，设置 `INVITE_CODE` 环境变量后，注册必须携带该邀请码，防止公开注册被滥用
- 数据库备份：直接拷贝 `sync_data/` 目录即可（WAL 模式建议先 `sqlite3 sync.db ".backup backup.db"`）
