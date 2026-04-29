/**
 * Send path: latest-frame-wins (no unbounded JPEG queue), AIMD window on RTT,
 * separate encode vs composite workers. Tune numbers in constants.js.
 */
import {
  AIMD_BACKOFF_FACTOR,
  AIMD_INITIAL_MAX_INFLIGHT,
  AIMD_MAX_INFLIGHT_CEILING,
  AIMD_RECOVERY_INCREMENT,
  AIMD_SPIKE_THRESHOLD_FACTOR,
  AIMD_STALE_FRAME_PURGE_INTERVAL_MS,
  AIMD_STALE_FRAME_TIMEOUT_MS,
  AIMD_WARMUP_FRAMES,
  JPEG_QUALITY,
  MAX_ENCODE_PENDING,
  MEDIA_TYPE_VIDEO,
} from "./constants.js";
import { packVideoJpegFrame, unpackBinaryFrame } from "./frame_protocol.js";

export class StreamingRmbgAlgorithm {
  constructor(opts) {
    this.encodeWorker = opts.encodeWorker;
    this.compositeWorker = opts.compositeWorker;
    this.ws = opts.ws;
    this.videoW = opts.videoWidth;
    this.videoH = opts.videoHeight;
    this.onFpsTick = opts.onFpsTick;

    this.running = false;
    this.sessionStartPerf = 0;

    this.nextVideoFrameId = 0;
    this.pendingFrames = new Map();

    this.inFlightCount = 0;
    this.maxInFlight = AIMD_INITIAL_MAX_INFLIGHT;
    this.aimdWarmupFrames = 0;
    this.minRtt = Infinity;
    this.smoothedRtt = null;

    this.videoCaptureInProgress = false;
    this.latestVideoCandidate = null;

    this.nextEncodeId = 0;
    this.encodeResolvers = new Map();

    this.lastStaleFramePurgeTime = 0;

    this._onEncodeMessage = (ev) => this.#handleEncodeMessage(ev);
    this._onCompositeMessage = (ev) => this.#handleCompositeMessage(ev);
    this.encodeWorker.addEventListener("message", this._onEncodeMessage);
    this.compositeWorker.addEventListener("message", this._onCompositeMessage);
  }

  dispose() {
    this.encodeWorker.removeEventListener("message", this._onEncodeMessage);
    this.compositeWorker.removeEventListener("message", this._onCompositeMessage);
  }

  start() {
    this.running = true;
    this.sessionStartPerf = performance.now();
    this.nextVideoFrameId = 0;
    this.pendingFrames.clear();
    this.inFlightCount = 0;
    this.maxInFlight = AIMD_INITIAL_MAX_INFLIGHT;
    this.aimdWarmupFrames = 0;
    this.minRtt = Infinity;
    this.smoothedRtt = null;
    this.latestVideoCandidate = null;
    this.videoCaptureInProgress = false;
    this.encodeResolvers.clear();
    this.lastStaleFramePurgeTime = Date.now();
  }

  stop() {
    this.running = false;
    this.latestVideoCandidate = null;
    const pending = [...this.encodeResolvers.values()];
    this.encodeResolvers.clear();
    for (const resolve of pending) {
      resolve(new ArrayBuffer(0));
    }
  }

  tick(video) {
    if (!this.running) return;

    const nowWall = Date.now();
    const shouldApplyPenalty =
      nowWall - this.lastStaleFramePurgeTime >= AIMD_STALE_FRAME_PURGE_INTERVAL_MS;
    if (shouldApplyPenalty) {
      this.lastStaleFramePurgeTime = nowWall;
    }
    this.#purgeStalePendingFrames(nowWall, shouldApplyPenalty);

    this.#maybeStartLatestVideoCapture(video);
    this.#trySendLatestVideoCandidate();
  }

