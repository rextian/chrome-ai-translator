/**
 * Service Worker：翻译 API 调用、ASR 调用、直播会话管理、右键菜单、消息路由
 */
import { PROVIDER_PRESETS, ASR_PRESETS, DEFAULT_SETTINGS, LANG_NAMES, BAIDU_LANG, ALIYUN_LANG } from '../lib/presets.js';
import { md5 } from '../lib/md5.js';

/* ---------------- 设置读取（深合并默认值） ---------------- */

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (settings && typeof settings === 'object') {
    for (const k of Object.keys(settings)) {
      if (k === 'providers' || k === 'asr') continue;
      merged[k] = settings[k];
    }
    if (settings.providers) {
      for (const [p, cfg] of Object.entries(settings.providers)) {
        merged.providers[p] = Object.assign({}, merged.providers[p] || {}, cfg);
      }
    }
    if (settings.asr) merged.asr = Object.assign({}, merged.asr, settings.asr);
  }
  return merged;
}

/* ---------------- 翻译缓存（LRU） ---------------- */

const cache = new Map();
const MAX_CACHE = 500;

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/* ---------------- SW 保活 ----------------
 * MV3 Service Worker 空闲约 30 秒会被 Chrome 回收，而 fetch 等待不算扩展活动。
 * LLM 请求可能持续十几秒，翻译任务期间必须周期性调用扩展 API 保活，
 * 否则 SW 中途被杀、消息通道断开，页面端表现为"翻译不出来"。
 */

let keepAliveCount = 0;
let keepAliveTimer = null;

function acquireKeepAlive() {
  keepAliveCount++;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 20000);
  }
}

