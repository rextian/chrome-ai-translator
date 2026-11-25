#!/usr/bin/env python3
"""
AI 实时翻译助手 · 配置云同步服务端
单文件 · Python 标准库 · SQLite · 零第三方依赖

运行：python3 sync_server.py --host 127.0.0.1 --port 8000
生产：nginx 反代 + HTTPS（见 server/README.md）

安全模型：
- 密码 PBKDF2-HMAC-SHA256（10 万轮，随机盐）存储，不存明文
- token 随机 256bit，数据库只存 SHA256 哈希，30 天滑动过期
- 配置内容在客户端已端到端加密（E2E），服务端只存密文，无法读取用户的 API Key
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sync_data')
DB_PATH = os.path.join(DATA_DIR, 'sync.db')
PBKDF2_ITERATIONS = 100_000
TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 天
MAX_BODY_BYTES = 256 * 1024
INVITE_CODE = os.environ.get('INVITE_CODE', '')  # 可选：设置后注册需携带邀请码

# ---------------- REXTIAN SSO（OAuth 授权码模式）配置 ----------------
# client_secret 仅存在于此服务端，绝不下发到插件客户端
SSO_TOKEN_URL = os.environ.get('SSO_TOKEN_URL', 'https://sso.rextian.com/oauth/token.php')
SSO_USERINFO_URL = os.environ.get('SSO_USERINFO_URL', 'https://sso.rextian.com/oauth/userinfo.php')
SSO_CLIENT_ID = os.environ.get('SSO_CLIENT_ID', 'client_6ffc31c8d2983e52')
SSO_CLIENT_SECRET = os.environ.get('SSO_CLIENT_SECRET', '')  # 生产环境通过环境变量配置


def sso_exchange_code(code):
    """授权码 → access_token → 用户信息。失败抛 ValueError。"""
    if not SSO_CLIENT_SECRET:
        raise ValueError('sso_not_configured')
    form = urllib.parse.urlencode({
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': SSO_CLIENT_ID,
        'client_secret': SSO_CLIENT_SECRET,
    }).encode('utf-8')
    try:
        req = urllib.request.Request(SSO_TOKEN_URL, data=form)
        with urllib.request.urlopen(req, timeout=12) as resp:
            token_data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        raise ValueError('sso_token_failed: ' + str(e))
    access_token = token_data.get('access_token')
    if not access_token:
        raise ValueError('sso_token_failed: ' + json.dumps(token_data)[:200])

    try:
        req = urllib.request.Request(SSO_USERINFO_URL, headers={'Authorization': 'Bearer ' + access_token})
        with urllib.request.urlopen(req, timeout=12) as resp:
            user = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        raise ValueError('sso_userinfo_failed: ' + str(e))
    return user


def now_ts():
    return int(time.time())


def pbkdf2_hash(password, salt=None):
    if salt is None:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ITERATIONS)
    return base64.b64encode(salt).decode(), base64.b64encode(dk).decode()


def token_hash(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


class DB:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL,
                pw_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )''')
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS tokens (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            )''')
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS configs (
                user_id INTEGER PRIMARY KEY,
                ciphertext TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )''')
        self.conn.commit()

    def create_user(self, username, password):
        salt, pw_hash = pbkdf2_hash(password)
        cur = self.conn.execute(
            'INSERT INTO users (username, salt, pw_hash, created_at) VALUES (?,?,?,?)',
            (username, salt, pw_hash, now_ts()))
        self.conn.commit()
        return cur.lastrowid

    def find_or_create_sso_user(self, username):
        """SSO 用户：存在则返回 id，不存在则创建（无本地密码，随机占位哈希）"""
        row = self.conn.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()
        if row:
            return row[0]
        salt, pw_hash = pbkdf2_hash(secrets.token_hex(16))
        cur = self.conn.execute(
            'INSERT INTO users (username, salt, pw_hash, created_at) VALUES (?,?,?,?)',
            (username, salt, pw_hash, now_ts()))
        self.conn.commit()
        return cur.lastrowid

    def verify_user(self, username, password):
        row = self.conn.execute(
            'SELECT id, salt, pw_hash FROM users WHERE username=?', (username,)).fetchone()
        if not row:
            return None
        user_id, salt, pw_hash = row
        _, candidate = pbkdf2_hash(password, base64.b64decode(salt))
        if secrets.compare_digest(candidate, pw_hash):
            return user_id
        return None

    def issue_token(self, user_id):
        token = secrets.token_hex(32)
        self.conn.execute(
            'INSERT INTO tokens (token_hash, user_id, expires_at) VALUES (?,?,?)',
            (token_hash(token), user_id, now_ts() + TOKEN_TTL_SECONDS))
        self.conn.commit()
        return token

    def user_for_token(self, token):
        row = self.conn.execute(
            'SELECT user_id, expires_at FROM tokens WHERE token_hash=?',
            (token_hash(token),)).fetchone()
        if not row or row[1] < now_ts():
            return None
        # 滑动续期
        self.conn.execute('UPDATE tokens SET expires_at=? WHERE token_hash=?',
                          (now_ts() + TOKEN_TTL_SECONDS, token_hash(token)))
        self.conn.commit()
        return row[0]

    def revoke_token(self, token):
        self.conn.execute('DELETE FROM tokens WHERE token_hash=?', (token_hash(token),))
        self.conn.commit()

    def get_config(self, user_id):
        return self.conn.execute(
            'SELECT ciphertext, updated_at FROM configs WHERE user_id=?', (user_id,)).fetchone()

    def put_config(self, user_id, ciphertext, updated_at):
        self.conn.execute(
            '''INSERT INTO configs (user_id, ciphertext, updated_at) VALUES (?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,
               updated_at=excluded.updated_at''',
            (user_id, ciphertext, updated_at))
        self.conn.commit()


class Handler(BaseHTTPRequestHandler):
    server_version = 'AiTrSync/1.0'

    # ---------- 基础工具 ----------
    def log_message(self, fmt, *args):
        print(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {self.address_string()} {fmt % args}')

    def send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return None

    def bearer_user(self):
        auth = self.headers.get('Authorization') or ''
        if not auth.startswith('Bearer '):
            return None
        return self.server.db.user_for_token(auth[7:].strip())

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/health':
            self.send_json(200, {'ok': True, 'time': now_ts()})
            return
        if path == '/api/config':
            user_id = self.bearer_user()
            if not user_id:
                self.send_json(401, {'error': 'unauthorized'})
                return
            row = self.server.db.get_config(user_id)
            if not row:
                self.send_json(404, {'error': 'not_found'})
                return
            self.send_json(200, {'ciphertext': row[0], 'updatedAt': row[1]})
            return
        self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/logout':
            auth = self.headers.get('Authorization') or ''
            if auth.startswith('Bearer '):
                self.server.db.revoke_token(auth[7:].strip())
            self.send_json(200, {'ok': True})
            return

        # SSO 授权码换同步 token（client_secret 仅在本服务端使用）
        if path == '/api/sso/exchange':
            data = self.read_body()
            code = str((data or {}).get('code') or '').strip()
            if not code:
                self.send_json(400, {'error': 'bad_request'})
                return
            try:
                user = sso_exchange_code(code)
            except ValueError as e:
                self.send_json(401, {'error': str(e)})
                return
            username = str(user.get('username') or user.get('name') or user.get('sub') or user.get('id') or '').strip()
            if not username:
                self.send_json(400, {'error': 'sso_userinfo_no_username'})
                return
            user_id = self.server.db.find_or_create_sso_user(username)
            token = self.server.db.issue_token(user_id)
            self.send_json(200, {'token': token, 'username': username})
            return

        if path not in ('/api/register', '/api/login'):
            self.send_json(404, {'error': 'not_found'})
            return

        data = self.read_body()
        if not data:
            self.send_json(400, {'error': 'bad_request'})
            return
        username = str(data.get('username') or '').strip()
        password = str(data.get('password') or '')

        if not re.fullmatch(r'[A-Za-z0-9_.-]{3,32}', username) or len(password) < 8:
            self.send_json(400, {'error': 'invalid_credentials_format',
                                 'message': 'username 3-32 chars [A-Za-z0-9_.-], password >= 8 chars'})
            return

        if path == '/api/register':
            if INVITE_CODE and data.get('inviteCode') != INVITE_CODE:
                self.send_json(403, {'error': 'invalid_invite_code'})
                return
            try:
                user_id = self.server.db.create_user(username, password)
            except sqlite3.IntegrityError:
                self.send_json(409, {'error': 'username_taken'})
                return
            token = self.server.db.issue_token(user_id)
            self.send_json(200, {'token': token, 'username': username})
            return

        # /api/login
        user_id = self.server.db.verify_user(username, password)
        if not user_id:
            self.send_json(401, {'error': 'wrong_username_or_password'})
            return
        token = self.server.db.issue_token(user_id)
        self.send_json(200, {'token': token, 'username': username})

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != '/api/config':
            self.send_json(404, {'error': 'not_found'})
            return
        user_id = self.bearer_user()
        if not user_id:
            self.send_json(401, {'error': 'unauthorized'})
            return
        data = self.read_body()
        if not data or not isinstance(data.get('ciphertext'), str):
            self.send_json(400, {'error': 'bad_request'})
            return
        updated_at = int(data.get('updatedAt') or now_ts())
        self.server.db.put_config(user_id, data['ciphertext'], updated_at)
        self.send_json(200, {'ok': True, 'updatedAt': updated_at})


def main():
    parser = argparse.ArgumentParser(description='AI Translator config sync server')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()

    db = DB(DB_PATH)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.db = db
    print(f'Sync server listening on http://{args.host}:{args.port}  (db: {DB_PATH})')
    if INVITE_CODE:
        print('Registration requires INVITE_CODE.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nshutting down')
        server.shutdown()


if __name__ == '__main__':
    main()
