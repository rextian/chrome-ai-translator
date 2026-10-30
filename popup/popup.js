import { PROVIDER_PRESETS, TARGET_LANGS, DEFAULT_SETTINGS, isProviderConfigured } from '../lib/presets.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let liveActive = false;

function setStatus(text, ok = false) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (ok ? ' ok' : '');
}

async function loadSettings() {
  const { settings: s } = await chrome.storage.sync.get('settings');
  settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s || {});
  if (s?.providers) {
    for (const [p, cfg] of Object.entries(s.providers)) {
      settings.providers[p] = Object.assign({}, DEFAULT_SETTINGS.providers[p] || {}, cfg);
    }
  }
}

async function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  await chrome.storage.sync.set({ settings });
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function refreshProviderInfo() {
  const cfg = settings.providers[settings.provider] || {};
  const el = $('providerInfo');
  if (isProviderConfigured(settings.provider, cfg)) {
    el.textContent = '✓ 密钥已配置';
    el.className = 'provider-info-line ok';
  } else {
    el.textContent = '⚠ 该平台未配置密钥，点下方「设置 API Key」';
    el.className = 'provider-info-line miss';
  }
}

function refreshLiveBtn() {
  const btn = $('btnLive');
  if (liveActive) {
    btn.textContent = '⏹ 停止实时翻译';
    btn.classList.add('stop');
  } else {
    btn.textContent = '🔴 开始直播实时翻译';
    btn.classList.remove('stop');
  }
}

async function init() {
  await loadSettings();

  // 目标语言下拉
  const langSel = $('targetLang');
  for (const [code, name] of TARGET_LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    langSel.appendChild(opt);
  }
  langSel.value = settings.targetLang;
  langSel.addEventListener('change', () => saveSettings({ targetLang: langSel.value }));

  // 翻译平台下拉（故障时可快速切换）
  const providerSel = $('provider');
  for (const [key, p] of Object.entries(PROVIDER_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    providerSel.appendChild(opt);
  }
  providerSel.value = settings.provider;
  providerSel.addEventListener('change', async () => {
    await saveSettings({ provider: providerSel.value });
    refreshProviderInfo();
  });

  // 页面显示模式
  $('pageDisplayMode').value = settings.pageDisplayMode || 'bilingual';
  $('pageDisplayMode').addEventListener('change', () => saveSettings({ pageDisplayMode: $('pageDisplayMode').value }));

  // 自动翻译开关
  $('autoTranslate').checked = settings.autoTranslate === true;
  $('autoTranslate').addEventListener('change', async () => {
    await saveSettings({ autoTranslate: $('autoTranslate').checked });
    setStatus($('autoTranslate').checked ? '自动翻译已开启，新打开的网页将自动翻译' : '自动翻译已关闭', true);
  });

  refreshProviderInfo();

  // 字幕开关
  const refreshSubtitle = () => { $('subtitleState').textContent = settings.subtitleEnabled ? '开' : '关'; };
  refreshSubtitle();
  $('btnSubtitle').addEventListener('click', async () => {
    await saveSettings({ subtitleEnabled: !settings.subtitleEnabled });
    refreshSubtitle();
  });

  // 整页翻译
  $('btnPage').addEventListener('click', async () => {
    const tab = await currentTab();
    if (!tab?.id || !/^https?:/.test(tab.url || '')) {
      setStatus('当前页面不支持（仅限 http/https 页面）');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_TRANSLATE_TOGGLE' });
      window.close();
    } catch {
      setStatus('无法连接页面，请刷新网页后重试');
    }
  });

  // 直播实时翻译
  const st = await chrome.runtime.sendMessage({ type: 'GET_LIVE_STATE' }).catch(() => null);
  liveActive = !!st?.live?.active;
  refreshLiveBtn();

  $('btnLive').addEventListener('click', async () => {
    setStatus('');
    const tab = await currentTab();
    if (liveActive) {
      await chrome.runtime.sendMessage({ type: 'STOP_LIVE' }).catch(() => {});
      liveActive = false;
      refreshLiveBtn();
      return;
    }
    if (!tab?.id || !/^https?:/.test(tab.url || '')) {
      setStatus('请在要翻译的网页（如 YouTube 直播页）上点击本按钮');
      return;
    }
    if (!settings.asr?.apiKey) {
      setStatus('请先在「设置」中配置语音识别（ASR）API Key');
      return;
    }
    const resp = await chrome.runtime.sendMessage({ type: 'START_LIVE', tabId: tab.id }).catch((e) => ({ ok: false, error: e.message }));
    if (resp?.ok) {
      liveActive = true;
      refreshLiveBtn();
      setStatus('已开始，翻译结果将显示在页面浮窗中', true);
    } else {
      setStatus(resp?.error || '启动失败');
    }
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

init();
