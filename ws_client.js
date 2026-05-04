/** Adds `api_token` to the streaming WebSocket URL. */
export function buildStreamingWsUrl(serverUrl, apiToken) {
  const url = new URL(serverUrl);
  if (!apiToken?.trim()) throw new Error("API token is required");
  url.searchParams.set("api_token", apiToken.trim());
  return url.toString();
}

/** Small helper around WebSocket: binary + JSON, and a polite `stop` before close. */
export class StreamingRmbgWsClient {
  /** Starts with no connection. */
  constructor() {
    this.socket = null;
  }

  /** Opens (or replaces) the connection and wires your callbacks. */
  connect(url, handlers) {
    this.close();
    const ws = new WebSocket(url);
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => handlers.onOpen?.();
    ws.onerror = () => handlers.onError?.();
    ws.onclose = (ev) => handlers.onClose?.(ev);
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const obj = JSON.parse(event.data);
          if (obj && typeof obj === "object") handlers.onJson?.(obj);
        } catch {
          /* ignore */
        }
        return;
      }
      if (event.data instanceof ArrayBuffer) handlers.onBinary?.(event.data);
    };
  }

  /** Sends raw bytes when the socket is open. */
  sendBinary(buf) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(buf);
  }

  /** Optionally sends `{type:"stop"}`, then closes and clears the handle. */
  close(sendStop = true) {
    const ws = this.socket;
    if (!ws) return;
    this.socket = null;
    try {
      if (sendStop && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  /** True when the socket is connected and ready to send. */
  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