  onWsBinary(data) {
    if (!this.running) return;

    const unpacked = unpackBinaryFrame(data);
    if (!unpacked) return;
    if (unpacked.mediaType !== MEDIA_TYPE_VIDEO) return;

    const { frameId, payload } = unpacked;
    const tReceived = Date.now();
    const rec = this.pendingFrames.get(frameId);
    const rttMs = rec ? tReceived - rec.t_send : null;

    this.inFlightCount = Math.max(0, this.inFlightCount - 1);

    for (const pendingId of [...this.pendingFrames.keys()]) {
      if (pendingId < frameId) {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        this.pendingFrames.delete(pendingId);
      }
    }

    if (rttMs !== null && rttMs > 0) {
      if (this.aimdWarmupFrames < AIMD_WARMUP_FRAMES) {
        this.aimdWarmupFrames++;
      } else {
        this.smoothedRtt = this.smoothedRtt === null ? rttMs : 0.9 * this.smoothedRtt + 0.1 * rttMs;
        this.minRtt = Math.min(this.minRtt, rttMs);
        if (this.smoothedRtt > this.minRtt * AIMD_SPIKE_THRESHOLD_FACTOR) {
          this.maxInFlight = Math.max(1, this.maxInFlight * AIMD_BACKOFF_FACTOR);
        } else {
          this.maxInFlight = Math.min(
            AIMD_MAX_INFLIGHT_CEILING,
            this.maxInFlight + AIMD_RECOVERY_INCREMENT,
          );
        }
      }
    }

    const pending = this.pendingFrames.get(frameId);
    if (payload.byteLength > 0 && pending) {
      const maskCopy = payload.slice(0);
      void this.#postComposite(frameId, maskCopy, pending);
    }

    this.pendingFrames.delete(frameId);
  }

  async #postComposite(frameId, maskJpeg, pending) {
    try {
      const bmp = await createImageBitmap(
        new Blob([pending.original_jpeg], { type: "image/jpeg" }),
      );
      this.compositeWorker.postMessage(
        {
          type: "composite",
          frameId,
          maskJpeg,
          videoBitmap: bmp,
          width: this.videoW,
          height: this.videoH,
        },
        [maskJpeg, bmp],
      );
    } catch {
      /* skip frame */
    }
  }

  #handleEncodeMessage(ev) {
    const d = ev.data;
    if (d?.type !== "encoded") return;
    const resolve = this.encodeResolvers.get(d.id);
    this.encodeResolvers.delete(d.id);
    if (resolve && d.buffer) {
      resolve(d.buffer);
    }
  }

  #handleCompositeMessage(ev) {
    const d = ev.data;
    if (d?.type === "composite_done") {
      this.onFpsTick?.();
    }
  }

  #purgeStalePendingFrames(nowWall, applyPenalty) {
    let foundStale = false;
    for (const [frameId, rec] of [...this.pendingFrames.entries()]) {
      const age = nowWall - rec.t_send;
      if (age > AIMD_STALE_FRAME_TIMEOUT_MS) {
        foundStale = true;
        this.pendingFrames.delete(frameId);
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      }
    }
    if (foundStale && applyPenalty) {
      this.maxInFlight = Math.max(1, this.maxInFlight * AIMD_BACKOFF_FACTOR);
    }
  }

  /** Downscale to encode size; falls back to full-size bitmap if resize is unsupported. */
  #captureBitmap(video) {
    const w = this.videoW;
    const h = this.videoH;
    return createImageBitmap(video, { resizeWidth: w, resizeHeight: h }).catch(() =>
      createImageBitmap(video),
    );
  }

  #maybeStartLatestVideoCapture(video) {
    if (!this.running || this.videoCaptureInProgress) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.encodeResolvers.size >= MAX_ENCODE_PENDING) return;

    const tSessionPerfMs = performance.now() - this.sessionStartPerf;
    const id = this.nextEncodeId++;

    this.videoCaptureInProgress = true;

    this.#captureBitmap(video)
      .then((bitmap) => {
        if (!this.running) {
          bitmap.close();
          return Promise.resolve(null);
        }
        this.encodeWorker.postMessage(
          {
            type: "encode",
            id,
            bitmap,
            width: this.videoW,
            height: this.videoH,
            quality: JPEG_QUALITY,
          },
          [bitmap],
        );
        return new Promise((resolve) => {
          this.encodeResolvers.set(id, resolve);
        });
      })
      .then((bytes) => {
        if (!this.running || !bytes || bytes.byteLength === 0) return;
        this.latestVideoCandidate = { bytes, tSessionPerfMs };
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        this.videoCaptureInProgress = false;
      });
  }

  #trySendLatestVideoCandidate() {
    if (!this.running || !this.ws.isOpen()) return;
    if (this.latestVideoCandidate === null) return;
    if (this.inFlightCount >= Math.floor(this.maxInFlight)) return;

    const candidate = this.latestVideoCandidate;
    this.latestVideoCandidate = null;

    const frameId = this.nextVideoFrameId++;
    const tSend = Date.now();
    const ptsUs = Math.round(candidate.tSessionPerfMs * 1000);
    const packet = packVideoJpegFrame(frameId, ptsUs, candidate.bytes);

    this.pendingFrames.set(frameId, {
      t_send: tSend,
      original_jpeg: candidate.bytes,
    });

    this.inFlightCount++;
    this.ws.sendBinary(packet);
  }
}