function releaseKeepAlive() {
  keepAliveCount = Math.max(0, keepAliveCount - 1);
  if (keepAliveCount === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* ---------------- 大模型翻译（OpenAI 兼容协议） ---------------- */

async function callLLM(settings, messages, { maxTokens = 2000 } = {}) {
  const p = settings.providers[settings.provider] || {};
  const baseUrl = (p.baseUrl || '').replace(/\/+$/, '');
  if (!p.apiKey) throw new Error('未配置 API Key，请先在扩展设置页填写');
  if (!baseUrl) throw new Error('未配置 API 地址');
  if (!p.model) throw new Error('未配置模型名称');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${p.apiKey}`
      },
      body: JSON.stringify({ model: p.model, messages, temperature: 0.2, max_tokens: maxTokens }),
      signal: ctrl.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('翻译请求超时');
    throw new Error('网络错误：' + e.message);
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`翻译接口错误：${data?.error?.message || ('HTTP ' + resp.status)}`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('翻译接口返回为空');
  return content.trim();
}

function buildMessages(text, targetLang, mode) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  const sys = mode === 'subtitle'
    ? `你是专业的视频字幕翻译引擎。把用户给出的字幕文本翻译成${langName}。要求：1) 只输出译文，不要解释；2) 保留原文换行；3) 口语化、简洁，符合字幕习惯；4) 若输入是不完整的句子片段，直接按片段翻译，不要补全。`
    : `你是专业的翻译引擎。把用户给出的文本翻译成${langName}。要求：只输出译文，不要任何解释、注音或额外内容，保留原文格式与换行。`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: text }
  ];
}

/* ---------------- 阿里云机器翻译（RPC 签名 HMAC-SHA1） ---------------- */

async function aliyunTranslate(text, targetLang, cfg) {
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    throw new Error('未配置阿里云 AccessKey，请先在扩展设置页填写');
  }
  const regionId = cfg.regionId || 'cn-hangzhou';
  const endpoint = `https://mt.${regionId}.aliyuncs.com`;

  const params = {
    Action: 'TranslateGeneral',
    Format: 'JSON',
    Version: '2018-10-12',
    AccessKeyId: cfg.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    RegionId: regionId,
    FormatType: 'text',
    SourceLanguage: 'auto',
    TargetLanguage: ALIYUN_LANG[targetLang] || 'zh',
    SourceText: text,
    Scene: 'general'
  };

  // 阿里云特殊 URL 编码规则
  const enc = (s) => encodeURIComponent(String(s))
    .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

  const canonicalized = Object.keys(params).sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const stringToSign = 'POST&' + enc('/') + '&' + enc(canonicalized);

  const keyData = new TextEncoder().encode(cfg.accessKeySecret + '&');
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  const resp = await fetch(`${endpoint}/?Signature=${enc(signature)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: canonicalized
  });
  const data = await resp.json().catch(() => ({}));
  if (String(data.Code) !== '200') {
    throw new Error(`阿里云翻译错误 ${data.Code || resp.status}：${data.Message || '未知错误'}`);
  }
  return data.Data.Translated;
}

/* ---------------- 百度翻译开放平台（MD5 签名） ---------------- */

async function baiduTranslate(text, targetLang, cfg) {
  if (!cfg.appid || !cfg.key) {
    throw new Error('未配置百度翻译 APP ID / 密钥，请先在扩展设置页填写');
  }
  const salt = Date.now().toString();
  const sign = md5(cfg.appid + text + salt + cfg.key);

  const body = new URLSearchParams({
    q: text,
    from: 'auto',
    to: BAIDU_LANG[targetLang] || 'zh',
    appid: cfg.appid,
    salt,
    sign
  });

  const resp = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await resp.json().catch(() => ({}));
  if (data.error_code) {
    throw new Error(`百度翻译错误 ${data.error_code}：${data.error_msg || ''}`);
  }
  if (!data.trans_result) throw new Error('百度翻译返回为空');
  return data.trans_result.map((t) => t.dst).join('\n');
}

/* ---------------- 并发限流器 ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  return async function limited(fn) {
    if (active >= max) await new Promise((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// 各协议并发上限：百度标准版 QPS=1 严格串行；LLM 12 路、阿里云 16 路并发
const limiters = {
  llm: createLimiter(12),
  aliyun: createLimiter(16),
  baidu: createLimiter(1)
};

function limiterFor(providerKey) {
  const type = PROVIDER_PRESETS[providerKey]?.type || 'llm';
  if (providerKey === 'baidu') return limiters.baidu;
  if (type === 'aliyun') return limiters.aliyun;
  return limiters.llm;
}

/** 限流/临时错误自动重试（指数退避） */
function isRetryable(message) {
  return /429|54003|rate|too many|限流|throttl|overload|503|502/i.test(message || '');
}

async function withRetry(fn, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e.message) || i === retries) throw e;
      await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------------- 统一翻译入口 ---------------- */

function cacheKeyOf(settings, text, lang, mode) {
  const cfg = settings.providers[settings.provider] || {};
  return `${settings.provider}|${cfg.model || ''}|${lang}|${mode}|${text}`;
}

/** 单条原始翻译（不带缓存，带限流与限流重试） */
async function rawTranslate(settings, text, lang, mode) {
  const type = PROVIDER_PRESETS[settings.provider]?.type || 'llm';
  const cfg = settings.providers[settings.provider] || {};
  const limited = limiterFor(settings.provider);

  if (type === 'aliyun') return withRetry(() => limited(() => aliyunTranslate(text, lang, cfg)));
  if (type === 'baidu') {
    return withRetry(() => limited(async () => {
      const out = await baiduTranslate(text, lang, cfg);
      await sleep(1000); // 标准版 QPS=1
      return out;
    }));
  }
  return withRetry(() => limited(() => callLLM(settings, buildMessages(text, lang, mode))));
}

async function translateOne(text, targetLang, mode = 'text') {
  const settings = await getSettings();
  const lang = targetLang || settings.targetLang;
  const key = cacheKeyOf(settings, text, lang, mode);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const out = await rawTranslate(settings, text, lang, mode);
  cacheSet(key, out);
  return out;
}

/* ---------------- 批量合并翻译（提速核心：多段合并为一次请求） ---------------- */

/** 把文本按字符数/条数打包成组 */
function packGroups(items, maxChars = 700, maxItems = 18) {
  const groups = [];
  let cur = { texts: [], indices: [], len: 0 };
  for (const { i, text } of items) {
    if (cur.texts.length && (cur.len + text.length > maxChars || cur.texts.length >= maxItems)) {
      groups.push(cur);
      cur = { texts: [], indices: [], len: 0 };
    }
    cur.texts.push(text);
    cur.indices.push(i);
    cur.len += text.length;
  }
  if (cur.texts.length) groups.push(cur);
  return groups;
}

/** 各服务商的打包参数：MT 模型毫秒级响应，用大组减少请求数；LLM 生成速度有限，用小组缩短单请求时长 */
function packParamsFor(providerKey) {
  const type = PROVIDER_PRESETS[providerKey]?.type || 'llm';
  if (type === 'aliyun') return { maxChars: 2500, maxItems: 40 }; // MT 上限 5000 字符
  if (type === 'baidu') return { maxChars: 2000, maxItems: 40 };  // 标准版单次 6000 字符，留余量
  return { maxChars: 700, maxItems: 18 };                          // LLM 小组生成更快
}

/** 按编号标记拆分模型返回；支持 ⟦n⟧ 【n】 [n] 等变体，数量不符返回 null（调用方回退逐段） */
function splitNumbered(text, count) {
  const patterns = [
    /⟦\s*(\d+)\s*⟧/,   // 首选：⟦0⟧
    /【\s*(\d+)\s*】/,  // 变体：【0】
    /\[\s*(\d+)\s*\]/, // 变体：[0]
    /\(\s*(\d+)\s*\)/  // 变体：(0)
  ];
  for (const p of patterns) {
    const out = trySplitBy(text, count, p);
    if (out) return out;
  }
  return null;
}

function trySplitBy(text, count, pattern) {
  const re = new RegExp(pattern.source, 'g');
  const marks = [];
  let m;
  while ((m = re.exec(text))) {
    marks.push({ idx: Number(m[1]), start: m.index, end: re.lastIndex });
  }
  if (marks.length < count) return null;
  const map = new Map();
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].end;
    const to = k + 1 < marks.length ? marks[k + 1].start : text.length;
    // 同一编号多次出现时取最后一次（模型偶尔重复输出编号行）
    map.set(marks[k].idx, text.slice(from, to).trim());
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (!map.has(i) || !map.get(i)) return null;
    out.push(map.get(i));
  }
  return out;
}

/** 合并一组文本为一次请求（按服务商协议），返回与输入等长的译文数组；失败返回 null 由调用方回退 */
async function translateGroupMerged(settings, texts, lang) {
  const type = PROVIDER_PRESETS[settings.provider]?.type || 'llm';
  const cfg = settings.providers[settings.provider] || {};
  const langName = LANG_NAMES[lang] || lang;
  const limited = limiterFor(settings.provider);

  if (type === 'baidu') {
    // 百度原生支持 \n 分隔多段，trans_result 数组与段落一一对应
    return withRetry(() => limited(async () => {
      const q = texts.join('\n');
      const salt = Date.now().toString();
      const sign = md5(cfg.appid + q + salt + cfg.key);
      const body = new URLSearchParams({
        q, from: 'auto', to: BAIDU_LANG[lang] || 'zh', appid: cfg.appid, salt, sign
      });
      const resp = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await resp.json().catch(() => ({}));
      if (data.error_code) throw new Error(`百度翻译错误 ${data.error_code}：${data.error_msg || ''}`);
      await sleep(1000); // QPS=1
      const arr = (data.trans_result || []).map((t) => t.dst);
      return arr.length === texts.length ? arr : null;
    }));
  }

  if (type === 'aliyun') {
    // 阿里云对 \n 分隔的多段文本按行返回
    return withRetry(() => limited(async () => {
      const out = await aliyunTranslate(texts.join('\n'), lang, cfg);
      const arr = out.split('\n').map((s) => s.trim());
      return arr.length === texts.length ? arr : null;
    }));
  }

  // LLM：编号标记合并
  return withRetry(() => limited(async () => {
    const numbered = texts.map((t, i) => `⟦${i}⟧ ${t}`).join('\n');
    const sys = `你是批量翻译引擎。输入是多段以 ⟦数字⟧ 标记开头的文本。把每一段翻译成${langName}，要求：1) 每段译文开头原样保留对应的 ⟦数字⟧ 标记；2) 段数与输入完全一致，不得合并、拆分或遗漏；3) 只输出带标记的译文，不要任何解释。`;
    const out = await callLLM(settings, [
      { role: 'system', content: sys },
      { role: 'user', content: numbered }
    ], { maxTokens: 4000 });
    return splitNumbered(out, texts.length);
  }));
}

/** 组翻译：优先合并请求，失败回退逐段翻译（保证可用性） */
async function translateGroupTexts(texts, lang, settings) {
  try {
    const parts = await translateGroupMerged(settings, texts, lang);
    if (parts) {
      // 逐段写缓存，利于后续命中
      texts.forEach((t, i) => cacheSet(cacheKeyOf(settings, t, lang, 'text'), parts[i]));
      return parts;
    }
  } catch (e) {
    // 合并请求出错，走逐段回退
  }
  return Promise.all(texts.map(async (t) => {
    try {
      return await translateOne(t, lang);
    } catch (e) {
      return `〔翻译失败：${e.message}〕`;
    }
  }));
}

async function translateBatch(texts, targetLang) {
  const settings = await getSettings();
  const lang = targetLang || settings.targetLang;
  const results = new Array(texts.length);

  // 先查缓存
  const miss = [];
  texts.forEach((t, i) => {
    const hit = cacheGet(cacheKeyOf(settings, t, lang, 'text'));
    if (hit !== undefined) results[i] = hit;
    else miss.push({ i, text: t });
  });
  if (!miss.length) return results;

  // 打包成组，并发翻译（组内合并为一次请求；并发由限流器约束）
  const { maxChars, maxItems } = packParamsFor(settings.provider);
  const groups = packGroups(miss, maxChars, maxItems);
  await Promise.all(groups.map(async (g) => {
    const parts = await translateGroupTexts(g.texts, lang, settings);
    g.indices.forEach((origIdx, j) => { results[origIdx] = parts[j]; });
  }));
  return results;
}

/* ---------------- 语音识别（OpenAI 兼容 /audio/transcriptions） ---------------- */

async function transcribeAudio(dataUrl, filename = 'segment.webm') {
  const settings = await getSettings();
  const a = settings.asr || {};
  const baseUrl = (a.baseUrl || '').replace(/\/+$/, '');
  if (!a.apiKey) throw new Error('未配置语音识别 API Key（设置页 → 语音识别）');
  if (!baseUrl) throw new Error('未配置语音识别 API 地址');

  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('model', a.model || 'whisper-1');
  fd.append('response_format', 'json');

  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${a.apiKey}` },
    body: fd
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`语音识别接口错误：${data?.error?.message || ('HTTP ' + resp.status)}`);
  return (data.text || '').trim();
}

