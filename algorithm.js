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
  MAX_COMPOSITOR_POST_QUEUE,
  MAX_ENCODE_PENDING,
  MEDIA_TYPE_VIDEO,
} from "./constants.js";
import { packVideoJpegFrame, unpackBinaryFrame } from "./frame_protocol.js";

/** Sends JPEG frames, reads masks back, and feeds the compositor — with a simple in-flight throttle. */
export class StreamingRmbgAlgorithm {
  /** Wires workers, socket, frame size, optional solid colour, and the FPS callback. */
  constructor(opts) {
    this.encodeWorker = opts.encodeWorker;
    this.compositeWorker = opts.compositeWorker;
    this.ws = opts.ws;
    this.videoW = opts.videoWidth;
    this.videoH = opts.videoHeight;
    this.onFpsTick = opts.onFpsTick;
    this.getCompositeBackground = opts.getCompositeBackground;
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
    this.compositorPostTail = Promise.resolve();
    this.compositorPostEnqueued = 0;
    this.compositorPostSettled = 0;
    this._onEncodeMessage = (ev) => this.#handleEncodeMessage(ev);
    this.encodeWorker.addEventListener("message", this._onEncodeMessage);
  }

  /** Stops listening to the encode worker (call before terminating it). */
  dispose() {
    this.encodeWorker.removeEventListener("message", this._onEncodeMessage);
  }

