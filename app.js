import { StreamingRmbgAlgorithm } from "./algorithm.js";
import { DEFAULT_WS_URL, USER_VISIBLE_CLOSE_CODES } from "./constants.js";
import { waitForLoadedMetadata } from "./media.js";
import { createOutputBackgroundHooks } from "./rmbg_output_background.js";
import { buildStreamingWsUrl, StreamingRmbgWsClient } from "./ws_client.js";

/** Resolves this script’s URL so workers load from the same place as the page. */
function findAppScriptUrl() {
  const el = document.querySelector('script[src*="app.js"]');
  return el?.src ?? new URL("app.js", window.location.href).href;
}

/** Starts the small worker that turns frames into JPEG bytes. */
function createEncodeWorker() {
  return new Worker(new URL("rmbg_encode_worker.js", findAppScriptUrl()).href);
}

/** Starts the module worker that blends video + mask on the GPU (or CPU fallback). */
function createCompositeWorker() {
  return new Worker(new URL("rmbg_compositor_core.js", findAppScriptUrl()).href, { type: "module" });
}

/** Swaps the output canvas for a new pixel size and refits the inner layout. */
function remountProcessedCanvas(width, height) {
  const composite = document.getElementById("processed-composite");
  const old = document.getElementById("processed-canvas");
  if (!composite || !old) return null;
  const next = document.createElement("canvas");
  next.id = "processed-canvas";
  next.width = width;
  next.height = height;
  composite.replaceChild(next, old);
  layoutProcessedCompositeViewport();
  return next;
}

/** Sizes the inner stack so it matches a “contain” fit; the DOM cover video stays inside that box. */
function layoutProcessedCompositeViewport() {
  const wrap = document.getElementById("processed-wrap");
  const composite = document.getElementById("processed-composite");
  const canvas = document.getElementById("processed-canvas");
  if (!wrap || !composite || !canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (cw <= 0 || ch <= 0 || W <= 0 || H <= 0) return;
  const r = cw / ch;
  const boxW = Math.min(W, H * r);
  const boxH = boxW / r;
  composite.style.width = `${boxW}px`;
  composite.style.height = `${boxH}px`;
}

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
const bgTypeSelect = document.getElementById("bg-type");
const bgColorWrap = document.getElementById("bg-color-wrap");
const bgColorInput = document.getElementById("bg-color");
const bgImageWrap = document.getElementById("bg-image-wrap");
const bgVideoWrap = document.getElementById("bg-video-wrap");
const bgImageInput = document.getElementById("bg-image-input");
const bgVideoInput = document.getElementById("bg-video-input");
const bgImageLabel = document.getElementById("bg-image-label");
const bgVideoLabel = document.getElementById("bg-video-label");
const processedCoverVideo = document.getElementById("processed-cover-video");

const origCtx = originalCanvas.getContext("2d");

/** @type {{ url: string; name: string } | null} */
let loadedVideo = null;
/** @type {StreamingRmbgWsClient | null} */
let wsClient = null;
let encodeWorker = null;
let compositeWorker = null;
/** @type {StreamingRmbgAlgorithm | null} */
let engine = null;
let rafId = 0;
let sessionActive = false;

const outputBg = createOutputBackgroundHooks({
  bgTypeSelect,
  bgColorWrap,
  bgColorInput,
  bgImageWrap,
  bgVideoWrap,
  bgImageInput,
  bgVideoInput,
  bgImageLabel,
  bgVideoLabel,
  processedCoverVideo,
  session: { isActive: () => sessionActive, getWorker: () => compositeWorker },
});
let intentionalWsClose = false;
let fpsAcc = 0;
let fpsWindowStart = performance.now();

/** Clears the rolling window used for the throughput readout. */
function resetFpsMeter() {
  fpsAcc = 0;
  fpsWindowStart = performance.now();
}

/** Updates the status text and green dot. */
function setStatus(text, active) {
  statusText.textContent = text;
  statusDot.classList.toggle("active", active);
}

/** Shows the red banner with your message. */
function showError(message) {
  errorBanner.hidden = false;
  errorText.textContent = message;
}

/** Hides the error banner. */
function hideError() {
  errorBanner.hidden = true;
  errorText.textContent = "";
}

/** Counts incoming masks; the UI averages this about once per second. */
function onFpsTick() {
  fpsAcc++;
  const now = performance.now();
  if (now - fpsWindowStart >= 1000) {
    statFps.textContent = `${((fpsAcc * 1000) / (now - fpsWindowStart)).toFixed(1)} fps`;
    fpsAcc = 0;
    fpsWindowStart = now;
  }
}

/** Enables Start and shows the chosen filename. */
function setLoadedVideoUi() {
  startBtn.disabled = !loadedVideo;
  fileBtnLabel.textContent = loadedVideo ? loadedVideo.name : "Choose video…";
}

/** Points the hidden video at the file, waits for size, matches canvases, starts preview. */
async function prepareVideoForSession() {
  if (!loadedVideo) throw new Error("Choose a video file first.");
  video.src = loadedVideo.url;
  video.muted = muteCheckbox.checked;
  await waitForLoadedMetadata(video);
  const w = video.videoWidth;
  const h = video.videoHeight;
  originalCanvas.width = w;
  originalCanvas.height = h;
  remountProcessedCanvas(w, h);
  origPlaceholder.style.display = "none";
  await video.play();
}

fileInput.addEventListener("change", () => {
  if (loadedVideo) URL.revokeObjectURL(loadedVideo.url);
  loadedVideo = null;
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
  if (!sessionActive) remountProcessedCanvas(w, h);
  origPlaceholder.style.display = "none";
});

video.addEventListener("ended", () => {
  if (!sessionActive) return;
  video.currentTime = 0;
  void video.play();
});

/** Copies one video frame into the left preview canvas. */
function drawOriginalFrame() {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    origCtx.drawImage(video, 0, 0, originalCanvas.width, originalCanvas.height);
  }
}

