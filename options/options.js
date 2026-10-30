import { PROVIDER_PRESETS, ASR_PRESETS, TARGET_LANGS, DEFAULT_SETTINGS } from '../lib/presets.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let saveTimer = null;

function showSaved() {
  const el = $('saveTip');
  el.classList.add('show');
  clearTimeout(showSaved._t);
  showSaved._t = setTimeout(() => el.classList.remove('show'), 1400);
}

async function save() {
  await chrome.storage.sync.set({ settings });
  showSaved();
}

function saveDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function loadSettings() {
  const { settings: s } = await chrome.storage.sync.get('settings');
  settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s || {});
  if (s?.providers) {
    for (const [p, cfg] of Object.entries(s.providers)) {
      settings.providers[p] = Object.assign({}, DEFAULT_SETTINGS.providers[p] || {}, cfg);
    }
  }
  if (s?.asr) settings.asr = Object.assign({}, DEFAULT_SETTINGS.asr, s.asr);
}

/* ---------- 翻译服务（三种协议的字段读写） ---------- */

function providerType(key) {
  return PROVIDER_PRESETS[key]?.type || 'llm';
}

/** 把当前 provider 的配置读入表单 */
function refreshProviderFields() {
  const key = $('provider').value;
  const preset = PROVIDER_PRESETS[key] || {};
  const cfg = settings.providers[key] || {};
  const type = providerType(key);

  $('group-llm').style.display = type === 'llm' ? '' : 'none';
  $('group-aliyun').style.display = type === 'aliyun' ? '' : 'none';
  $('group-baidu').style.display = type === 'baidu' ? '' : 'none';

  if (type === 'llm') {
    $('llmKey').value = cfg.apiKey || '';
    $('llmBaseUrl').value = cfg.baseUrl || '';
    $('llmModel').value = cfg.model || '';
    const list = $('llmModelList');
    list.innerHTML = '';
    (preset.models || []).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    });
    $('llmModelHint').style.display = (key === 'doubao' || key === 'zhipu') ? '' : 'none';
  } else if (type === 'aliyun') {
    $('aliyunAccessKeyId').value = cfg.accessKeyId || '';
    $('aliyunAccessKeySecret').value = cfg.accessKeySecret || '';
    $('aliyunRegionId').value = cfg.regionId || 'cn-hangzhou';
  } else if (type === 'baidu') {
    $('baiduAppid').value = cfg.appid || '';
    $('baiduKey').value = cfg.key || '';
  }

  const link = $('llmKeyLink');
  if (preset.keyPage && type === 'llm') { link.href = preset.keyPage; link.style.display = ''; }
  else link.style.display = 'none';
  const alink = $('aliyunKeyLink');
  if (preset.keyPage && type === 'aliyun') alink.href = preset.keyPage;
  const blink = $('baiduKeyLink');
  if (preset.keyPage && type === 'baidu') blink.href = preset.keyPage;
}

/** 把表单值写回当前 provider 的配置 */
function collectProviderFields() {
  const key = $('provider').value;
  const type = providerType(key);
  if (type === 'llm') {
    settings.providers[key] = {
      apiKey: $('llmKey').value.trim(),
      baseUrl: $('llmBaseUrl').value.trim(),
      model: $('llmModel').value.trim()
    };
  } else if (type === 'aliyun') {
    settings.providers[key] = {
      accessKeyId: $('aliyunAccessKeyId').value.trim(),
      accessKeySecret: $('aliyunAccessKeySecret').value.trim(),
      regionId: $('aliyunRegionId').value.trim() || 'cn-hangzhou'
    };
  } else if (type === 'baidu') {
    settings.providers[key] = {
      appid: $('baiduAppid').value.trim(),
      key: $('baiduKey').value.trim()
    };
  }
}

/* ---------- 语音识别 ---------- */

function refreshAsrFields() {
  const preset = $('asrPreset').value;
  const p = ASR_PRESETS[preset];
  const cfg = settings.asr || {};

  $('asrKey').value = cfg.apiKey || '';
  $('asrBaseUrl').value = cfg.baseUrl || '';
  $('asrModel').value = cfg.model || '';

  const link = $('asrKeyLink');
  if (p?.keyPage) { link.href = p.keyPage; link.style.display = ''; }
  else link.style.display = 'none';

  const list = $('asrModelList');
  list.innerHTML = '';
  (p?.models || []).forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  });
}

function collectAsrFields() {
  settings.asr = {
    preset: $('asrPreset').value,
    apiKey: $('asrKey').value.trim(),
    baseUrl: $('asrBaseUrl').value.trim(),
    model: $('asrModel').value.trim()
  };
  settings.segmentSeconds = Number($('segmentSeconds').value) || 6;
}

/* ---------- 测试 ---------- */

