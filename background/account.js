/**
 * 账号与云同步管理（直连 REXTIAN SSO）
 *
 * 身份认证全部直连 sso.rextian.com：
 *   登录 /oauth/token.php (grant_type=password)
 *   注册 /api/auth/register/send-code.php + register.php（邮箱验证码两步）
 *   授权码登录 oauth/authorize.php + token.php (authorization_code)
 *   刷新 /oauth/token.php (grant_type=refresh_token，旋转更新)
 *   注销 /oauth/revoke.php
 *
 * 配置存储走「可配置的存储服务地址」（configServer）：
 *   GET  {configServer}/api/config   Bearer <access_token> → {ciphertext, updatedAt}
 *   PUT  {configServer}/api/config   Bearer <access_token> {ciphertext, updatedAt}
 * 留空则仅登录、不做配置同步。
 *
 * 安全说明：client_secret 内置于此（直连模式不可避免），泄露时请在 SSO 后台「重置密钥」。
 */
import { deriveSyncKey, encryptSettings, decryptSettings } from '../lib/sync-crypto.js';

const SSO_BASE = 'https://sso.rextian.com';
const CLIENT_ID = 'client_6ffc31c8d2983e52';
const CLIENT_SECRET = '35517d81d4391226a616b85db5094010491b341035e6c8f9';
const ACCOUNT_TYPES = [
  'ACCOUNT_REGISTER', 'ACCOUNT_LOGIN', 'ACCOUNT_LOGOUT', 'SYNC_NOW', 'GET_ACCOUNT_STATE',
  'SSO_LOGIN', 'SET_SYNC_PASSWORD', 'REGISTER_SEND_CODE', 'SET_CONFIG_SERVER'
];

export function createAccountManager({ getSettings, pushSettingsToStorage, tr }) {
  let uploadTimer = null;
  let suppressUntil = 0;

  async function getAccount() {
    const { account } = await chrome.storage.local.get('account');
    return account || null;
  }

  async function saveAccount(account) {
    await chrome.storage.local.set({ account });
  }

  /* ---------------- SSO 接口 ---------------- */

  async function ssoPost(path, body) {
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
      configServer: prev?.configServer || '',
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

  /* ---------------- 配置存储（可配置地址） ---------------- */

  async function configFetch(path, { method = 'GET', body } = {}) {
    const account = await refreshIfNeeded();
    if (!account.configServer) throw new Error('no_config_server');
    let resp;
    try {
      resp = await fetch(account.configServer.replace(/\/+$/, '') + path, {
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
    await configFetch('/api/config', {
      method: 'PUT',
      body: { ciphertext, updatedAt: settings._updatedAt }
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
      remote = await configFetch('/api/config');
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

  /** 登录后的首次同步：有存储地址才同步，云端有则拉取、无则上传 */
  async function afterLoginSync() {
    const account = await getAccount();
    if (!account.configServer) return { ok: true, direction: 'none', noConfigServer: true };
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

  async function login(username, password) {
    const data = await ssoPost('/oauth/token.php', {
      grant_type: 'password', username, password
    });
    const payload = tokenPayload(data);
    // 登录密码即派生密钥（E2E）
    const key = await deriveSyncKey(password, payload.user?.username || username);
    const keyRaw = await exportKeyRaw(key);
    await saveLoginState(payload, keyRaw);
    return afterLoginSync();
  }

  async function ssoLoginOAuth() {
    const state = crypto.randomUUID();
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = SSO_BASE + '/oauth/authorize.php'
      + '?client_id=' + encodeURIComponent(CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&response_type=code&scope=' + encodeURIComponent('openid profile email')
      + '&state=' + encodeURIComponent(state);

    let callbackUrl;
    try {
      callbackUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    } catch {
      return { ok: false, error: tr(null, 'sso_err_cancel') };
    }
    if (!callbackUrl) return { ok: false, error: tr(null, 'sso_err_cancel') };

    const params = new URL(callbackUrl).searchParams;
    if (params.get('state') !== state) return { ok: false, error: tr(null, 'sso_err_state') };
    const code = params.get('code');
    if (!code) return { ok: false, error: tr(null, 'sso_err_cancel') };

    const data = await ssoPost('/oauth/token.php', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri
    });
    const payload = tokenPayload(data);
    await saveLoginState(payload, null); // SSO 场景密钥由「独立同步密码」派生
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
    if (!account.configServer) return { ok: false, error: 'no_config_server' };
    let remoteUpdatedAt = 0;
    try {
      const remote = await configFetch('/api/config');
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
    if (code === 'invalid_grant') return tr(null, 'account_err_auth');
    if (code === 'invalid_client') return tr(null, 'account_err_auth');
    if (code === 40902 || code === '40902') return tr(null, 'account_err_taken');
    if (code === 'invalid_token' || code === 401) return tr(null, 'account_err_relogin');
    if (code === 'not_logged_in') return tr(null, 'account_err_relogin');
    if (code === 'no_config_server') return tr(null, 'account_config_server_tip');
    return e?.message || String(code);
  }

  return {
    handles: ACCOUNT_TYPES,

    async handleMessage(msg) {
      try {
        switch (msg.type) {
          case 'ACCOUNT_LOGIN':
            if (!msg.username || !msg.password) return { ok: false, error: tr(null, 'account_need_fill') };
            return await login(msg.username, msg.password);
          case 'REGISTER_SEND_CODE':
            return await registerSendCode(msg.email);
          case 'ACCOUNT_REGISTER':
            if (!msg.email || !msg.code || !msg.password) return { ok: false, error: tr(null, 'account_need_fill') };
            return await registerCreate(msg.email, msg.code, msg.password, msg.displayName);
          case 'SSO_LOGIN':
            return await ssoLoginOAuth();
          case 'SET_SYNC_PASSWORD':
            return await setSyncPassword(msg.password);
          case 'ACCOUNT_LOGOUT':
            return await logout();
          case 'SYNC_NOW':
            return await syncNow();
          case 'SET_CONFIG_SERVER': {
            const account = (await getAccount()) || {};
            account.configServer = (msg.configServer || '').trim().replace(/\/+$/, '');
            await saveAccount(account);
            return { ok: true };
          }
          case 'GET_ACCOUNT_STATE': {
            const account = await getAccount();
            return {
              ok: true,
              loggedIn: !!account?.accessToken,
              username: account?.username || '',
              server: SSO_BASE,
              configServer: account?.configServer || '',
              lastSyncAt: account?.lastSyncAt || 0,
              needSyncPassword: !!(account?.accessToken && account.configServer && !account?.keyRaw)
            };
          }
        }
      } catch (e) {
        return { ok: false, error: mapError(e) };
      }
    },

    /** settings 变化时防抖自动上传（登录且已配置存储地址） */
    maybeUpload() {
      if (Date.now() < suppressUntil) return;
      clearTimeout(uploadTimer);
      uploadTimer = setTimeout(async () => {
        const account = await getAccount();
        if (!account?.accessToken || !account.configServer || !account.keyRaw) return;
        try { await uploadCurrentSettings(); } catch { /* 静默失败 */ }
      }, 2000);
    }
  };
}