/* 生成一段静音 WAV（用于测试 ASR 连通性） */
function silentWavDataUrl(durationSec = 0.3, rate = 16000) {
  const n = Math.floor(durationSec * rate);
  const dataSize = n * 2;
  const buf = new Uint8Array(44 + dataSize);
  const dv = new DataView(buf.buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  writeStr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  writeStr(36, 'data'); dv.setUint32(40, dataSize, true);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

/* ---------------- 直播会话管理 ---------------- */

async function setLiveSession(s) {
  await chrome.storage.session.set({ live: s });
}

async function getLiveSession() {
  const { live } = await chrome.storage.session.get('live');
  return live || null;
}

async function startLive(tabId) {
  // 必须在用户手势上下文中尽早调用，放在任何 await 之前
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const settings = await getSettings();
  if (!settings.asr.apiKey) throw new Error('请先在设置页配置语音识别（ASR）API Key');

  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '捕获标签页音频用于实时语音翻译'
    });
  }

  await setLiveSession({ tabId, active: true, startedAt: Date.now() });

  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    segmentSeconds: settings.segmentSeconds
  });

  // 通知目标页面显示浮窗
  chrome.tabs.sendMessage(tabId, { type: 'LIVE_STARTED' }).catch(() => {});
  return { ok: true };
}

