import { PROVIDER_PRESETS, TARGET_LANGS, DEFAULT_SETTINGS, isProviderConfigured } from '../lib/presets.js';

const $ = (id) => document.getElementById(id);
const { t } = globalThis.AI_TR_I18N;

let settings = null;
let liveActive = false;

function lang() {
  return settings?.uiLang || 'auto';
}

function applyI18n() {
  const l = lang();
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(l, el.dataset.i18n);
  });
  refreshSubtitleBtn();
  refreshLiveBtn();
  refreshProviderInfo();
}

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
    el.textContent = t(lang(), 'key_ok');
    el.className = 'provider-info-line ok';
  } else {
    el.textContent = t(lang(), 'key_missing');
    el.className = 'provider-info-line miss';
  }
}

function refreshSubtitleBtn() {
  $('btnSubtitle').textContent = t(lang(), 'btn_subtitle', { state: t(lang(), settings.subtitleEnabled ? 'on' : 'off') });
}

function refreshLiveBtn() {
  const btn = $('btnLive');
  btn.textContent = t(lang(), liveActive ? 'btn_live_stop' : 'btn_live_start');
  btn.classList.toggle('stop', liveActive);
}

async function init() {
  await loadSettings();

  // 界面语言
  $('uiLang').value = settings.uiLang || 'auto';
  $('uiLang').addEventListener('change', async () => {
    await saveSettings({ uiLang: $('uiLang').value });
    applyI18n();
  });

  // 目标语言下拉（语言名以母语显示，不翻译）
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
    setStatus(t(lang(), $('autoTranslate').checked ? 'auto_on_tip' : 'auto_off_tip'), true);
  });

  // 字幕开关
  $('btnSubtitle').addEventListener('click', async () => {
    await saveSettings({ subtitleEnabled: !settings.subtitleEnabled });
    refreshSubtitleBtn();
  });

  // 整页翻译
  $('btnPage').addEventListener('click', async () => {
    const tab = await currentTab();
    if (!tab?.id || !/^https?:/.test(tab.url || '')) {
      setStatus(t(lang(), 'status_unsupported'));
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_TRANSLATE_TOGGLE' });
      window.close();
    } catch {
      setStatus(t(lang(), 'status_no_conn'));
    }
  });

  // 直播实时翻译
  const st = await chrome.runtime.sendMessage({ type: 'GET_LIVE_STATE' }).catch(() => null);
  liveActive = !!st?.live?.active;

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
      setStatus(t(lang(), 'status_live_hint'));
      return;
    }
    if (!settings.asr?.apiKey) {
      setStatus(t(lang(), 'status_need_asr'));
      return;
    }
    const resp = await chrome.runtime.sendMessage({ type: 'START_LIVE', tabId: tab.id }).catch((e) => ({ ok: false, error: e.message }));
    if (resp?.ok) {
      liveActive = true;
      refreshLiveBtn();
      setStatus(t(lang(), 'status_live_started'), true);
    } else {
      setStatus(resp?.error || 'Error');
    }
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  applyI18n();
}

init();
