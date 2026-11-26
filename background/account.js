/**
 * 账号与云同步管理（直连 REXTIAN SSO）
 *
 * 身份认证全部直连 sso.rextian.com：
 *   登录 /oauth/token.php (grant_type=password，两步验证时附加 mfa_code)
 *   注册 /api/auth/register/send-code.php + register.php（邮箱验证码两步）
 *   刷新 /oauth/token.php (grant_type=refresh_token，旋转更新)
 *   注销 /oauth/revoke.php
 *
 * 配置存储固定走 sso.rextian.com：
 *   GET  /api/config.php?namespace=chrome-ai-translator   Bearer <access_token> → {ciphertext, updatedAt}
 *   PUT  /api/config.php   Bearer <access_token> {namespace, ciphertext, updatedAt}
 * 前端无需配置服务器地址，登录后自动同步。
 *
 * 安全说明：client_secret 从 background/sso-credentials.local.js 读取，
 * 该文件由 .gitignore 排除，不上传 GitHub；泄露时请在 SSO 后台「重置密钥」。
 */
import { deriveSyncKey, encryptSettings, decryptSettings } from '../lib/sync-crypto.js';

const SSO_BASE = 'https://sso.rextian.com';
const CONFIG_SERVER = SSO_BASE;
const CONFIG_NAMESPACE = 'chrome-ai-translator';
let CLIENT_ID = 'client_6ffc31c8d2983e52';
let CLIENT_SECRET = '';
const credentialsReady = import('./sso-credentials.local.js')
  .then((local) => {
    CLIENT_ID = local.CLIENT_ID || CLIENT_ID;
    CLIENT_SECRET = local.CLIENT_SECRET || CLIENT_SECRET;
  })
  .catch(() => { /* 未创建本地凭据文件时保持空 Secret */ });
const ACCOUNT_TYPES = [
  'ACCOUNT_REGISTER', 'ACCOUNT_LOGIN', 'ACCOUNT_LOGOUT', 'SYNC_NOW', 'GET_ACCOUNT_STATE',
  'SET_SYNC_PASSWORD', 'REGISTER_SEND_CODE'
];

