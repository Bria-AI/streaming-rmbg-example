export function buildStreamingWsUrl(serverUrl, apiToken) {
  const url = new URL(serverUrl);
  if (!apiToken?.trim()) throw new Error("API token is required");
  url.searchParams.set("api_token", apiToken.trim());
  return url.toString();
}

export class StreamingRmbgWsClient {
  constructor() {
    this.socket = null;
  }

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

  sendBinary(buf) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(buf);
  }

  close(sendStop = true) {
    const ws = this.socket;
    if (!ws) return;
    this.socket = null;
    try {
      if (sendStop && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      }
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
