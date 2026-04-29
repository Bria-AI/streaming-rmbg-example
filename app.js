/**
 * Flow: choose video → Start → WebSocket opens → spawn encode + composite workers,
 * transfer output canvas Offscreen → algorithm.tick() each animation frame.
 * Stop sends { type: "stop" } and tears down workers.
 */
import { StreamingRmbgAlgorithm } from "./algorithm.js";
import { DEFAULT_WS_URL, USER_VISIBLE_CLOSE_CODES } from "./constants.js";
import { buildStreamingWsUrl, StreamingRmbgWsClient } from "./ws_client.js";

function findAppScriptUrl() {
  const el = document.querySelector('script[src*="app.js"]');
  if (el?.src) {
    return el.src;
  }
  return new URL("app.js", window.location.href).href;
}

function createEncodeWorker() {
  return new Worker(new URL("rmbg_encode_worker.js", findAppScriptUrl()).href);
}

function createCompositeWorker() {
  return new Worker(new URL("rmbg_offscreen_worker.js", findAppScriptUrl()).href);
}

function remountProcessedCanvas(width, height) {
  const wrap = document.getElementById("processed-wrap");
  const old = document.getElementById("processed-canvas");
  if (!wrap || !old) return null;
  const next = document.createElement("canvas");
  next.id = "processed-canvas";
  next.width = width;
  next.height = height;
  wrap.replaceChild(next, old);
  return next;
}

const serverUrlInput = document.getElementById("server-url");
const authTokenInput = document.getElementById("auth-token");
const fileInput = document.getElementById("file-input");
const fileBtnLabel = document.getElementById("file-btn-label");
const originalCanvas = document.getElementById("original-canvas");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const muteCheckbox = document.getElementById("mute-checkbox");
const video = document.getElementById("video");
const origPlaceholder = document.getElementById("orig-placeholder");
const procPlaceholder = document.getElementById("proc-placeholder");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const statFps = document.getElementById("stat-fps");
const errorBanner = document.getElementById("error-banner");
const errorText = document.getElementById("error-text");

const origCtx = originalCanvas.getContext("2d");

/** @type {{ url: string; name: string } | null} */
let loadedVideo = null;

/** @type {StreamingRmbgWsClient | null} */
let wsClient = null;
/** @type {Worker | null} */
let encodeWorker = null;
/** @type {Worker | null} */
let compositeWorker = null;
/** @type {StreamingRmbgAlgorithm | null} */
let engine = null;

let rafId = 0;
let sessionActive = false;
let intentionalWsClose = false;

let fpsAcc = 0;
let fpsWindowStart = performance.now();

function resetFpsMeter() {
  fpsAcc = 0;
  fpsWindowStart = performance.now();
}

function setStatus(text, active) {
  statusText.textContent = text;
  statusDot.classList.toggle("active", active);
}

function showError(message) {
  errorBanner.hidden = false;
  errorText.textContent = message;
}

function hideError() {
  errorBanner.hidden = true;
  errorText.textContent = "";
}

function onFpsTick() {
  fpsAcc++;
  const now = performance.now();
  if (now - fpsWindowStart >= 1000) {
    const fps = (fpsAcc * 1000) / (now - fpsWindowStart);
    statFps.textContent = `${fps.toFixed(1)} fps`;
    fpsAcc = 0;
    fpsWindowStart = now;
  }
}

function setLoadedVideoUi() {
  startBtn.disabled = !loadedVideo;
  fileBtnLabel.textContent = loadedVideo ? loadedVideo.name : "Choose video…";
}

async function prepareVideoForSession() {
  if (!loadedVideo) {
    throw new Error("Choose a video file first.");
  }
  video.src = loadedVideo.url;
  video.muted = muteCheckbox.checked;
  await new Promise((resolve, reject) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
      resolve();
      return;
    }
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("Video failed to load.")), { once: true });
  });
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("Wait until the video has loaded.");
  }
  const w = video.videoWidth;
  const h = video.videoHeight;
  originalCanvas.width = w;
  originalCanvas.height = h;
  remountProcessedCanvas(w, h);
  origPlaceholder.style.display = "none";
  await video.play();
}

fileInput.addEventListener("change", () => {
  if (loadedVideo) {
    URL.revokeObjectURL(loadedVideo.url);
    loadedVideo = null;
  }
  const f = fileInput.files?.[0];
  if (!f) {
    setLoadedVideoUi();
    return;
  }
  loadedVideo = { url: URL.createObjectURL(f), name: f.name };
  video.src = loadedVideo.url;
  video.muted = muteCheckbox.checked;
  void video.play().catch(() => {});
  setLoadedVideoUi();
});

muteCheckbox.addEventListener("change", () => {
  video.muted = muteCheckbox.checked;
});

