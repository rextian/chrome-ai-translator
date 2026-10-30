/**
 * Offscreen 文档：捕获标签页音频并按固定时长分段，交给 Service Worker 做语音识别。
 * （MediaRecorder / getUserMedia 只能在文档环境中使用，不能直接在 SW 中运行）
 */

let mediaStream = null;
let recorder = null;
let active = false;
let segmentMs = 6000;
let keepAliveCtx = null;

async function startCapture(streamId, seconds) {
  stopCaptureInternal();
  segmentMs = Math.max(3, Number(seconds) || 6) * 1000;

  try {
    // 只请求音频轨：tabCapture 的音频是"复制"而非"移走"，原标签页继续出声。
    // 若同时请求 video 轨，Chrome 会接管整个标签页媒体流，导致原页面被静音。
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

  // 保活：AnalyserNode 拉流但不接 destination（无声），
  // 防止部分 Chrome 版本把 audio-only 捕获流判定为闲置而中断。
  try {
    keepAliveCtx = new (window.AudioContext || window.webkitAudioContext)();
    keepAliveCtx.createMediaStreamSource(mediaStream).connect(keepAliveCtx.createAnalyser());
    keepAliveCtx.resume().catch(() => {});
  } catch {}

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
  if (keepAliveCtx) { keepAliveCtx.close().catch(() => {}); keepAliveCtx = null; }
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
