/**
 * 内容脚本：划词翻译 / 整页双语翻译 / YouTube 字幕翻译 / 直播实时字幕浮窗
 */
(() => {
  'use strict';
  if (window.__aiTranslatorLoaded) return;
  window.__aiTranslatorLoaded = true;

  const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(location.hostname);

  const state = {
    settings: null,
    pageTranslated: false,
    pageTranslating: false,
    processedEls: new WeakSet(),   // 已翻译过的元素（增量去重）
    pageRunId: 0,                  // 翻译周期编号（还原时作废在途批次）
    // 自动翻译增量观察器
    autoObserver: null,
    pendingRoots: new Set(),
    autoTimer: null,
    autoScheduled: false,
    // YouTube 字幕
    captionObserver: null,
    bodyObserver: null,
    lastCaptionText: '',
    captionTimer: null,
    captionOverlay: null,
    captionClearTimer: null,
    // 直播浮窗
    liveBox: null,
    liveBody: null,
    liveStatus: null
  };

  /* ---------------- 设置 ---------------- */

  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.sync.get('settings');
      state.settings = settings || {};
    } catch {
      state.settings = {};
    }
  }

  function subtitleEnabled() {
    return state.settings?.subtitleEnabled !== false; // 默认开启
  }

  function showOriginal() {
    return state.settings?.showOriginal !== false;
  }

  function autoTranslate() {
    return state.settings?.autoTranslate === true;
  }

  function displayMode() {
    return state.settings?.pageDisplayMode === 'replace' ? 'replace' : 'bilingual';
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      const oldMode = state.settings?.pageDisplayMode;
      const oldAuto = state.settings?.autoTranslate;
      state.settings = changes.settings.newValue || {};
      if (!subtitleEnabled()) removeCaptionOverlay();
      // 显示模式变化：对已翻译内容即时切换
      if (state.pageTranslated && state.settings.pageDisplayMode !== oldMode) {
        applyDisplayMode();
      }
      // 自动翻译从关到开：检测当前页
      if (autoTranslate() && !oldAuto && !state.pageTranslated) {
        maybeAutoTranslate();
      }
      // 自动翻译关闭：停止增量观察器（保留已翻译内容）
      if (!autoTranslate() && oldAuto) {
        stopAutoObserver();
      }
    }
  });

  function sendMsg(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
  }

  /** 文案翻译（跟随界面语言设置） */
  function tr(key, vars) {
    return globalThis.AI_TR_I18N.t(state.settings?.uiLang || 'auto', key, vars);
  }

  /* ---------------- Toast ---------------- */

  let toastEl = null;
  let toastTimer = null;
  function toast(text, ms = 2600) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ai-tr-toast';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, ms);
  }

  // 进度提示节流，避免高频重绘
  let lastProgressAt = 0;
  function toastProgress(text) {
    const now = Date.now();
    if (now - lastProgressAt < 800) return;
    lastProgressAt = now;
    toast(text, 1800);
  }

  /** 批次翻译：失败自动重试一次（SW 恰好重启等瞬时故障可自愈） */
  async function translateBatchWithRetry(texts) {
    let resp = await sendMsg({ type: 'TRANSLATE_BATCH', texts });
    if (!resp?.ok) {
      await new Promise((r) => setTimeout(r, 900));
      resp = await sendMsg({ type: 'TRANSLATE_BATCH', texts });
    }
    return resp;
  }

  /* ---------------- 划词翻译 ---------------- */

  let selBtn = null;
  let selPanel = null;

  function removeSelUI() {
    if (selBtn) { selBtn.remove(); selBtn = null; }
    if (selPanel) { selPanel.remove(); selPanel = null; }
  }

  document.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      if (e.target && e.target.closest && e.target.closest('.ai-tr-panel, .ai-tr-selbtn, input, textarea, [contenteditable="true"]')) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      removeSelUI();
      if (!text || text.length < 2 || text.length > 800) return;
      if (!sel.rangeCount) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      showSelButton(rect, text);
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (selPanel && !selPanel.contains(e.target) && e.target !== selBtn) removeSelUI();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') removeSelUI(); });
  window.addEventListener('scroll', () => removeSelUI(), { passive: true, capture: true });

  function showSelButton(rect, text) {
    selBtn = document.createElement('button');
    selBtn.className = 'ai-tr-selbtn';
    selBtn.textContent = '译';
    selBtn.title = tr('sel_btn_title');
    const x = rect.left + window.scrollX + rect.width / 2 - 15;
    const y = rect.bottom + window.scrollY + 8;
    selBtn.style.left = Math.max(4, x) + 'px';
    selBtn.style.top = y + 'px';
    selBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSelPanel(rect, text);
    });
    document.documentElement.appendChild(selBtn);
  }

  async function showSelPanel(rect, text) {
    if (selBtn) { selBtn.remove(); selBtn = null; }
    selPanel = document.createElement('div');
    selPanel.className = 'ai-tr-panel';
    selPanel.innerHTML = `
      <div class="ai-tr-panel-head">
        <span class="ai-tr-panel-title">${tr('panel_title')}</span>
        <button class="ai-tr-panel-close" title="${tr('close')}">×</button>
      </div>
      <div class="ai-tr-panel-src"></div>
      <div class="ai-tr-panel-dst ai-tr-panel-loading">${tr('panel_loading')}</div>`;
    selPanel.querySelector('.ai-tr-panel-src').textContent = text;
    selPanel.querySelector('.ai-tr-panel-close').addEventListener('click', removeSelUI);

    const x = Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 356);
    const y = rect.bottom + window.scrollY + 8;
    selPanel.style.left = Math.max(8, x) + 'px';
    selPanel.style.top = y + 'px';
    document.documentElement.appendChild(selPanel);

    const resp = await sendMsg({ type: 'TRANSLATE_TEXT', text });
    const dst = selPanel && selPanel.querySelector('.ai-tr-panel-dst');
    if (!dst) return;
    dst.classList.remove('ai-tr-panel-loading');
    dst.textContent = resp?.ok ? resp.translation : tr('translate_failed', { msg: resp?.error || 'unknown' });
  }

  /* ---------------- 整页双语翻译 ---------------- */

  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'SUMMARY']);
  const MAX_PAGE_ELEMENTS = 400;
  const BATCH_SIZE = 15;

  /** 从 rootNode 下收集可翻译元素（seen 文本去重，processedEls 元素去重） */
  function collectElements(rootNode, seen, limit) {
    const out = [];
    const processed = state.processedEls;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
    // createTreeWalker 从 rootNode 的后代开始，rootNode 自身需单独判断
    const candidates = [];
    if (rootNode.nodeType === 1 && BLOCK_TAGS.has(rootNode.tagName)) candidates.push(rootNode);
    let el;
    while ((el = walker.nextNode())) candidates.push(el);

    for (const node of candidates) {
      if (out.length >= limit) break;
      if (processed.has(node)) continue;
      if (!BLOCK_TAGS.has(node.tagName)) continue;
      if (node.closest('script, style, noscript, code, pre, textarea, [contenteditable="true"], .ai-tr-panel, .ai-tr-live, .ai-tr-toast, .ai-tr-block, .ai-tr-selbtn')) continue;
      // 容器内含块级子元素则跳过（避免嵌套重复翻译）
      let hasBlockChild = false;
      for (const child of node.children) {
        if (BLOCK_TAGS.has(child.tagName)) { hasBlockChild = true; break; }
      }
      if (hasBlockChild) continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = (node.innerText || '').trim();
      if (text.length < 2 || text.length > 1500) continue;
      if (!/[\p{L}]/u.test(text)) continue; // 必须含文字
      if (seen.has(text)) continue;
      seen.add(text);
      processed.add(node);
      out.push({ el: node, text });
    }
    return out;
  }

  /** 把译文应用到元素：双语=插入译文块；仅译文=再隐藏原文 */
  function applyTranslation(el, translation) {
    const div = document.createElement('div');
    div.className = 'ai-tr-block';
    div.textContent = translation;
    el.after(div);
    el.classList.add('ai-tr-origin');
    if (displayMode() === 'replace') el.classList.add('ai-tr-hidden');
  }

  /** 显示模式切换（双语 ↔ 仅译文） */
  function applyDisplayMode() {
    const hide = displayMode() === 'replace';
    document.querySelectorAll('.ai-tr-origin').forEach((el) => {
      el.classList.toggle('ai-tr-hidden', hide);
    });
  }

  function removePageTranslation() {
    document.querySelectorAll('.ai-tr-block').forEach((n) => n.remove());
    document.querySelectorAll('.ai-tr-origin').forEach((n) => n.classList.remove('ai-tr-origin', 'ai-tr-hidden'));
    state.pageTranslated = false;
    state.pageRunId++; // 作废在途的翻译批次
  }

  async function translatePage() {
    if (state.pageTranslating) { toast(tr('translating_wait')); return; }
    const items = collectElements(document.body, new Set(), MAX_PAGE_ELEMENTS);
    if (!items.length) { toast(tr('nothing_to_translate')); return; }

    // 视口优先：当前可见区域的段落排最前，先翻先显示；屏外后台继续
    const vh = window.innerHeight;
    items.forEach((it) => { it._top = it.el.getBoundingClientRect().top; });
    items.sort((a, b) => {
      const av = (a._top >= -100 && a._top < vh) ? 0 : 1;
      const bv = (b._top >= -100 && b._top < vh) ? 0 : 1;
      return av - bv || Math.abs(a._top) - Math.abs(b._top);
    });

    state.pageTranslating = true;
    const runId = ++state.pageRunId;
    let done = 0;
    let failed = false;
    toast(tr('quick_start', { n: items.length }), 3000);

    // 分批 + 滑动窗口（最多 5 批在飞）：避免几十条消息同时挂起导致瞬时压力与卡顿
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      batches.push(items.slice(i, i + BATCH_SIZE));
    }
    const WINDOW = 5;
    let cursor = 0;

    async function worker() {
      while (cursor < batches.length && !failed) {
        const batch = batches[cursor++];
        const resp = await translateBatchWithRetry(batch.map((b) => b.text));
        if (runId !== state.pageRunId) return; // 用户已还原，丢弃结果
        if (!resp?.ok) {
          failed = true;
          toast(tr('translate_failed', { msg: resp?.error || 'unknown' }), 5000);
          return;
        }
        // rAF 错峰插入，避免同帧大量 DOM 修改造成卡顿
        await new Promise((resolve) => requestAnimationFrame(() => {
          batch.forEach(({ el }, j) => {
            const t = resp.translations[j];
            if (!t || !el.isConnected) return;
            applyTranslation(el, t);
          });
          resolve();
        }));
        state.pageTranslated = true;
        done += batch.length;
        toastProgress(tr('progress', { done, total: items.length }));
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(WINDOW, batches.length) }, worker));
      if (state.pageTranslated && !failed && runId === state.pageRunId) {
        toast(tr('translate_done', { n: done }), 2500);
      }
    } finally {
      state.pageTranslating = false;
    }
  }

  /* ---------------- 自动翻译（打开网页自动触发 + 无限滚动增量翻译） ---------------- */

  /** 检测页面语言：若已是目标语言则无需翻译 */
  function detectPageNeedsTranslation(targetLang) {
    const lang = (document.documentElement.lang || '').toLowerCase();
    const targetPrimary = targetLang.toLowerCase().split('-')[0]; // zh / en / ja ...
    if (lang) {
      const pagePrimary = lang.split('-')[0];
      if (pagePrimary === targetPrimary) return false; // html lang 与目标一致，无需翻译
      // 目标中文但页面明确标注其他中文变体
      if (targetPrimary === 'zh' && pagePrimary === 'zh') return false;
    }
    // 内容采样：目标是中文时，页面中文占比高则跳过
    const text = (document.body?.innerText || '').slice(0, 3000);
    if (text.replace(/\s/g, '').length > 50) {
      const han = (text.match(/[一-鿿]/g) || []).length;
      if (targetPrimary === 'zh' && han / text.length > 0.15) return false;
    }
    return true;
  }

  async function maybeAutoTranslate() {
    if (!autoTranslate() || state.pageTranslated || state.pageTranslating) return;
    if (!document.body) return;
    const settings = state.settings || {};
    if (!detectPageNeedsTranslation(settings.targetLang || 'zh-CN')) return;
    await translatePage();
    if (state.pageTranslated) startAutoObserver();
  }

  function startAutoObserver() {
    if (state.autoObserver || !document.body) return;
    state.autoObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.closest && node.closest('.ai-tr-block, .ai-tr-panel, .ai-tr-live, .ai-tr-toast, .ai-tr-selbtn')) continue;
          if (node.classList && (node.classList.contains('ai-tr-block') || node.classList.contains('ai-tr-panel'))) continue;
          state.pendingRoots.add(node);
        }
      }
      clearTimeout(state.autoTimer);
      state.autoTimer = setTimeout(processPendingRoots, 1800);
    });
    state.autoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopAutoObserver() {
    if (state.autoObserver) { state.autoObserver.disconnect(); state.autoObserver = null; }
    state.pendingRoots.clear();
    clearTimeout(state.autoTimer);
  }

  /** 增量翻译新出现的元素（如无限滚动加载的内容） */
  async function processPendingRoots() {
    if (!state.pageTranslated || state.pageTranslating) return;
    if (!autoTranslate()) return;
    const roots = [...state.pendingRoots];
    state.pendingRoots.clear();

    const seen = new Set();
    const items = [];
    for (const root of roots.slice(0, 80)) {
      if (!root.isConnected) continue;
      if (items.length >= 60) break;
      collectElements(root, seen, 60 - items.length).forEach((it) => items.push(it));
    }
    if (!items.length) return;

    const runId = state.pageRunId;
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      batches.push(items.slice(i, i + BATCH_SIZE));
    }
    // 增量翻译：2 批并发窗口，低调进行
    const WINDOW = 2;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(WINDOW, batches.length) }, async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        const resp = await translateBatchWithRetry(batch.map((b) => b.text));
        if (!resp?.ok || runId !== state.pageRunId || !state.pageTranslated) return;
        await new Promise((resolve) => requestAnimationFrame(() => {
          batch.forEach(({ el }, j) => {
            if (resp.translations[j] && el.isConnected) applyTranslation(el, resp.translations[j]);
          });
          resolve();
        }));
      }
    }));
  }

  /* ---------------- YouTube 字幕翻译 ---------------- */

  function findPlayer() {
    return document.querySelector('.html5-video-player') || document.getElementById('movie_player');
  }

  function ensureCaptionOverlay() {
    if (state.captionOverlay && state.captionOverlay.isConnected) return state.captionOverlay;
    const player = findPlayer();
    if (!player) return null;
    const div = document.createElement('div');
    div.className = 'ai-tr-yt-sub';
    div.innerHTML = '<span></span>';
    div.style.display = 'none';
    player.appendChild(div);
    state.captionOverlay = div;
    return div;
  }

  function removeCaptionOverlay() {
    if (state.captionOverlay) { state.captionOverlay.remove(); state.captionOverlay = null; }
    state.lastCaptionText = '';
  }

  function renderCaptionTranslation(text) {
    const overlay = ensureCaptionOverlay();
    if (!overlay) return;
    const span = overlay.firstElementChild;
    if (!text) {
      overlay.style.display = 'none';
      span.textContent = '';
      return;
    }
    span.textContent = text;
    overlay.style.display = 'block';
  }

  function getCaptionContainer() {
    return document.querySelector('.ytp-caption-window-container');
  }

  function captionText() {
    const c = getCaptionContainer();
    if (!c) return '';
    return (c.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function onCaptionChange() {
    if (!subtitleEnabled()) return;
    const text = captionText();
    if (!text || text === state.lastCaptionText) return;
    state.lastCaptionText = text;

    // 字幕逐词滚动出现，防抖等待句子稳定
    clearTimeout(state.captionTimer);
    state.captionTimer = setTimeout(async () => {
      const current = captionText();
      if (!current || current !== state.lastCaptionText) return;
      const resp = await sendMsg({ type: 'TRANSLATE_TEXT', text: current, mode: 'subtitle' });
      if (resp?.ok && state.lastCaptionText === current) {
        renderCaptionTranslation(resp.translation);
      }
    }, 450);

    clearTimeout(state.captionClearTimer);
    state.captionClearTimer = setTimeout(() => {
      if (!captionText()) {
        renderCaptionTranslation('');
        state.lastCaptionText = '';
      }
    }, 3000);
  }

  function attachCaptionObserver() {
    const container = getCaptionContainer();
    if (!container) return false;
    if (state.captionObserver) state.captionObserver.disconnect();
    state.captionObserver = new MutationObserver(onCaptionChange);
    state.captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
    return true;
  }

  function initYouTubeCaptions() {
    if (state.bodyObserver) return;
    // 字幕容器随视频播放动态出现，在 body 上观察（节流检查，避免高频 querySelector）
    let lastCheck = 0;
    state.bodyObserver = new MutationObserver(() => {
      if (!subtitleEnabled()) return;
      const now = Date.now();
      if (now - lastCheck < 500) return;
      lastCheck = now;
      if (location.pathname === '/watch' && (!state.captionOverlay || !state.captionOverlay.isConnected)) ensureCaptionOverlay();
      if (!state.captionObserver || !getCaptionContainer()?.isConnected) {
        attachCaptionObserver();
      }
    });
    state.bodyObserver.observe(document.body, { childList: true, subtree: true });
    attachCaptionObserver();
  }

  /* ---------------- 直播实时翻译浮窗 ---------------- */

  function fullscreenHost() {
    return document.fullscreenElement || null;
  }

  function moveLiveBox() {
    if (!state.liveBox) return;
    const host = fullscreenHost();
    if (host) {
      if (state.liveBox.parentElement !== host) host.appendChild(state.liveBox);
      state.liveBox.style.position = 'absolute';
    } else {
      if (state.liveBox.parentElement !== document.documentElement) document.documentElement.appendChild(state.liveBox);
      state.liveBox.style.position = 'fixed';
    }
  }

  document.addEventListener('fullscreenchange', moveLiveBox);

  function ensureLiveBox() {
    if (state.liveBox && state.liveBox.isConnected) return state.liveBox;
    const box = document.createElement('div');
    box.className = 'ai-tr-live';
    box.innerHTML = `
      <div class="ai-tr-live-head">
        <span class="ai-tr-live-title"><span class="ai-tr-live-dot"></span>${tr('live_title')}</span>
        <button class="ai-tr-live-close" title="${tr('live_close_tip')}">×</button>
      </div>
      <div class="ai-tr-live-body">
        <div class="ai-tr-live-status" style="display:none"></div>
      </div>`;
    state.liveBody = box.querySelector('.ai-tr-live-body');
    state.liveStatus = box.querySelector('.ai-tr-live-status');
    box.querySelector('.ai-tr-live-close').addEventListener('click', () => { box.remove(); state.liveBox = null; });

    // 拖拽
    const head = box.querySelector('.ai-tr-live-head');
    head.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      box.style.transform = 'none';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.bottom = 'auto';
      const onMove = (ev) => {
        box.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - dx)) + 'px';
        box.style.top = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy)) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    document.documentElement.appendChild(box);
    state.liveBox = box;
    moveLiveBox();
    return box;
  }

  function addLiveLine(original, translation) {
    ensureLiveBox();
    if (!state.liveBody) return;
    // 旧行淡化
    state.liveBody.querySelectorAll('.ai-tr-line').forEach((n) => n.classList.add('ai-tr-line-old'));
    const line = document.createElement('div');
    line.className = 'ai-tr-line';
    const srcHtml = showOriginal() ? `<div class="ai-tr-line-src"></div>` : '';
    line.innerHTML = `${srcHtml}<div class="ai-tr-line-dst"></div>`;
    if (showOriginal()) line.querySelector('.ai-tr-line-src').textContent = original;
    line.querySelector('.ai-tr-line-dst').textContent = translation;
    state.liveBody.appendChild(line);
    // 最多保留 4 条
    while (state.liveBody.querySelectorAll('.ai-tr-line').length > 4) {
      state.liveBody.querySelector('.ai-tr-line').remove();
    }
    state.liveBody.scrollTop = state.liveBody.scrollHeight;
  }

  function setLiveStatus(text) {
    ensureLiveBox();
    if (!state.liveStatus) return;
    if (!text) {
      state.liveStatus.style.display = 'none';
      state.liveStatus.textContent = '';
    } else {
      state.liveStatus.style.display = 'block';
      state.liveStatus.textContent = text;
    }
  }

  /* ---------------- 消息路由 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'TRANSLATE_SELECTION': {
        const text = (window.getSelection() || '').toString().trim();
        if (!text) { toast(tr('select_first')); return; }
        const sel = window.getSelection();
        const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : { left: 100, bottom: 100, width: 0 };
        removeSelUI();
        showSelPanel(rect, text);
        break;
      }
      case 'PAGE_TRANSLATE_TOGGLE':
        if (state.pageTranslated) {
          state.pageTranslated = false;
          stopAutoObserver();
          removePageTranslation();
          toast(tr('restored'));
        } else {
          translatePage().then(() => {
            if (state.pageTranslated && autoTranslate()) startAutoObserver();
          });
        }
        break;
      case 'LIVE_STARTED':
        ensureLiveBox();
        setLiveStatus('');
        toast(tr('live_started_toast'));
        break;
      case 'LIVE_SUBTITLE':
        addLiveLine(msg.original, msg.translation);
        setLiveStatus('');
        break;
      case 'LIVE_STATUS':
        setLiveStatus(msg.status);
        break;
      case 'LIVE_STOPPED':
        setLiveStatus('');
        if (state.liveBox) { state.liveBox.remove(); state.liveBox = null; }
        toast(tr('live_stopped_toast'));
        break;
    }
  });

  /* ---------------- 启动 ---------------- */

  (async () => {
    await loadSettings();
    if (IS_YOUTUBE && subtitleEnabled()) {
      // 等 body 就绪
      if (document.body) initYouTubeCaptions();
      else document.addEventListener('DOMContentLoaded', initYouTubeCaptions);
    }
    // 若该标签页正在进行直播翻译，补上浮窗
    try {
      const resp = await sendMsg({ type: 'GET_LIVE_STATE' });
      if (resp?.ok && resp.live?.active) ensureLiveBox();
    } catch {}
    // 自动翻译：等页面内容稳定后检测并执行
    if (autoTranslate()) {
      const kick = () => setTimeout(maybeAutoTranslate, 1200);
      if (document.readyState === 'complete') kick();
      else window.addEventListener('load', kick, { once: true });
    }
  })();
})();
