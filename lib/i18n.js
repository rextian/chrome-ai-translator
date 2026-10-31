/**
 * 界面多语言包（中 / 英）
 * 纯全局挂载（无 import/export），可同时被：
 *   - ESM（service worker / popup / options，用 import 引入）
 *   - content script（content_scripts 数组按序加载）
 * 使用：globalThis.AI_TR_I18N.t(langPref, key, vars)
 *   langPref: 'auto' | 'zh-CN' | 'en'（auto 跟随浏览器语言）
 */
(function (g) {
  'use strict';

  const MESSAGES = {
    'zh-CN': {
      // ---- 通用 ----
      app_name: 'AI 实时翻译助手',
      on: '开',
      off: '关',
      enabled: '已开启 ✓',
      disabled: '已关闭',
      close: '关闭',

      // ---- popup ----
      target_lang: '目标语言',
      provider: '翻译平台',
      key_ok: '✓ 密钥已配置',
      key_missing: '⚠ 该平台未配置密钥，点下方「设置」',
      display_mode: '页面显示',
      display_bilingual: '双语对照',
      display_replace: '仅显示译文',
      auto_translate: '打开网页时自动翻译',
      ui_lang: '界面语言',
      ui_lang_auto: '自动（跟随浏览器）',
      btn_page: '📄 翻译本页 / 还原',
      btn_subtitle: '💬 字幕翻译：{state}',
      btn_live_start: '🔴 开始直播实时翻译',
      btn_live_stop: '⏹ 停止实时翻译',
      settings_link: '⚙️ 设置 API Key',
      status_unsupported: '当前页面不支持（仅限 http/https 页面）',
      status_no_conn: '无法连接页面，请刷新网页后重试',
      status_live_hint: '请在要翻译的网页（如 YouTube 直播页）上点击本按钮',
      status_need_asr: '请先在「设置」中配置语音识别（ASR）API Key',
      status_live_started: '已开始，翻译结果将显示在页面浮窗中',
      auto_on_tip: '自动翻译已开启，新打开的网页将自动翻译',
      auto_off_tip: '自动翻译已关闭',

      // ---- options ----
      settings_title: 'AI 实时翻译助手 · 设置',
      card_provider: '翻译服务（用于文字翻译）',
      card_asr: '语音识别（用于直播实时翻译）',
      card_general: '通用',
      provider_label: '服务商',
      api_key: 'API Key',
      api_url: 'API 地址',
      model_label: '模型',
      get_key: '获取 Key →',
      btn_test: '测试连接',
      testing: '测试中…',
      asr_flow_hint: '直播翻译流程：捕获标签页音频 → 语音识别转文字 → 翻译服务翻译。此处配置语音识别服务。',
      segment_label: '分段时长',
      seg_4: '4 秒（延迟低，费用高）',
      seg_6: '6 秒（推荐）',
      seg_8: '8 秒（更省）',
      seg_10: '10 秒（最省，延迟高）',
      subtitle_enabled: 'YouTube 字幕自动翻译（需视频开启 CC 字幕）',
      show_original: '直播浮窗中同时显示原文',
      auto_translate_opt: '打开网页时自动翻译（页面语言与目标语言相同时自动跳过）',
      display_bilingual_opt: '双语对照（原文 + 译文）',
      display_replace_opt: '仅显示译文（隐藏原文）',
      saved_tip: '设置已自动保存 ✓',
      llm_model_hint: '豆包用户：可填写模型 ID 或火山方舟的接入点 ID（ep-xxx）；智谱免费模型：glm-4-flash',
      aliyun_hint1: '需已开通「机器翻译」服务（通用版每月 100 万字符免费额度）。',
      aliyun_hint2: '默认国内站（cn-hangzhou，endpoint 为 mt.cn-hangzhou.aliyuncs.com），一般无需修改。建议使用子账号（RAM）AccessKey 并仅授予机器翻译（AliyunMTFullAccess）权限。',
      baidu_hint: '需已开通「通用文本翻译」（标准版免费，限流 QPS=1，整页翻译会较慢）。',
      region_label: '地域',
      appid_label: 'APP ID',
      secret_label: '密钥',
      aliyun_ak_id: 'AccessKey ID',
      aliyun_ak_secret: 'AccessKey Secret',
      aliyun_key_link: '获取 AccessKey →',
      baidu_key_link: '管理开发者信息 →',
      test_ok_llm: '✓ 模型返回：{text}',
      test_ok_asr: '✓ 语音识别接口可用',
      footer_developer: '开发者',

      // ---- content（页面内 UI） ----
      translating_wait: '正在翻译中，请稍候…',
      nothing_to_translate: '未找到可翻译的文本内容',
      quick_start: '快速翻译中，共 {n} 段…',
      progress: '翻译中… {done}/{total}',
      translate_done: '翻译完成，共 {n} 段',
      translate_failed: '翻译失败：{msg}',
      restored: '已恢复原文',
      panel_title: 'AI 翻译',
      panel_loading: '翻译中…',
      sel_btn_title: 'AI 翻译',
      live_title: '实时翻译中 · 拖动移动',
      live_started_toast: '实时翻译已开始（捕获本页音频中）',
      live_stopped_toast: '实时翻译已停止',
      select_first: '请先选中要翻译的文字',
      live_close_tip: '关闭浮窗（后台翻译继续）',

      // ---- service worker 错误 ----
      err_no_key: '未配置 API Key，请先在扩展设置页填写',
      err_no_baseurl: '未配置 API 地址',
      err_no_model: '未配置模型名称',
      err_timeout: '翻译请求超时',
      err_network: '网络错误：{msg}',
      err_llm_http: '翻译接口错误：{msg}',
      err_empty: '翻译接口返回为空',
      err_no_aliyun_key: '未配置阿里云 AccessKey，请先在扩展设置页填写',
      err_no_baidu_key: '未配置百度翻译 APP ID / 密钥，请先在扩展设置页填写',
      err_aliyun: '阿里云翻译错误 {code}：{msg}',
      err_baidu: '百度翻译错误 {code}：{msg}',
      err_baidu_empty: '百度翻译返回为空',
      err_no_asr_key: '未配置语音识别 API Key（设置页 → 语音识别）',
      err_no_asr_baseurl: '未配置语音识别 API 地址',
      err_asr_http: '语音识别接口错误：{msg}',
      err_gemini_asr: 'Gemini 语音识别错误：{msg}',
      err_start_live_no_asr: '请先在设置页配置语音识别（ASR）API Key',
      prefix_failed: '〔翻译失败：{msg}〕'
    },

    'en': {
      app_name: 'AI Live Translator',
      on: 'On',
      off: 'Off',
      enabled: 'On ✓',
      disabled: 'Off',
      close: 'Close',

      target_lang: 'Target language',
      provider: 'Provider',
      key_ok: '✓ API key configured',
      key_missing: '⚠ No API key — open Settings below',
      display_mode: 'Display',
      display_bilingual: 'Bilingual',
      display_replace: 'Translation only',
      auto_translate: 'Auto-translate new pages',
      ui_lang: 'Language',
      ui_lang_auto: 'Auto (browser)',
      btn_page: '📄 Translate page / Restore',
      btn_subtitle: '💬 Subtitles: {state}',
      btn_live_start: '🔴 Start live translation',
      btn_live_stop: '⏹ Stop live translation',
      settings_link: '⚙️ Settings & API Keys',
      status_unsupported: 'Unsupported page (http/https only)',
      status_no_conn: 'Cannot reach the page, please refresh and retry',
      status_live_hint: 'Click this on the page you want to translate (e.g. a YouTube live page)',
      status_need_asr: 'Please configure an ASR API key in Settings first',
      status_live_started: 'Started — subtitles will appear on the page',
      auto_on_tip: 'Auto-translate on: new pages will be translated',
      auto_off_tip: 'Auto-translate off',

      settings_title: 'AI Live Translator · Settings',
      card_provider: 'Translation Service (for text)',
      card_asr: 'Speech Recognition (for live translation)',
      card_general: 'General',
      provider_label: 'Provider',
      api_key: 'API Key',
      api_url: 'API Base URL',
      model_label: 'Model',
      get_key: 'Get a key →',
      btn_test: 'Test',
      testing: 'Testing…',
      asr_flow_hint: 'Live pipeline: capture tab audio → speech-to-text → translate. Configure the speech recognition service here.',
      segment_label: 'Segment length',
      seg_4: '4s (lowest latency, higher cost)',
      seg_6: '6s (recommended)',
      seg_8: '8s (cheaper)',
      seg_10: '10s (cheapest, high latency)',
      subtitle_enabled: 'Auto-translate YouTube captions (requires CC on)',
      show_original: 'Show original text in the live window',
      auto_translate_opt: 'Auto-translate new pages (skipped when the page already matches the target language)',
      display_bilingual_opt: 'Bilingual (original + translation)',
      display_replace_opt: 'Translation only (hide original)',
      saved_tip: 'Settings saved ✓',
      llm_model_hint: 'Doubao: model ID or endpoint ID (ep-xxx); Zhipu free model: glm-4-flash',
      aliyun_hint1: 'Requires the Machine Translation service activated (1M characters free per month).',
      aliyun_hint2: 'Defaults to the China site (cn-hangzhou, mt.cn-hangzhou.aliyuncs.com). A RAM sub-account AccessKey with only AliyunMTFullAccess is recommended.',
      baidu_hint: 'Requires "General Text Translation" activated (free tier, QPS=1, page translation is slower).',
      region_label: 'Region',
      appid_label: 'APP ID',
      secret_label: 'Secret Key',
      aliyun_ak_id: 'AccessKey ID',
      aliyun_ak_secret: 'AccessKey Secret',
      aliyun_key_link: 'Get AccessKey →',
      baidu_key_link: 'Manage developer info →',
      test_ok_llm: '✓ Model replied: {text}',
      test_ok_asr: '✓ Speech recognition API is working',
      footer_developer: 'Developer',

      translating_wait: 'Translating, please wait…',
      nothing_to_translate: 'No translatable text found on this page',
      quick_start: 'Translating {n} segments…',
      progress: 'Translating… {done}/{total}',
      translate_done: 'Done — {n} segments translated',
      translate_failed: 'Translation failed: {msg}',
      restored: 'Original restored',
      panel_title: 'AI Translate',
      panel_loading: 'Translating…',
      sel_btn_title: 'AI Translate',
      live_title: 'Live translating · drag to move',
      live_started_toast: 'Live translation started (capturing tab audio)',
      live_stopped_toast: 'Live translation stopped',
      select_first: 'Please select some text first',
      live_close_tip: 'Close window (translation continues)',

      err_no_key: 'No API key configured — open the extension settings page first',
      err_no_baseurl: 'API base URL not configured',
      err_no_model: 'Model name not configured',
      err_timeout: 'Translation request timed out',
      err_network: 'Network error: {msg}',
      err_llm_http: 'Translation API error: {msg}',
      err_empty: 'Translation API returned empty',
      err_no_aliyun_key: 'Aliyun AccessKey not configured — open the extension settings page first',
      err_no_baidu_key: 'Baidu APP ID / Secret not configured — open the extension settings page first',
      err_aliyun: 'Aliyun MT error {code}: {msg}',
      err_baidu: 'Baidu Translate error {code}: {msg}',
      err_baidu_empty: 'Baidu Translate returned empty',
      err_no_asr_key: 'No ASR API key configured (Settings → Speech Recognition)',
      err_no_asr_baseurl: 'ASR API base URL not configured',
      err_asr_http: 'ASR API error: {msg}',
      err_gemini_asr: 'Gemini ASR error: {msg}',
      err_start_live_no_asr: 'Please configure an ASR API key in Settings first',
      prefix_failed: '[Translation failed: {msg}]'
    }
  };

  function detect(pref) {
    if (pref === 'zh-CN' || pref === 'en') return pref;
    const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
    return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }

  /**
   * 取文案：t('auto', 'progress', {done: 3, total: 10})
   * 未命中键回退到中文，再回退到键名
   */
  function t(langPref, key, vars) {
    const lang = detect(langPref);
    let s = (MESSAGES[lang] && MESSAGES[lang][key]) ?? MESSAGES['zh-CN'][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replaceAll('{' + k + '}', String(v));
      }
    }
    return s;
  }

  g.AI_TR_I18N = { MESSAGES, detect, t };
})(typeof globalThis !== 'undefined' ? globalThis : window);
