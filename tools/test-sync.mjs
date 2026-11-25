// 账号云同步集成测试：node 直接打本地 sync_server，mock chrome.storage
import { createAccountManager } from '../background/account.js';

const SERVER = 'http://127.0.0.1:8126';
const USER = 'itest' + Date.now().toString(36);
const PASS = 'itest-password-123';

// ---- mock chrome.storage ----
const localStore = new Map();
let syncSettings = { provider: 'kimi', targetLang: 'zh-CN', providers: { kimi: { apiKey: 'sk-local-secret' } } };
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: localStore.get(key) }),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); },
      remove: async (key) => { localStore.delete(key); }
    },
    sync: {
      set: async ({ settings }) => { syncSettings = settings; }
    }
  }
};

const account = createAccountManager({
  getSettings: async () => syncSettings,
  pushSettingsToStorage: async (s) => { syncSettings = s; },
  tr: (s, key) => key
});

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  cond ? pass++ : fail++;
};

// 1. 注册（云端空 → 应上传本地配置）
const reg = await account.handleMessage({ type: 'ACCOUNT_REGISTER', kind: 'register', server: SERVER, username: USER, password: PASS });
check('注册成功', reg.ok === true);
check('首次注册后上传本地配置', reg.direction === 'up');

// 2. 登录状态
const st = await account.handleMessage({ type: 'GET_ACCOUNT_STATE' });
check('登录态正确', st.loggedIn === true && st.username === USER);

// 3. 本地更新后 SYNC_NOW（本地新 → 上传）
syncSettings = Object.assign({}, syncSettings, { targetLang: 'en', _updatedAt: Date.now() + 1000 });
const s1 = await account.handleMessage({ type: 'SYNC_NOW' });
check('本地较新时上传', s1.ok && s1.direction === 'up');

// 4. 模拟另一设备改了云端（本地时间戳调旧）→ 应下载覆盖
syncSettings = Object.assign({}, syncSettings, { targetLang: 'zh-CN', _updatedAt: 1000 });
const s2 = await account.handleMessage({ type: 'SYNC_NOW' });
check('云端较新时下载覆盖', s2.ok && s2.direction === 'down');
check('下载后本地为云端内容(en)', syncSettings.targetLang === 'en');
check('E2E 解密还原 apiKey', syncSettings.providers.kimi.apiKey === 'sk-local-secret');

// 5. 错误密码登录
const bad = await account.handleMessage({ type: 'ACCOUNT_LOGIN', kind: 'login', server: SERVER, username: USER, password: 'wrong-password' });
check('错误密码被拒绝', bad.ok === false);

// 6. 登出
await account.handleMessage({ type: 'ACCOUNT_LOGOUT' });
const st2 = await account.handleMessage({ type: 'GET_ACCOUNT_STATE' });
check('登出后未登录', st2.loggedIn === false);

// 7. 重新登录（云端有配置 → 应下载）
const relog = await account.handleMessage({ type: 'ACCOUNT_LOGIN', kind: 'login', server: SERVER, username: USER, password: PASS });
check('重新登录成功', relog.ok === true);
check('重新登录拉取云端配置', relog.direction === 'down');

console.log(`\n结果: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