export function createAccountManager({ getSettings, pushSettingsToStorage, tr }) {
  let uploadTimer = null;
  let suppressUntil = 0;

  async function getAccount() {
    const { account } = await chrome.storage.local.get('account');
    // 兼容旧版本地数据，但始终忽略用户此前填写的存储地址
    return account ? Object.assign({}, account, { configServer: CONFIG_SERVER }) : null;
  }

  async function saveAccount(account) {
    await chrome.storage.local.set({ account });
  }

  /* ---------------- SSO 接口 ---------------- */

  async function ssoPost(path, body) {
    await credentialsReady;
    if (!CLIENT_SECRET) {
      const err = new Error(tr(null, 'account_err_client'));
      err.code = 'missing_client_secret';
      throw err;
    }
    let resp;
    try {
      resp = await fetch(SSO_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, body))
      });
    } catch (e) {
      throw new Error(tr(null, 'account_err_network') + ' (' + e.message + ')');
    }
    const data = await resp.json().catch(() => ({}));
    if (data.error) {
      const err = new Error(data.error_description || data.error);
      err.code = data.error;
      throw err;
    }
    if (typeof data.code !== 'undefined' && data.code !== 0) {
      const err = new Error(data.message || ('code ' + data.code));
      err.code = data.code;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error('HTTP ' + resp.status);
      err.code = resp.status;
      throw err;
    }
    return data;
  }

  async function ssoUserinfo(accessToken) {
    const resp = await fetch(SSO_BASE + '/oauth/userinfo.php', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error_description || data.error || ('HTTP ' + resp.status));
      err.code = data.error || resp.status;
      throw err;
    }
    return data;
  }

  /* ---------------- 登录态与密钥 ---------------- */

  function tokenPayload(data) {
    // token.php 返回在顶层；register.php 返回在 data 字段
    const d = data.data && data.data.access_token ? data.data : data;
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
      user: d.user || null
    };
  }

  async function exportKeyRaw(key) {
    const rawBuf = await crypto.subtle.exportKey('raw', key);
    let bin = '';
    const arr = new Uint8Array(rawBuf);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  async function keyFromRaw(raw) {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function saveLoginState({ accessToken, refreshToken, expiresAt, user }, keyRaw) {
    const username = user?.username || user?.preferred_username || user?.email || user?.name || '';
    const prev = await getAccount();
    const account = {
      server: SSO_BASE,
      configServer: CONFIG_SERVER,
      username,
      accessToken,
      refreshToken,
      expiresAt,
      keyRaw: keyRaw ?? (prev && prev.username === username ? prev.keyRaw : ''),
      lastSyncAt: prev?.lastSyncAt || 0
    };
    await saveAccount(account);
    return account;
  }

  async function refreshIfNeeded() {
    const account = await getAccount();
    if (!account?.accessToken) throw new Error('not_logged_in');
    if (Date.now() < account.expiresAt - 120000) return account; // 未临期
    // 刷新（旋转：旧 refresh_token 同时作废）
    const data = await ssoPost('/oauth/token.php', {
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken
    });
    const payload = tokenPayload(data);
    account.accessToken = payload.accessToken;
    account.refreshToken = payload.refreshToken;
    account.expiresAt = payload.expiresAt;
    await saveAccount(account);
    return account;
  }

  /* ---------------- 配置存储（固定 SSO 地址与命名空间） ---------------- */

  async function configFetch(path, { method = 'GET', body } = {}) {
    const account = await refreshIfNeeded();
    const url = new URL(CONFIG_SERVER + path);
    url.searchParams.set('namespace', CONFIG_NAMESPACE);
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + account.accessToken
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error(tr(null, 'account_err_network') + ' (' + e.message + ')');
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || ('HTTP ' + resp.status));
      err.code = data.error || resp.status;
      throw err;
    }
    return data;
  }

  async function uploadCurrentSettings() {
    const account = await getAccount();
    const settings = await getSettings();
    settings._updatedAt = Date.now();
    const key = await keyFromRaw(account.keyRaw);
    const ciphertext = await encryptSettings(key, settings);
    await configFetch('/api/config.php', {
      method: 'PUT',
      body: { namespace: CONFIG_NAMESPACE, ciphertext, updatedAt: settings._updatedAt }
    });
    suppressUntil = Date.now() + 1500;
    await pushSettingsToStorage(settings);
    account.lastSyncAt = Date.now();
    await saveAccount(account);
    return { ok: true, lastSyncAt: account.lastSyncAt };
  }

  async function downloadRemoteSettings() {
    const account = await getAccount();
    let remote;
    try {
      remote = await configFetch('/api/config.php');
    } catch (e) {
      if (e.code === 'not_found' || e.code === 404) return { ok: false, empty: true };
      throw e;
    }
    const key = await keyFromRaw(account.keyRaw);
    const settings = await decryptSettings(key, remote.ciphertext);
    suppressUntil = Date.now() + 1500;
    await pushSettingsToStorage(settings);
    account.lastSyncAt = Date.now();
    await saveAccount(account);
    return { ok: true, lastSyncAt: account.lastSyncAt };
  }

  /** 登录后的首次同步：云端有则拉取、无则上传 */
  async function afterLoginSync() {
    const account = await getAccount();
    if (!account.keyRaw) return { ok: true, needSyncPassword: true, username: account.username };
    try {
      const dl = await downloadRemoteSettings();
      if (dl.ok) return { ok: true, direction: 'down', lastSyncAt: dl.lastSyncAt };
      if (dl.empty) {
        const up = await uploadCurrentSettings();
        return { ok: true, direction: 'up', lastSyncAt: up.lastSyncAt };
      }
      return { ok: true, direction: 'none' };
    } catch (e) {
      return { ok: true, direction: 'error', error: e.message };
    }
  }

  /* ---------------- 登录 / 注册 ---------------- */

  async function login(username, password, mfaCode) {
    mfaCode = (mfaCode || '').trim();
    let data;
    try {
      const body = { grant_type: 'password', username, password };
      if (mfaCode) body.mfa_code = mfaCode;
      data = await ssoPost('/oauth/token.php', body);
    } catch (e) {
      if (e.code === 'mfa_required') {
        return { ok: false, mfaRequired: true, error: tr(null, 'account_mfa_required') };
      }
      if (mfaCode && ['invalid_grant', 'mfa_invalid', 'invalid_mfa'].includes(e.code)) {
        return { ok: false, mfaRequired: true, error: tr(null, 'account_mfa_invalid') };
      }
      throw e;
    }
    const payload = tokenPayload(data);
    if (!payload.user) payload.user = await ssoUserinfo(payload.accessToken);
    // 登录密码即派生密钥（E2E），无需额外设置同步密码
    const key = await deriveSyncKey(password, payload.user?.username || username);
    const keyRaw = await exportKeyRaw(key);
    await saveLoginState(payload, keyRaw);
    return afterLoginSync();
  }

  async function registerSendCode(email) {
    await ssoPost('/api/auth/register/send-code.php', { email });
    return { ok: true };
  }

  async function registerCreate(email, code, password, displayName) {
    const data = await ssoPost('/api/auth/register.php', {
      email, code, password, display_name: displayName || undefined
    });
    const payload = tokenPayload(data);
    const key = await deriveSyncKey(password, email);
    const keyRaw = await exportKeyRaw(key);
    await saveLoginState(payload, keyRaw);
    return afterLoginSync();
  }

  async function setSyncPassword(password) {
    const account = await getAccount();
    if (!account?.accessToken) return { ok: false, error: 'not_logged_in' };
    if (!password || password.length < 8) return { ok: false, error: tr(null, 'account_need_fill') };
    const key = await deriveSyncKey(password, account.username);
    account.keyRaw = await exportKeyRaw(key);
    await saveAccount(account);
    return afterLoginSync();
  }

  async function logout() {
    const account = await getAccount();
    if (account?.accessToken) {
      try {
        await ssoPost('/oauth/revoke.php', { token: account.refreshToken || account.accessToken });
      } catch { /* 忽略网络异常，本地照常退出 */ }
    }
    await chrome.storage.local.remove('account');
    return { ok: true };
  }

  async function syncNow() {
    const account = await getAccount();
    if (!account?.accessToken) return { ok: false, error: 'not_logged_in' };
    let remoteUpdatedAt = 0;
    try {
      const remote = await configFetch('/api/config.php');
      remoteUpdatedAt = remote.updatedAt || 0;
    } catch (e) {
      if (!(e.code === 'not_found' || e.code === 404)) throw e;
    }
    const settings = await getSettings();
    const localUpdatedAt = settings._updatedAt || 0;
    if (remoteUpdatedAt > localUpdatedAt) {
      const r = await downloadRemoteSettings();
      return Object.assign({ direction: 'down' }, r);
    }
    const r = await uploadCurrentSettings();
    return Object.assign({ direction: 'up' }, r);
  }

  function mapError(e) {
    const code = e?.code || e?.message || '';
    if (code === 'invalid_grant') return e?.message && e.message !== code ? e.message : tr(null, 'account_err_auth');
    if (code === 'invalid_client' || code === 'missing_client_secret') return tr(null, 'account_err_client');
    if (code === 40902 || code === '40902') return tr(null, 'account_err_taken');
    if (code === 'invalid_token' || code === 'unauthorized' || code === 401) return tr(null, 'account_err_relogin');
    if (code === 'not_logged_in') return tr(null, 'account_err_relogin');
    return e?.message || String(code);
  }

  return {
    handles: ACCOUNT_TYPES,

    async handleMessage(msg) {
      try {
        switch (msg.type) {
          case 'ACCOUNT_LOGIN':
            if (!msg.username || !msg.password) return { ok: false, error: tr(null, 'account_need_fill') };
            return await login(msg.username, msg.password, msg.mfaCode);
          case 'REGISTER_SEND_CODE':
            return await registerSendCode(msg.email);
          case 'ACCOUNT_REGISTER':
            if (!msg.email || !msg.code || !msg.password) return { ok: false, error: tr(null, 'account_need_fill') };
            return await registerCreate(msg.email, msg.code, msg.password, msg.displayName);
          case 'SET_SYNC_PASSWORD':
            return await setSyncPassword(msg.password);
          case 'ACCOUNT_LOGOUT':
            return await logout();
          case 'SYNC_NOW':
            return await syncNow();
          case 'GET_ACCOUNT_STATE': {
            const account = await getAccount();
            return {
              ok: true,
              loggedIn: !!account?.accessToken,
              username: account?.username || '',
              server: SSO_BASE,
              configServer: CONFIG_SERVER,
              lastSyncAt: account?.lastSyncAt || 0,
              needSyncPassword: !!(account?.accessToken && !account?.keyRaw)
            };
          }
        }
      } catch (e) {
        return { ok: false, error: mapError(e) };
      }
    },

    /** settings 变化时防抖自动上传（登录且已设置同步密钥） */
    maybeUpload() {
      if (Date.now() < suppressUntil) return;
      clearTimeout(uploadTimer);
      uploadTimer = setTimeout(async () => {
        const account = await getAccount();
        if (!account?.accessToken || !account.keyRaw) return;
        try { await uploadCurrentSettings(); } catch { /* 静默失败 */ }
      }, 2000);
    }
  };
}