video.addEventListener("loadedmetadata", () => {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  originalCanvas.width = w;
  originalCanvas.height = h;
  if (!sessionActive) {
    remountProcessedCanvas(w, h);
  }
  origPlaceholder.style.display = "none";
});

video.addEventListener("ended", () => {
  if (!sessionActive) return;
  video.currentTime = 0;
  void video.play();
});

function drawOriginalFrame() {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    origCtx.drawImage(video, 0, 0, originalCanvas.width, originalCanvas.height);
  }
}

function frameLoop() {
  if (!sessionActive) return;
  drawOriginalFrame();
  if (engine) {
    engine.tick(video);
  }
  rafId = requestAnimationFrame(frameLoop);
}

function teardownOutputCanvasPlaceholder() {
  const w = originalCanvas.width > 0 ? originalCanvas.width : 640;
  const h = originalCanvas.height > 0 ? originalCanvas.height : 360;
  remountProcessedCanvas(w, h);
}

function stopLocalPipeline() {
  sessionActive = false;
  cancelAnimationFrame(rafId);
  engine?.stop();
  engine?.dispose();
  engine = null;
  encodeWorker?.terminate();
  encodeWorker = null;
  compositeWorker?.terminate();
  compositeWorker = null;
}

function resetSessionUi() {
  setStatus("Idle", false);
  stopBtn.disabled = true;
  startBtn.disabled = !loadedVideo;
  procPlaceholder.style.display = "flex";
  teardownOutputCanvasPlaceholder();
  resetFpsMeter();
  statFps.textContent = "—";
}

function handleWsClose(ev) {
  const wasIntentional = intentionalWsClose;
  stopLocalPipeline();
  wsClient = null;
  intentionalWsClose = false;
  if (!wasIntentional && USER_VISIBLE_CLOSE_CODES.has(ev.code) && ev.reason) {
    showError(ev.reason);
  }
  resetSessionUi();
}

startBtn.addEventListener("click", async () => {
  hideError();
  const token = authTokenInput.value.trim();
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_WS_URL;
  if (!token) {
    showError("API token is required.");
    return;
  }
  if (!loadedVideo) {
    showError("Choose a video file first.");
    return;
  }

  try {
    await prepareVideoForSession();
  } catch (e) {
    showError(e instanceof Error ? e.message : "Video unavailable.");
    return;
  }

  let url;
  try {
    url = buildStreamingWsUrl(serverUrl, token);
  } catch (e) {
    showError(e instanceof Error ? e.message : "Invalid configuration.");
    return;
  }

  if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
    showError("This browser does not support OffscreenCanvas transfer. Try Chrome or Edge.");
    return;
  }

  intentionalWsClose = false;
  wsClient = new StreamingRmbgWsClient();

  wsClient.connect(url, {
    onOpen: async () => {
      const processed = document.getElementById("processed-canvas");
      if (!processed) {
        showError("Could not prepare output canvas.");
        intentionalWsClose = true;
        wsClient?.close(false);
        return;
      }

      try {
        encodeWorker = createEncodeWorker();
        compositeWorker = createCompositeWorker();
      } catch {
        showError("Could not start the processing worker. Open this page over HTTP or use a recent browser.");
        intentionalWsClose = true;
        wsClient?.close(false);
        return;
      }

      const off = processed.transferControlToOffscreen();
      compositeWorker.postMessage({ type: "init", canvas: off }, [off]);
      compositeWorker.postMessage({
        type: "resize",
        width: originalCanvas.width,
        height: originalCanvas.height,
      });

      video.currentTime = 0;
      try {
        await video.play();
      } catch {
        /* keep going */
      }

      engine = new StreamingRmbgAlgorithm({
        encodeWorker,
        compositeWorker,
        ws: wsClient,
        videoWidth: originalCanvas.width,
        videoHeight: originalCanvas.height,
        onFpsTick,
      });
      engine.start();

      procPlaceholder.style.display = "none";
      sessionActive = true;
      setStatus("Streaming", true);
      stopBtn.disabled = false;
      startBtn.disabled = true;
      resetFpsMeter();
      statFps.textContent = "—";
      frameLoop();
    },
    onClose: handleWsClose,
    onError: () => {
      showError("Connection error.");
    },
    onBinary: (buf) => {
      engine?.onWsBinary(buf);
    },
    onJson: (obj) => {
      if (obj.type === "error") {
        showError("Something went wrong.");
      }
    },
  });
});

stopBtn.addEventListener("click", () => {
  intentionalWsClose = true;
  stopLocalPipeline();
  wsClient?.close(true);
  wsClient = null;
  resetSessionUi();
});

serverUrlInput.value = DEFAULT_WS_URL;
