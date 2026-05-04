/**
 * Streaming URL, frame header bytes, JPEG/AIMD tuning, compositor queue cap,
 * and WebSocket close codes where the sample shows `CloseEvent.reason`.
 */

export const DEFAULT_WS_URL = "wss://streaming.prod.bria-api.com";

export const HEADER_SIZE = 24;
export const PROTOCOL_VERSION = 0x03;
export const APP_REMOVE_BG = 0x01;
export const MEDIA_TYPE_VIDEO = 0x01;
export const CODEC_JPEG = 0x01;

export const AIMD_INITIAL_MAX_INFLIGHT = 6;
export const AIMD_MAX_INFLIGHT_CEILING = 16;
export const AIMD_SPIKE_THRESHOLD_FACTOR = 2.0;
export const AIMD_BACKOFF_FACTOR = 0.85;
export const AIMD_RECOVERY_INCREMENT = 0.2;
export const AIMD_WARMUP_FRAMES = 8;
export const AIMD_STALE_FRAME_TIMEOUT_MS = 3000;
export const AIMD_STALE_FRAME_PURGE_INTERVAL_MS = 5000;

export const JPEG_QUALITY = 0.6;
export const MAX_ENCODE_PENDING = 4;
export const MAX_COMPOSITOR_POST_QUEUE = 10;

export const USER_VISIBLE_CLOSE_CODES = new Set([1008, 1013, 4003, 4008]);
