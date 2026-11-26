// 直连 SSO 全链路集成测试（mock SSO + mock 配置存储）
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOCK = 'http://127.0.0.1:8127';

// 替换 SSO_BASE 为 mock 地址，并修正 crypto 库引用为绝对路径
const src = readFileSync(path.join(ROOT, 'background/account.js'), 'utf8');
const patched = src
  .replace("const SSO_BASE = 'https://sso.rextian.com'", `const SSO_BASE = '${MOCK}'`)
  .replace("../lib/sync-crypto.js", path.join(ROOT, 'lib/sync-crypto.js'));
writeFileSync('/tmp/account-test.mjs', patched);
const { createAccountManager } = await import('/tmp/account-test.mjs');

// ---- mock chrome.storage ----
const localStore = new Map();
let syncSettings = { provider: 'kimi', targetLang: 'zh-CN', providers: { kimi: { apiKey: 'sk-secret-1' } } };
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: localStore.get(k) }),
      set: async (o) => { for (const [k, v] of Object.entries(o)) localStore.set(k, v); },
      remove: async (k) => localStore.delete(k)
    },
    sync: { set: async ({ settings }) => { syncSettings = settings; } }
  }
};

const account = createAccountManager({
  getSettings: async () => syncSettings,
  pushSettingsToStorage: async (s) => { syncSettings = s; },
  tr: (s, key) => key
});

let pass = 0, fail = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; };

// 1. 发送注册验证码
const send = await account.handleMessage({ type: 'REGISTER_SEND_CODE', email: 'new@example.com' });
check('发送验证码成功', send.ok === true);

// 2. 完成注册（注册即登录，固定配置存储，云端空 → 上传）
const reg = await account.handleMessage({ type: 'ACCOUNT_REGISTER', email: 'new@example.com', code: '123456', password: 'test-password-123' });
check('注册成功', reg.ok === true);
check('注册后自动上传本地配置', reg.direction === 'up');

// 3. 登录态与固定存储地址
const st = await account.handleMessage({ type: 'GET_ACCOUNT_STATE' });
check('登录态与存储地址正确', st.loggedIn === true && st.configServer === MOCK);

// 4. 首次同步（云端空 → 上传）
const s1 = await account.handleMessage({ type: 'SYNC_NOW' });
check('首次同步上传本地配置', s1.ok && s1.direction === 'up');

// 5. 本地时间戳调旧 → 云端新 → 下载
syncSettings = Object.assign({}, syncSettings, { _updatedAt: 1000 });
const s2 = await account.handleMessage({ type: 'SYNC_NOW' });
check('云端较新时下载覆盖', s2.ok && s2.direction === 'down');
check('E2E 解密还原 apiKey', syncSettings.providers.kimi.apiKey === 'sk-secret-1');

// 6. 错误密码登录
const bad = await account.handleMessage({ type: 'ACCOUNT_LOGIN', username: 'test@example.com', password: 'wrong-pass' });
check('错误密码被拒绝', bad.ok === false);

// 7. 登出
const out = await account.handleMessage({ type: 'ACCOUNT_LOGOUT' });
check('登出成功', out.ok === true);
const st2 = await account.handleMessage({ type: 'GET_ACCOUNT_STATE' });
check('登出后未登录', st2.loggedIn === false);

console.log(`\n结果: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
