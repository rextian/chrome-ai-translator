/**
 * 账号与云同步管理
 * - token 存 chrome.storage.local（不随 Chrome 账号同步，避免循环）
 * - 加密密钥由密码派生后导出 raw key 存本地（仅用于本机加解密，不能用于登录）
 * - 设置变更防抖自动上传；远端覆盖时抑制回写循环
 */
import { deriveSyncKey, encryptSettings, decryptSettings } from '../lib/sync-crypto.js';

const DEFAULT_SERVER = 'https://sync.rextian.com';
const SSO_AUTHORIZE_URL = 'https://sso.rextian.com/oauth/authorize.php';
const SSO_CLIENT_ID = 'client_6ffc31c8d2983e52'; // 公开 client_id；secret 仅在同步服务端
const ACCOUNT_TYPES = ['ACCOUNT_REGISTER', 'ACCOUNT_LOGIN', 'ACCOUNT_LOGOUT', 'SYNC_NOW', 'GET_ACCOUNT_STATE', 'SSO_LOGIN', 'SET_SYNC_PASSWORD'];

export function createAccountManager({ getSettings, pushSettingsToStorage, tr }) {
  let uploadTimer = null;
  let suppressUntil = 0; // 在该时间戳之前的 settings 变化不触发上传（自己写入或远端覆盖）

  async function getAccount() {
    const { account } = await chrome.storage.local.get('account');
    return account || null;
  }

  async function saveAccount(account) {
    await chrome.storage.local.set({ account });
  }

  async function apiFetch(server, path, { method = 'GET', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let resp;
    try {
      resp = await fetch(server.replace(/\/+$/, '') + path, {
        method,
        headers,
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

  async function keyFromRaw(raw) {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function uploadCurrentSettings() {
    const account = await getAccount();
    if (!account?.token) return { ok: false, error: 'not_logged_in' };
    const settings = await getSettings();
    settings._updatedAt = Date.now();
    const key = await keyFromRaw(account.keyRaw);
    const ciphertext = await encryptSettings(key, settings);
    await apiFetch(account.server, '/api/config', {
      method: 'PUT',
      token: account.token,
      body: { ciphertext, updatedAt: settings._updatedAt }
    });
    // 记录时间戳到本地（抑制回写循环）
    suppressUntil = Date.now() + 1500;
    await pushSettingsToStorage(settings);
    account.lastSyncAt = Date.now();
    await saveAccount(account);
    return { ok: true, lastSyncAt: account.lastSyncAt };
  }

  async function downloadRemoteSettings() {
    const account = await getAccount();
    if (!account?.token) return { ok: false, error: 'not_logged_in' };
    let remote;
    try {
      remote = await apiFetch(account.server, '/api/config', { token: account.token });
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

  /** 登录后的首次同步：云端有配置则拉取，否则上传本地 */
  async function afterLoginSync() {
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

  async function exportKeyRaw(key) {
    const rawBuf = await crypto.subtle.exportKey('raw', key);
    let bin = '';
    const arr = new Uint8Array(rawBuf);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  async function loginOrRegister(kind, server, username, password) {
    server = (server || DEFAULT_SERVER).replace(/\/+$/, '');
    const data = await apiFetch(server, kind === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: { username, password }
    });
    // 派生密钥并导出存本地（仅用于本机加解密）
    const key = await deriveSyncKey(password, username);
    const keyRaw = await exportKeyRaw(key);

    await saveAccount({ server, username, token: data.token, keyRaw, lastSyncAt: 0 });
    return afterLoginSync();
  }

  /** REXTIAN SSO 统一登录（OAuth 授权码模式；code 换 token 在服务端完成） */
  async function ssoLogin(server) {
    server = (server || DEFAULT_SERVER).replace(/\/+$/, '');
    const state = crypto.randomUUID();
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = SSO_AUTHORIZE_URL
      + '?client_id=' + encodeURIComponent(SSO_CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&response_type=code&state=' + encodeURIComponent(state);

    let callbackUrl;
    try {
      callbackUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    } catch (e) {
      return { ok: false, error: tr(null, 'sso_err_cancel') };
    }
    if (!callbackUrl) return { ok: false, error: tr(null, 'sso_err_cancel') };

    const params = new URL(callbackUrl).searchParams;
    if (params.get('state') !== state) return { ok: false, error: tr(null, 'sso_err_state') };
    const code = params.get('code');
    if (!code) return { ok: false, error: tr(null, 'sso_err_cancel') };

    const data = await apiFetch(server, '/api/sso/exchange', { method: 'POST', body: { code } });
    // 若本机此前同账号已设过同步密码则复用其 keyRaw，否则需要用户设置
    const prev = await getAccount();
    const reuseKey = prev && prev.username === data.username && prev.keyRaw ? prev.keyRaw : '';
    await saveAccount({ server, username: data.username, token: data.token, keyRaw: reuseKey, lastSyncAt: 0 });

    if (!reuseKey) return { ok: true, needSyncPassword: true, username: data.username };
    return afterLoginSync();
  }

  /** SSO 登录后设置独立同步加密密码 */
  async function setSyncPassword(password) {
    const account = await getAccount();
    if (!account?.token) return { ok: false, error: 'not_logged_in' };
    if (!password || password.length < 8) return { ok: false, error: tr(null, 'account_need_fill') };
    const key = await deriveSyncKey(password, account.username);
    account.keyRaw = await exportKeyRaw(key);
    await saveAccount(account);
    return afterLoginSync();
  }

  async function logout() {
    const account = await getAccount();
    if (account?.token) {
      try { await apiFetch(account.server, '/api/logout', { method: 'POST', token: account.token }); } catch {}
    }
    await chrome.storage.local.remove('account');
    return { ok: true };
  }

  async function syncNow() {
    const account = await getAccount();
    if (!account?.token) return { ok: false, error: 'not_logged_in' };
    // 谁新用谁
    let remoteUpdatedAt = 0;
    try {
      const remote = await apiFetch(account.server, '/api/config', { token: account.token });
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
    if (code === 'wrong_username_or_password') return tr(null, 'account_err_auth');
    if (code === 'username_taken') return tr(null, 'account_err_taken');
    if (code === 'unauthorized' || code === 401) return tr(null, 'account_err_relogin');
    return e?.message || String(code);
  }

  return {
    handles: ACCOUNT_TYPES,

    async handleMessage(msg) {
      try {
        switch (msg.type) {
          case 'ACCOUNT_REGISTER':
          case 'ACCOUNT_LOGIN': {
            if (!msg.username || !msg.password) return { ok: false, error: tr(null, 'account_need_fill') };
            return await loginOrRegister(msg.kind, msg.server, msg.username, msg.password);
          }
          case 'ACCOUNT_LOGOUT':
            return await logout();
          case 'SYNC_NOW':
            return await syncNow();
          case 'SSO_LOGIN':
            return await ssoLogin(msg.server);
          case 'SET_SYNC_PASSWORD':
            return await setSyncPassword(msg.password);
          case 'GET_ACCOUNT_STATE': {
            const account = await getAccount();
            return {
              ok: true,
              loggedIn: !!account?.token,
              username: account?.username || '',
              server: account?.server || DEFAULT_SERVER,
              lastSyncAt: account?.lastSyncAt || 0,
              needSyncPassword: !!(account?.token && !account?.keyRaw)
            };
          }
        }
      } catch (e) {
        return { ok: false, error: mapError(e) };
      }
    },

    /** SW 的 storage.onChanged 在 settings 变化时调用（防抖自动上传） */
    maybeUpload() {
      if (Date.now() < suppressUntil) return;
      clearTimeout(uploadTimer);
      uploadTimer = setTimeout(async () => {
        const account = await getAccount();
        if (!account?.token) return;
        try { await uploadCurrentSettings(); } catch { /* 静默失败，用户可手动同步 */ }
      }, 2000);
    }
  };
}
