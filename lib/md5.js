/**
 * MD5（RFC 1321）纯 JS 实现 —— 百度翻译签名用（Web Crypto 不提供 MD5）
 * 输入字符串（内部 UTF-8 编码），输出 32 位小写 hex。
 */
export function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const n = bytes.length;
  const bitLen = n * 8;

  // 填充：0x80 + 补零至 ≡56 (mod 64)，末 8 字节小端位长
  const paddedLen = (((n + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 2 ** 32), true);

  const words = [];
  for (let j = 0; j < paddedLen; j += 4) words.push(dv.getUint32(j, true));

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const K = [];
  for (let k = 0; k < 64; k++) K[k] = Math.floor(Math.abs(Math.sin(k + 1)) * 2 ** 32) >>> 0;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < words.length; off += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let k = 0; k < 64; k++) {
      let F, gIdx;
      if (k < 16) { F = (B & C) | (~B & D); gIdx = k; }
      else if (k < 32) { F = (D & B) | (~D & C); gIdx = (5 * k + 1) % 16; }
      else if (k < 48) { F = B ^ C ^ D; gIdx = (3 * k + 5) % 16; }
      else { F = C ^ (B | ~D); gIdx = (7 * k) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[k] + words[off + gIdx]) >>> 0;
      B = (B + ((sum << S[k]) | (sum >>> (32 - S[k])))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const hexLE = (w) => {
    let s = '';
    for (let j = 0; j < 4; j++) s += ((w >> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