/** Runs each frame while streaming: preview + send pipeline tick. */
function frameLoop() {
  if (!sessionActive) return;
  drawOriginalFrame();
  engine?.tick(video);
  rafId = requestAnimationFrame(frameLoop);
}

/** Puts the output canvas back to a safe default size when idle. */
function teardownOutputCanvasPlaceholder() {
  remountProcessedCanvas(
    originalCanvas.width > 0 ? originalCanvas.width : 640,
    originalCanvas.height > 0 ? originalCanvas.height : 360,
  );
}

/** Stops workers, the algorithm loop, and the optional DOM background video. */
function stopLocalPipeline() {
  sessionActive = false;
  outputBg.deactivateCoverVideoLayer();
  cancelAnimationFrame(rafId);
  engine?.stop();
  engine?.dispose();
  engine = null;
  encodeWorker?.terminate();
  encodeWorker = null;
  compositeWorker?.terminate();
  compositeWorker = null;
}

/** Puts buttons and labels back to the idle state. */
function resetSessionUi() {
  setStatus("Idle", false);
  stopBtn.disabled = true;
  startBtn.disabled = !loadedVideo;
  procPlaceholder.style.display = "flex";
  teardownOutputCanvasPlaceholder();
  resetFpsMeter();
  statFps.textContent = "—";
}

/** Runs when the socket closes: cleanup, then show server text only if it wasn’t a normal Stop. */
function handleWsClose(ev) {
  const wasIntentional = intentionalWsClose;
  stopLocalPipeline();
  wsClient = null;
  intentionalWsClose = false;
  if (!wasIntentional && USER_VISIBLE_CLOSE_CODES.has(ev.code) && ev.reason) showError(ev.reason);
  resetSessionUi();
}

startBtn.addEventListener("click", async () => {
  hideError();
  const token = authTokenInput.value.trim();
  if (!token) return showError("API token is required.");
  if (!loadedVideo) return showError("Choose a video file first.");
  const bgErr = outputBg.validateForStart();
  if (bgErr) return showError(bgErr);

  try {
    await prepareVideoForSession();
  } catch (e) {
    return showError(e instanceof Error ? e.message : "Video unavailable.");
  }
  try {
    await outputBg.prepareBackgroundMedia();
  } catch (e) {
    return showError(e instanceof Error ? e.message : "Background video unavailable.");
  }

  let url;
  try {
    url = buildStreamingWsUrl(DEFAULT_WS_URL, token);
  } catch (e) {
    return showError(e instanceof Error ? e.message : "Invalid configuration.");
  }

  if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
    return showError("This browser does not support OffscreenCanvas transfer. Try Chrome or Edge.");
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
        showError("Could not start workers. Serve over HTTP(S) and use a current browser.");
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
      await outputBg.syncCompositorWorker(compositeWorker);

      video.currentTime = 0;
      try {
        await video.play();
      } catch {
        /* autoplay policies */
      }
      outputBg.activateCoverVideoLayer();

      engine = new StreamingRmbgAlgorithm({
        encodeWorker,
        compositeWorker,
        ws: wsClient,
        videoWidth: originalCanvas.width,
        videoHeight: originalCanvas.height,
        onFpsTick,
        getCompositeBackground: outputBg.createGetCompositeBackground(),
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
    onError: () => showError("Connection error."),
    onBinary: (buf) => engine?.onWsBinary(buf),
    onJson: (obj) => {
      if (obj.type === "error") {
        const m = typeof obj.message === "string" && obj.message.trim() ? obj.message.trim() : "Server error.";
        showError(m);
      }
    },
  });
});

stopBtn.addEventListener("click", () => {
  if (!wsClient) return;
  intentionalWsClose = true;
  wsClient.close(true);
});

const processedWrapEl = document.getElementById("processed-wrap");
if (processedWrapEl && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(layoutProcessedCompositeViewport).observe(processedWrapEl);
}
requestAnimationFrame(layoutProcessedCompositeViewport);
