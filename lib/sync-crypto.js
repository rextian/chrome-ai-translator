/**
 * 云同步端到端加密（Web Crypto）
 * 密钥由「登录密码 + 用户名」在本地派生，服务器只见密文，无法读取配置中的 API Key。
 * 算法：PBKDF2-HMAC-SHA256（10 万轮）→ AES-256-GCM
 */

const PBKDF2_ITERATIONS = 100000;

function saltFor(username) {
  return new TextEncoder().encode(`ai-tr-sync:${username}`);
}

/** 从密码派生 AES-GCM 密钥（不离开本地） */
export async function deriveSyncKey(password, username) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltFor(username), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true, // 需要导出 raw key 存本地供后续加解密（仅存浏览器 storage.local）
    ['encrypt', 'decrypt']
  );
}

function toBase64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** 加密对象为 base64 密文（iv 12B + ciphertext） */
export async function encryptSettings(key, settingsObj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(settingsObj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return toBase64(iv) + '.' + toBase64(cipher);
}

/** 解密 base64 密文为对象 */
export async function decryptSettings(key, packed) {
  const [ivB64, cipherB64] = String(packed).split('.');
  if (!ivB64 || !cipherB64) throw new Error('bad_ciphertext');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivB64) },
    key,
    fromBase64(cipherB64)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