  /** Begins a new session: clears maps and resets the throttle counters. */
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
    this.compositorPostTail = Promise.resolve();
    this.compositorPostEnqueued = 0;
    this.compositorPostSettled = 0;
  }

  /** Stops sending; finishes the queue chain; frees any waiting encoders with an empty buffer. */
  stop() {
    this.running = false;
    this.compositorPostTail = Promise.resolve();
    this.compositorPostEnqueued = 0;
    this.compositorPostSettled = 0;
    this.latestVideoCandidate = null;
    for (const resolve of this.encodeResolvers.values()) resolve(new ArrayBuffer(0));
    this.encodeResolvers.clear();
  }

  /** Call once per animation frame: drop old sends, maybe encode, maybe send the newest JPEG. */
  tick(video) {
    if (!this.running) return;
    const nowWall = Date.now();
    const penalize = nowWall - this.lastStaleFramePurgeTime >= AIMD_STALE_FRAME_PURGE_INTERVAL_MS;
    if (penalize) this.lastStaleFramePurgeTime = nowWall;
    this.#purgeStalePendingFrames(nowWall, penalize);
    this.#maybeStartLatestVideoCapture(video);
    this.#trySendLatestVideoCandidate();
  }

  /** Handles one mask JPEG from the server: update throttle, queue blend, bump throughput. */
  onWsBinary(data) {
    if (!this.running) return;
    const unpacked = unpackBinaryFrame(data);
    if (!unpacked || unpacked.mediaType !== MEDIA_TYPE_VIDEO) return;

    const { frameId, payload } = unpacked;
    const rec = this.pendingFrames.get(frameId);
    const rttMs = rec ? Date.now() - rec.t_send : null;
    this.#releaseSupersededInFlight(frameId);

    if (rttMs != null && rttMs > 0) {
      if (this.aimdWarmupFrames < AIMD_WARMUP_FRAMES) {
        this.aimdWarmupFrames++;
      } else {
        this.smoothedRtt = this.smoothedRtt == null ? rttMs : 0.9 * this.smoothedRtt + 0.1 * rttMs;
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
      this.#queueCompositorPost(() => this.#postComposite(frameId, maskCopy, pending));
    }
    this.pendingFrames.delete(frameId);
    this.onFpsTick?.();
  }

  /** When a mask arrives, forget any older frame ids that are still waiting (out-of-order replies). */
  #releaseSupersededInFlight(arrivedFrameId) {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    for (const id of [...this.pendingFrames.keys()]) {
      if (id < arrivedFrameId) {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        this.pendingFrames.delete(id);
      }
    }
  }

  /** Runs compositor posts one after another, and skips new ones if the queue is full. */
  #queueCompositorPost(task) {
    if (this.compositorPostEnqueued - this.compositorPostSettled >= MAX_COMPOSITOR_POST_QUEUE) return;
    this.compositorPostEnqueued++;
    const run = async () => {
      try {
        await task();
      } finally {
        this.compositorPostSettled++;
      }
    };
    this.compositorPostTail = this.compositorPostTail.then(run).catch(() => {
      this.compositorPostSettled++;
    });
  }

  /** Decodes the saved source JPEG + mask and posts one `composite` job to the worker. */
  async #postComposite(frameId, maskJpeg, pending) {
    try {
      const bmp = await createImageBitmap(new Blob([pending.original_jpeg], { type: "image/jpeg" }));
      const extra = this.getCompositeBackground ? await this.getCompositeBackground() : {};
      this.compositeWorker.postMessage(
        {
          type: "composite",
          frameId,
          maskJpeg,
          videoBitmap: bmp,
          width: this.videoW,
          height: this.videoH,
          backgroundRgb: extra.backgroundRgb,
        },
        [maskJpeg, bmp],
      );
    } catch {
      /* drop bad frame */
    }
  }

  /** Fulfills the Promise waiting on a finished JPEG encode. */
  #handleEncodeMessage(ev) {
    const d = ev.data;
    if (d?.type !== "encoded") return;
    const resolve = this.encodeResolvers.get(d.id);
    this.encodeResolvers.delete(d.id);
    if (resolve && d.buffer) resolve(d.buffer);
  }

  /** Drops sends that waited too long for a mask; optionally tightens the throttle. */
  #purgeStalePendingFrames(nowWall, applyPenalty) {
    let stale = false;
    for (const [id, rec] of [...this.pendingFrames.entries()]) {
      if (nowWall - rec.t_send > AIMD_STALE_FRAME_TIMEOUT_MS) {
        stale = true;
        this.pendingFrames.delete(id);
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      }
    }
    if (stale && applyPenalty) this.maxInFlight = Math.max(1, this.maxInFlight * AIMD_BACKOFF_FACTOR);
  }

  /** Grabs the current video frame as a bitmap at pipeline width/height. */
  #captureBitmap(video) {
    const w = this.videoW;
    const h = this.videoH;
    return createImageBitmap(video, { resizeWidth: w, resizeHeight: h }).catch(() => createImageBitmap(video));
  }

  /** Starts one async encode if we’re not busy and a slot is free. */
  #maybeStartLatestVideoCapture(video) {
    if (!this.running || this.videoCaptureInProgress) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.encodeResolvers.size >= MAX_ENCODE_PENDING) return;

    const t0 = performance.now() - this.sessionStartPerf;
    const id = this.nextEncodeId++;
    this.videoCaptureInProgress = true;
    this.#captureBitmap(video)
      .then((bitmap) => {
        if (!this.running) {
          bitmap.close();
          return null;
        }
        this.encodeWorker.postMessage(
          { type: "encode", id, bitmap, width: this.videoW, height: this.videoH, quality: JPEG_QUALITY },
          [bitmap],
        );
        return new Promise((resolve) => {
          this.encodeResolvers.set(id, resolve);
        });
      })
      .then((bytes) => {
        if (this.running && bytes?.byteLength > 0) this.latestVideoCandidate = { bytes, tSessionPerfMs: t0 };
      })
      .catch(() => {})
      .finally(() => {
        this.videoCaptureInProgress = false;
      });
  }

  /** Sends the freshest encoded JPEG if the socket is open and we’re under the in-flight cap. */
  #trySendLatestVideoCandidate() {
    if (!this.running || !this.ws.isOpen() || this.latestVideoCandidate == null) return;
    if (this.inFlightCount >= Math.floor(this.maxInFlight)) return;

    const { bytes, tSessionPerfMs } = this.latestVideoCandidate;
    this.latestVideoCandidate = null;
    const frameId = this.nextVideoFrameId++;
    this.pendingFrames.set(frameId, { t_send: Date.now(), original_jpeg: bytes });
    this.inFlightCount++;
    this.ws.sendBinary(packVideoJpegFrame(frameId, Math.round(tSessionPerfMs * 1000), bytes));
  }
}
