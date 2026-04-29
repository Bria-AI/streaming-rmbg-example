import { APP_REMOVE_BG, CODEC_JPEG, HEADER_SIZE, MEDIA_TYPE_VIDEO, PROTOCOL_VERSION } from "./constants.js";

/** 24-byte BRIA header + JPEG body (outbound video). */
export function packVideoJpegFrame(frameId, presentationTimestampUs, jpegPayload) {
  const payloadBuffer =
    jpegPayload instanceof ArrayBuffer
      ? jpegPayload
      : jpegPayload.buffer.slice(jpegPayload.byteOffset, jpegPayload.byteOffset + jpegPayload.byteLength);
  const out = new Uint8Array(HEADER_SIZE + payloadBuffer.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0x42);
  view.setUint8(1, 0x52);
  view.setUint8(2, 0x49);
  view.setUint8(3, 0x41);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, APP_REMOVE_BG);
  view.setUint8(6, MEDIA_TYPE_VIDEO);
  view.setUint8(7, CODEC_JPEG);
  view.setUint32(8, Math.floor(frameId / 0x100000000), false);
  view.setUint32(12, frameId >>> 0, false);
  const ptsHi = Math.floor(presentationTimestampUs / 0x100000000);
  const ptsLo = presentationTimestampUs >>> 0;
  view.setInt32(16, ptsHi, false);
  view.setUint32(20, ptsLo, false);
  out.set(new Uint8Array(payloadBuffer), HEADER_SIZE);
  return out.buffer;
}

export function unpackBinaryFrame(buffer) {
  if (buffer.byteLength < HEADER_SIZE) return null;
  const bytes = new Uint8Array(buffer, 0, 4);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x52 || bytes[2] !== 0x49 || bytes[3] !== 0x41) {
    return null;
  }
  const view = new DataView(buffer);
  const mediaType = view.getUint8(6);
  const hi = view.getUint32(8, false);
  const lo = view.getUint32(12, false);
  const frameId = hi * 0x100000000 + lo;
  const payload = buffer.slice(HEADER_SIZE);
  return { frameId, mediaType, payload };
}
