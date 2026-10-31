/**
 * Offscreen 文档：捕获标签页音频并按固定时长分段，交给 Service Worker 做语音识别。
 * （MediaRecorder / getUserMedia 只能在文档环境中使用，不能直接在 SW 中运行）
 */

let mediaStream = null;
let recorder = null;
let active = false;
let segmentMs = 6000;
let playbackCtx = null;

async function startCapture(streamId, seconds) {
  stopCaptureInternal();
  segmentMs = Math.max(3, Number(seconds) || 6) * 1000;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
  } catch (e) {
    reportError('无法捕获标签页音频：' + e.message);
    return;
  }

  // 关键：tabCapture 捕获标签页音频后，Chrome 会把原标签页静音（音频被重定向到捕获流）。
  // 官方做法：在 offscreen 里把捕获流接到 AudioContext.destination 重新播放给用户。
  // 同时这条播放链路也保证了捕获流持续活跃（无需额外保活）。
  try {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = playbackCtx.createMediaStreamSource(mediaStream);
    source.connect(playbackCtx.destination);
    playbackCtx.resume().catch(() => {});
  } catch (e) {
    reportError('音频回放初始化失败：' + e.message);
  }

  active = true;
  runSegment();
}

function runSegment() {
  if (!active || !mediaStream) return;

  const audioTracks = mediaStream.getAudioTracks();
  if (!audioTracks.length) {
    reportError('未获取到音轨，请确认页面正在播放声音');
    return;
  }

  const audioStream = new MediaStream(audioTracks);
  let rec;
  try {
    rec = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
  } catch {
    try { rec = new MediaRecorder(audioStream); }
    catch (e) { reportError('MediaRecorder 初始化失败：' + e.message); return; }
  }
  recorder = rec;

  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size > 1000) convertAndSend(blob);
    if (active) setTimeout(runSegment, 30);
  };

  rec.start();
  setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, segmentMs);
}

/* ---------------- 音频转 WAV（16kHz mono 16bit） ----------------
 * 各 ASR 平台对格式的支持不同：Gemini 不认 webm，whisper/SenseVoice 都认 wav。
 * 统一转 WAV 后全平台通吃，且 16kHz mono 体积小、识别率稳定。
 */

let audioCtx = null;

async function webmToWav(blob) {
  const ab = await blob.arrayBuffer();
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuf = await audioCtx.decodeAudioData(ab);
  const samples = resampleToMono(audioBuf, 16000);
  return new Blob([encodeWav16bit(samples, 16000)], { type: 'audio/wav' });
}

function resampleToMono(audioBuf, targetRate) {
  const ch0 = audioBuf.getChannelData(0);
  const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;
  const ratio = audioBuf.sampleRate / targetRate;
  const outLen = Math.max(1, Math.floor(audioBuf.length / ratio));
  const out = new Float32Array(outLen);
  const div = ch1 ? 2 : 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const next = Math.min(idx + 1, audioBuf.length - 1);
    const a = (ch0[idx] + (ch1 ? ch1[idx] : 0)) / div;
    const b = (ch0[next] + (ch1 ? ch1[next] : 0)) / div;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function encodeWav16bit(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

function convertAndSend(blob) {
  webmToWav(blob)
    .then(sendBlob)
    .catch(() => sendBlob(blob)); // 转码失败时回退发原始 webm
}

function sendBlob(blob) {
  const reader = new FileReader();
  reader.onloadend = () => {
    chrome.runtime.sendMessage({ type: 'ASR_SEGMENT', dataUrl: reader.result });
  };
  reader.readAsDataURL(blob);
}

function reportError(msg) {
  chrome.runtime.sendMessage({ type: 'LIVE_ERROR', error: msg });
}

function stopCaptureInternal() {
  active = false;
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
  recorder = null;
  if (playbackCtx) { playbackCtx.close().catch(() => {}); playbackCtx = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'START_CAPTURE') startCapture(msg.streamId, msg.segmentSeconds);
  else if (msg.type === 'STOP_CAPTURE') stopCaptureInternal();
});