async function stopLive() {
  const session = await getLiveSession();
  try { chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' }); } catch {}
  await setLiveSession(null);
  try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch {}
  if (session?.tabId) {
    chrome.tabs.sendMessage(session.tabId, { type: 'LIVE_STOPPED' }).catch(() => {});
  }
  return { ok: true };
}

async function handleAsrSegment(dataUrl) {
  const session = await getLiveSession();
  if (!session?.active) return;

  let text = '';
  try {
    text = await transcribeAudio(dataUrl);
  } catch (e) {
    chrome.tabs.sendMessage(session.tabId, { type: 'LIVE_STATUS', status: '语音识别失败：' + e.message }).catch(() => {});
    return;
  }
  if (!text) return; // 静音段

  let translation = '';
  try {
    translation = await translateOne(text, null, 'subtitle');
  } catch (e) {
    translation = `〔翻译失败：${e.message}〕`;
  }
  chrome.tabs.sendMessage(session.tabId, { type: 'LIVE_SUBTITLE', original: text, translation }).catch(() => {});
}

/* ---------------- 右键菜单 ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ai-tr-selection', title: 'AI 翻译选中内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ai-tr-page', title: 'AI 翻译 / 还原整个网页', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'ai-tr-selection') {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_SELECTION' }).catch(() => {});
  } else if (info.menuItemId === 'ai-tr-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'PAGE_TRANSLATE_TOGGLE' }).catch(() => {});
  }
});

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return; // 转发给 offscreen 的消息不处理

  const handlers = {
    TRANSLATE_TEXT: async () => ({ ok: true, translation: await translateOne(msg.text, msg.targetLang, msg.mode) }),
    TRANSLATE_BATCH: async () => ({ ok: true, translations: await translateBatch(msg.texts, msg.targetLang) }),
    START_LIVE: async () => startLive(msg.tabId),
    STOP_LIVE: async () => stopLive(),
    GET_LIVE_STATE: async () => ({ ok: true, live: await getLiveSession() }),
    ASR_SEGMENT: async () => { await handleAsrSegment(msg.dataUrl); return { ok: true }; },
    LIVE_ERROR: async () => {
      const session = await getLiveSession();
      if (session?.tabId) {
        chrome.tabs.sendMessage(session.tabId, { type: 'LIVE_STATUS', status: msg.error }).catch(() => {});
      }
      return { ok: true };
    },
    TEST_LLM: async () => {
      const s = await getSettings();
      const type = PROVIDER_PRESETS[s.provider]?.type || 'llm';
      if (type === 'llm') {
        const r = await callLLM(s, [{ role: 'user', content: '只回复"OK"两个字' }], { maxTokens: 10 });
        return { ok: true, detail: `模型返回：${r}` };
      }
      // 阿里云 / 百度：用一次真实翻译做连通性测试
      const r = await translateOne('Hello, world', 'zh-CN');
      return { ok: true, detail: `翻译测试：Hello, world → ${r}` };
    },
    TEST_ASR: async () => {
      await transcribeAudio(silentWavDataUrl(), 'silence.wav');
      return { ok: true, detail: '语音识别接口可用' };
    }
  };

  const h = handlers[msg.type];
  if (!h) return;

  acquireKeepAlive(); // 任务期间保活，防止 SW 在长请求途中被回收
  (async () => {
    try {
      sendResponse(await h());
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    } finally {
      releaseKeepAlive();
    }
  })();
  return true; // 异步响应
});