async function runTest(type, btn, resultEl) {
  btn.disabled = true;
  resultEl.textContent = '测试中…';
  resultEl.className = 'test-result';
  try {
    const resp = await chrome.runtime.sendMessage({ type });
    if (resp?.ok) {
      resultEl.textContent = '✓ ' + (resp.detail || '连接成功');
      resultEl.classList.add('ok');
    } else {
      resultEl.textContent = '✗ ' + (resp?.error || '失败');
      resultEl.classList.add('err');
    }
  } catch (e) {
    resultEl.textContent = '✗ ' + e.message;
    resultEl.classList.add('err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 初始化 ---------- */

async function init() {
  await loadSettings();

  // 服务商下拉
  for (const [key, p] of Object.entries(PROVIDER_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    $('provider').appendChild(opt);
  }
  $('provider').value = settings.provider;

  for (const [key, p] of Object.entries(ASR_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    $('asrPreset').appendChild(opt);
  }
  $('asrPreset').value = settings.asr.preset;

  // 目标语言
  for (const [code, name] of TARGET_LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    $('targetLang').appendChild(opt);
  }
  $('targetLang').value = settings.targetLang;

  refreshProviderFields();
  refreshAsrFields();
  $('segmentSeconds').value = String(settings.segmentSeconds || 6);
  $('subtitleEnabled').checked = settings.subtitleEnabled !== false;
  $('showOriginal').checked = settings.showOriginal !== false;
  $('autoTranslate').checked = settings.autoTranslate === true;
  $('pageDisplayMode').value = settings.pageDisplayMode || 'bilingual';

  // ---- 翻译服务事件 ----
  let prevProvider = settings.provider;
  $('provider').addEventListener('change', () => {
    // 先把输入框的值存回旧服务商，再切换
    const oldKey = prevProvider;
    const oldType = providerType(oldKey);
    // 输入框当前是旧服务商的值
    if (oldType === 'llm') {
      settings.providers[oldKey] = {
        apiKey: $('llmKey').value.trim(),
        baseUrl: $('llmBaseUrl').value.trim(),
        model: $('llmModel').value.trim()
      };
    } else if (oldType === 'aliyun') {
      settings.providers[oldKey] = {
        accessKeyId: $('aliyunAccessKeyId').value.trim(),
        accessKeySecret: $('aliyunAccessKeySecret').value.trim(),
        regionId: $('aliyunRegionId').value.trim() || 'cn-hangzhou'
      };
    } else if (oldType === 'baidu') {
      settings.providers[oldKey] = {
        appid: $('baiduAppid').value.trim(),
        key: $('baiduKey').value.trim()
      };
    }
    settings.provider = $('provider').value;
    prevProvider = settings.provider;
    refreshProviderFields();
    saveDebounced();
  });

  const llmInputs = ['llmKey', 'llmBaseUrl', 'llmModel', 'aliyunAccessKeyId', 'aliyunAccessKeySecret', 'aliyunRegionId', 'baiduAppid', 'baiduKey'];
  llmInputs.forEach((id) => $(id).addEventListener('input', () => {
    settings.provider = prevProvider;
    collectProviderFields();
    saveDebounced();
  }));

  // ---- ASR 事件 ----
  let prevAsrPreset = settings.asr.preset;
  $('asrPreset').addEventListener('change', () => {
    const key = $('asrKey').value.trim();
    const p = ASR_PRESETS[$('asrPreset').value] || {};
    settings.asr = {
      preset: $('asrPreset').value,
      apiKey: key,
      baseUrl: p.baseUrl || '',
      model: (p.models && p.models[0]) || ''
    };
    prevAsrPreset = settings.asr.preset;
    refreshAsrFields();
    saveDebounced();
  });
  ['asrKey', 'asrBaseUrl', 'asrModel'].forEach((id) => $(id).addEventListener('input', () => {
    settings.asr = {
      preset: prevAsrPreset,
      apiKey: $('asrKey').value.trim(),
      baseUrl: $('asrBaseUrl').value.trim(),
      model: $('asrModel').value.trim()
    };
    saveDebounced();
  }));
  $('segmentSeconds').addEventListener('change', () => { collectAsrFields(); saveDebounced(); });

  // ---- 通用事件 ----
  $('targetLang').addEventListener('change', () => { settings.targetLang = $('targetLang').value; saveDebounced(); });
  $('subtitleEnabled').addEventListener('change', () => { settings.subtitleEnabled = $('subtitleEnabled').checked; saveDebounced(); });
  $('showOriginal').addEventListener('change', () => { settings.showOriginal = $('showOriginal').checked; saveDebounced(); });
  $('autoTranslate').addEventListener('change', () => { settings.autoTranslate = $('autoTranslate').checked; saveDebounced(); });
  $('pageDisplayMode').addEventListener('change', () => { settings.pageDisplayMode = $('pageDisplayMode').value; saveDebounced(); });

  $('testLlm').addEventListener('click', async () => {
    settings.provider = prevProvider;
    collectProviderFields();
    await save();
    runTest('TEST_LLM', $('testLlm'), $('llmTestResult'));
  });
  $('testAsr').addEventListener('click', async () => {
    collectAsrFields();
    await save();
    runTest('TEST_ASR', $('testAsr'), $('asrTestResult'));
  });
}

init();
