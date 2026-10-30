/**
 * Offscreen 文档：捕获标签页音频并按固定时长分段，交给 Service Worker 做语音识别。
 * （MediaRecorder / getUserMedia 只能在文档环境中使用，不能直接在 SW 中运行）
 */

let mediaStream = null;
let recorder = null;
let active = false;
let segmentMs = 6000;
let keepAliveVideo = null;

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
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: 2,
          maxHeight: 2
        }
      }
    });
  } catch (e) {
    reportError('无法捕获标签页音频：' + e.message);
    return;
  }

  // 用一个隐藏 video 元素保持媒体流活跃
  keepAliveVideo = document.createElement('video');
  keepAliveVideo.muted = true;
  keepAliveVideo.srcObject = mediaStream;
  keepAliveVideo.play().catch(() => {});

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
    if (blob.size > 1000) sendBlob(blob);
    if (active) setTimeout(runSegment, 30);
  };

  rec.start();
  setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, segmentMs);
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
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (keepAliveVideo) {
    keepAliveVideo.srcObject = null;
    keepAliveVideo = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'START_CAPTURE') startCapture(msg.streamId, msg.segmentSeconds);
  else if (msg.type === 'STOP_CAPTURE') stopCaptureInternal();
});
