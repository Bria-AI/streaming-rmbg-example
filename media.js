/** Waits until a `<video>` knows its width/height, or rejects if load fails. */
export function waitForLoadedMetadata(media) {
  if (!media) return Promise.reject(new Error("No media element."));
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA && media.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    media.addEventListener("loadedmetadata", () => resolve(), { once: true });
    media.addEventListener("error", () => reject(new Error("Media failed to load.")), { once: true });
  });
}
