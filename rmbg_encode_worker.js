let offscreen;
let offCtx;

/** Creates or resizes the scratch canvas used before JPEG export. */
function ensureCanvas(w, h) {
  if (!offscreen || offscreen.width !== w || offscreen.height !== h) {
    offscreen = new OffscreenCanvas(w, h);
    offCtx = offscreen.getContext("2d");
  }
}

/** Draws a frame bitmap to JPEG and replies with `{ type: "encoded", id, buffer }`. */
self.onmessage = async ({ data }) => {
  const { id, bitmap, width, height, quality } = data;
  ensureCanvas(width, height);
  offCtx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await offscreen.convertToBlob({ type: "image/jpeg", quality });
  const buffer = await blob.arrayBuffer();
  self.postMessage({ type: "encoded", id, buffer }, [buffer]);
};
