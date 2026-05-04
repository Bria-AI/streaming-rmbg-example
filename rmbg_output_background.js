import { waitForLoadedMetadata } from "./media.js";

/** Turns `#RRGGBB` into `{r,g,b}`, or returns null if the string isn’t a simple hex colour. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Hooks up background UI: solid / image in the worker, optional looped `<video>` under the canvas
 * (cover is not sent frame-by-frame to the worker).
 */
export function createOutputBackgroundHooks(o) {
  let bgImageFile = null;
  let bgVideoObjectUrl = null;

  /** Shows only the controls that match the selected mode. */
  function updateBgTypeUi() {
    const mode = o.bgTypeSelect.value;
    o.bgColorWrap.style.display = mode === "solid" ? "flex" : "none";
    o.bgImageWrap.style.display = mode === "image" ? "flex" : "none";
    o.bgVideoWrap.style.display = mode === "video" ? "flex" : "none";
  }

  /** Clears or reapplies the static image background on the compositor worker. */
  async function pushBackgroundToWorker(worker) {
    if (!worker) return;
    worker.postMessage({ type: "set_background", mode: "none" });
    if (o.bgTypeSelect.value === "image" && bgImageFile) {
      const bmp = await createImageBitmap(bgImageFile);
      worker.postMessage({ type: "set_background", mode: "imageContain", bitmap: bmp }, [bmp]);
    }
  }

  /** If we’re streaming, pushes the latest background choice to the worker again. */
  async function resyncCompositorIfLive() {
    if (!o.session?.isActive?.() || !o.session?.getWorker?.()) return;
    const w = o.session.getWorker();
    if (w) await pushBackgroundToWorker(w);
  }

  /** Un-hides the DOM cover clip when mode is video and a `src` is set (session start or mid-stream). */
  function revealDomCoverVideo() {
    if (o.bgTypeSelect.value !== "video") return;
    const el = o.processedCoverVideo;
    if (!el?.src) return;
    el.removeAttribute("hidden");
    void el.play().catch(() => {});
  }

  o.bgTypeSelect.addEventListener("change", () => {
    if (o.bgTypeSelect.value !== "video") {
      const el = o.processedCoverVideo;
      if (el) {
        el.pause();
        el.setAttribute("hidden", "");
      }
    } else if (o.session?.isActive?.()) {
      revealDomCoverVideo();
    }
    updateBgTypeUi();
    void resyncCompositorIfLive();
  });
  updateBgTypeUi();

  o.bgImageInput.addEventListener("change", async () => {
    const f = o.bgImageInput.files?.[0];
    bgImageFile = f ?? null;
    o.bgImageLabel.textContent = f ? f.name : "Choose image…";
    await resyncCompositorIfLive();
  });

  o.bgVideoInput.addEventListener("change", async () => {
    const cover = o.processedCoverVideo;
    if (bgVideoObjectUrl) {
      URL.revokeObjectURL(bgVideoObjectUrl);
      bgVideoObjectUrl = null;
    }
    const f = o.bgVideoInput.files?.[0];
    if (!f) {
      cover?.removeAttribute("src");
      cover?.setAttribute("hidden", "");
      o.bgVideoLabel.textContent = "Choose video…";
      await resyncCompositorIfLive();
      return;
    }
    bgVideoObjectUrl = URL.createObjectURL(f);
    if (cover) cover.src = bgVideoObjectUrl;
    o.bgVideoLabel.textContent = f.name;
    void cover?.play().catch(() => {});
    if (cover) await waitForLoadedMetadata(cover).catch(() => {});
    await resyncCompositorIfLive();
    if (o.session?.isActive?.()) revealDomCoverVideo();
  });

  o.processedCoverVideo?.addEventListener("loadeddata", () => {
    void o.processedCoverVideo?.play().catch(() => {});
  });

  return {
    /** Returns a short error string if the UI choice needs a file, otherwise null. */
    validateForStart() {
      if (o.bgTypeSelect.value === "image" && !bgImageFile) {
        return "Choose a background image, or switch output background mode.";
      }
      if (o.bgTypeSelect.value === "video" && !o.bgVideoInput.files?.[0]) {
        return "Choose a background video, or switch output background mode.";
      }
      return null;
    },
    /** For DOM video mode, waits until the cover clip is ready before you press Start. */
    async prepareBackgroundMedia() {
      if (o.bgTypeSelect.value !== "video") return;
      const el = o.processedCoverVideo;
      if (el?.src) await waitForLoadedMetadata(el);
    },
    /** Same as `pushBackgroundToWorker` — called once the compositor worker exists. */
    syncCompositorWorker: pushBackgroundToWorker,
    /** Shows the cover `<video>` when streaming begins (or after switching to video mid-session). */
    activateCoverVideoLayer() {
      revealDomCoverVideo();
    },
    /** Hides and pauses the cover `<video>` when the session ends. */
    deactivateCoverVideoLayer() {
      const el = o.processedCoverVideo;
      if (!el) return;
      el.pause();
      el.setAttribute("hidden", "");
    },
    /** Supplies solid colour RGB for each composite when that mode is on. */
    createGetCompositeBackground() {
      return async () => {
        if (o.bgTypeSelect.value !== "solid") return {};
        const rgb = hexToRgb(o.bgColorInput.value);
        return rgb ? { backgroundRgb: rgb } : {};
      };
    },
  };
}
