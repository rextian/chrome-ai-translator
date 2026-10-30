/**
 * 共享预设：翻译大模型 / 专用翻译平台 / 语音识别服务 / 语言列表 / 默认设置
 * 被 background（ESM）与 options/popup 页面（ESM）共同引用。
 *
 * 服务商 type：
 *   llm    —— OpenAI 兼容 /chat/completions（Kimi、豆包、DeepSeek、智谱、自定义）
 *   aliyun —— 阿里云机器翻译（RPC 签名 HMAC-SHA1）
 *   baidu  —— 百度翻译开放平台（MD5 签名）
 */

export const PROVIDER_PRESETS = {
  kimi: {
    label: 'Kimi（月之暗面）',
    type: 'llm',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyPage: 'https://platform.moonshot.cn/console/api-keys'
  },
  doubao: {
    label: '豆包（火山方舟）',
    type: 'llm',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // 豆包模型 ID 也可以是火山方舟控制台创建的接入点 ID（ep-xxxx）
    models: ['doubao-1-5-pro-32k-250115', 'doubao-1-5-lite-32k-250115'],
    keyPage: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  deepseek: {
    label: 'DeepSeek',
    type: 'llm',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    keyPage: 'https://platform.deepseek.com/api_keys'
  },
  zhipu: {
    label: '智谱 GLM（glm-4-flash 免费）',
    type: 'llm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4.7-flash', 'glm-4-flash-250414', 'glm-4-air'],
    keyPage: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys'
  },
  openai: {
    label: 'OpenAI（需海外网络）',
    type: 'llm',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    keyPage: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    label: 'Gemini（Google，需海外网络）',
    type: 'llm',
    // Google 官方的 OpenAI 兼容端点
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'],
    keyPage: 'https://aistudio.google.com/apikey'
  },
  aliyun: {
    label: '阿里云机器翻译（国内站 · 每月 100 万字符免费）',
    type: 'aliyun',
    // AccessKey 管理（中国站直达入口，无地域重定向）
    keyPage: 'https://ak-console.aliyun.com/#/accesskey',
    // 需先开通机器翻译服务（中国站产品页）
    openPage: 'https://www.aliyun.com/product/ai/alimt'
  },
  baidu: {
    label: '百度翻译（标准版免费，QPS=1）',
    type: 'baidu',
    // 需先开通通用翻译服务：https://fanyi-api.baidu.com/product/11
    keyPage: 'https://fanyi-api.baidu.com/manage/developer',
    openPage: 'https://fanyi-api.baidu.com/product/11'
  },
  custom: {
    label: '自定义（OpenAI 兼容接口）',
    type: 'llm',
    baseUrl: '',
    models: [],
    keyPage: ''
  }
};

export const ASR_PRESETS = {
  siliconflow: {
    label: '硅基流动（有免费额度，中文友好）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall'],
    keyPage: 'https://cloud.siliconflow.cn/account/ak'
  },
  groq: {
    label: 'Groq（免费 Whisper，速度快）',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    keyPage: 'https://console.groq.com/keys'
  },
  openai: {
    label: 'OpenAI（需海外网络）',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-transcribe', 'whisper-1', 'gpt-4o-transcribe'],
    keyPage: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    label: 'Gemini（Google，需海外网络，有免费额度）',
    type: 'gemini', // 走 generateContent 传音频，非 /audio/transcriptions
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    keyPage: 'https://aistudio.google.com/apikey'
  },
  custom: {
    label: '自定义（OpenAI 兼容 /audio/transcriptions）',
    baseUrl: '',
    models: [],
    keyPage: ''
  }
};

export const TARGET_LANGS = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['en', '英语'],
  ['ja', '日语'],
  ['ko', '韩语'],
  ['fr', '法语'],
  ['de', '德语'],
  ['es', '西班牙语'],
  ['ru', '俄语'],
  ['pt', '葡萄牙语'],
  ['th', '泰语'],
  ['vi', '越南语'],
  ['id', '印尼语'],
  ['ar', '阿拉伯语']
];

export const LANG_NAMES = Object.fromEntries(TARGET_LANGS);

/* 百度翻译语言代码映射 */
export const BAIDU_LANG = {
  'zh-CN': 'zh', 'zh-TW': 'cht', 'en': 'en', 'ja': 'jp', 'ko': 'kor',
  'fr': 'fra', 'de': 'de', 'es': 'spa', 'ru': 'ru', 'pt': 'pt',
  'th': 'th', 'vi': 'vie', 'id': 'id', 'ar': 'ara'
};

/* 阿里云机器翻译语言代码映射 */
export const ALIYUN_LANG = {
  'zh-CN': 'zh', 'zh-TW': 'zh-tw', 'en': 'en', 'ja': 'ja', 'ko': 'ko',
  'fr': 'fr', 'de': 'de', 'es': 'es', 'ru': 'ru', 'pt': 'pt',
  'th': 'th', 'vi': 'vi', 'id': 'id', 'ar': 'ar'
};

/** 判断某个服务商配置是否已填全必填项 */
export function isProviderConfigured(providerKey, cfg) {
  const type = PROVIDER_PRESETS[providerKey]?.type || 'llm';
  if (!cfg) return false;
  if (type === 'aliyun') return !!(cfg.accessKeyId && cfg.accessKeySecret);
  if (type === 'baidu') return !!(cfg.appid && cfg.key);
  return !!cfg.apiKey;
}

export const DEFAULT_SETTINGS = {
  provider: 'kimi',
  targetLang: 'zh-CN',
  subtitleEnabled: true,   // YouTube 字幕翻译开关
  showOriginal: true,      // 直播浮窗是否显示原文
  segmentSeconds: 6,       // 直播音频分段时长（秒）
  autoTranslate: false,    // 打开网页时自动翻译
  pageDisplayMode: 'bilingual', // 页面翻译显示模式：bilingual（双语对照）| replace（仅显示译文）
  providers: {
    kimi:     { apiKey: '', baseUrl: PROVIDER_PRESETS.kimi.baseUrl,     model: PROVIDER_PRESETS.kimi.models[0] },
    doubao:   { apiKey: '', baseUrl: PROVIDER_PRESETS.doubao.baseUrl,   model: PROVIDER_PRESETS.doubao.models[0] },
    deepseek: { apiKey: '', baseUrl: PROVIDER_PRESETS.deepseek.baseUrl, model: PROVIDER_PRESETS.deepseek.models[0] },
    zhipu:    { apiKey: '', baseUrl: PROVIDER_PRESETS.zhipu.baseUrl,    model: PROVIDER_PRESETS.zhipu.models[0] },
    openai:   { apiKey: '', baseUrl: PROVIDER_PRESETS.openai.baseUrl,   model: PROVIDER_PRESETS.openai.models[0] },
    gemini:   { apiKey: '', baseUrl: PROVIDER_PRESETS.gemini.baseUrl,   model: PROVIDER_PRESETS.gemini.models[0] },
    aliyun:   { accessKeyId: '', accessKeySecret: '', regionId: 'cn-hangzhou' },
    baidu:    { appid: '', key: '' },
    custom:   { apiKey: '', baseUrl: '', model: '' }
  },
  asr: {
    preset: 'siliconflow',
    apiKey: '',
    baseUrl: ASR_PRESETS.siliconflow.baseUrl,
    model: ASR_PRESETS.siliconflow.models[0]
  }
};
