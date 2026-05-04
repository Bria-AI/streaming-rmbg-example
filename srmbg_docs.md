# Realtime Video Background Removal API Documentation

---

Remove or change backgrounds of video streams in real-time using WebSocket API.

Input: JPEG frames.
Output: greyscale mask in JPEG. 0 = fully background, 1 = fully foreground

Try it in our sandbox: [https://platform.bria.ai/video-editing/video-streaming-remove-background/sandbox](https://platform.bria.ai/video-editing/video-streaming-remove-background/sandbox)

Or try it using this complete end-to-end example client available here:  [https://github.com/bria-ai/streaming-rmbg-example](https://github.com/bria-ai/streaming-rmbg-example)

---

# Technical spec

You can achieve real-time capacity of ~24 FPS, <100ms RTT (~74 ms p50 and ~97 ms p95) for US-based clients. With a background VS foreground grayscale mask output, you get full flexibility.

Note: for you client application to achieve the potential of 24 FPS real-time streaming, you most likely will need to implement some client side optimizations. Look for the optimizations section for more information.

## Connection

```
wss://streaming.prod.bria-api.com
```

---

## Authentication

You can authenticate using either an API token or an OAuth access token.

### API Token

```
wss://streaming.prod.bria-api.com?api_token=<YOUR_API_TOKEN>
```

### OAuth

```
wss://streaming.prod.bria-api.com?oauth=<YOUR_OAUTH_ACCESS_TOKEN>
```

**Note:** Provide only one authentication method per connection.

---

## Protocol Overview

---

## Message Types

The WebSocket uses two types of messages:

- **Binary messages** — used for video/audio frame data, consists of 24-byte header + payload
- **JSON messages (control messages)** — used for session control, debugging, and errors

---

## Client → Server Messages

#### **Video Frame (binary)**

```
[24-byte header][JPEG payload]
```

## Frame Header (24 bytes)

```
Offset   Size   Field         Type     Value
0–3      4 B    Magic         string   "BRIA" (0x42524941)
4        1 B    Version       uint8    3
5        1 B    App ID        uint8    1 (Remove Background)
6        1 B    Media Type    uint8    1=Video, 2=Audio*
7        1 B    Codec         uint8    1=JPEG
8–15     8 B    **Frame ID    uint64   big endian frame ID
16–23    8 B    ***PTS        int64    big endian time stamp
24+      var    Payload       bytes    

* Video will be processed with mask output, audio will just go through
** Frame ID: A frame ID that the server will give back with the output mask. Used by the client to connect between the mask and it's frame
*** PTS: a timestamp for client use. The server gives it back with the output mask.
```

## Constants

| Constant | Value |
| --- | --- |
| MAGIC | BRIA (0x42524941) |
| VERSION | 3 |
| APP_RMBG | 1 |
| MEDIA_VIDEO | 1 |
| MEDIA_AUDIO | 2 |
| CODEC_JPEG | 1 |
| HEADER_SIZE | 24 |

---

#### Stop Session

```json
{ "type": "stop" }
```

---

#### Debug Mode

Enable:

```json
{ "type": "debug", "enabled": true }
```

Disable:

```json
{ "type": "debug", "enabled": false }
```

---

## Server → Client Messages

#### Processed Frame (binary)

```
[24-byte header][JPEG mask payload]
```

The payload is a **grayscale** **mask JPEG**. Use it as alpha and composite with the original frame.

---

#### Error

```json
{ "type": "error", "message": "..." }
```

---

### Frame Timing (debug only)

Returned only when debug mode is enabled.

```json
{
  "type": "frame_timing",
  "frame_id": 4,
  "frames_dropped_since_last": 0,
  "server_ms": {
    "decode_jpeg": 0.5,
    "pre": 0.17,
    "infer": 38.83,
    "post": 0.11,
    "encode_mask": 0.22,
    "engine_total": 40.22,
    "session_total": 41.34
  },
  "bytes_in": 60881,
  "bytes_out": 23254
}
```

---

---

---

## Sending Frames

1. Extract frame
2. Encode as JPEG
3. Prepend header
4. Send via WebSocket

---

## Receiving Frames

- Server returns greyscale mask frames
- Same header structure
- Payload = **JPEG mask**

**Important:**

The mask is **not RGBA,** it does not include colors from the original frame. Use it as alpha and composite with the original frame using the frame id.

---

## WebSocket Close Codes

| Code | Reason | Trigger |
| --- | --- | --- |
| 1013 | `capacity exceeded, please try again later` | Service is temporarily overloaded |
| 1008 | `unauthorized` | Authentication failed or invalid credentials |
| 4003 | `session limit reached` | Session duration limit reached (plan restriction) |
| 4008 | `session timeout` | No media frames received within allowed time |

# Client Side Optimizations

Behavior:

Latest-frame-wins: new frames replace an unsent buffer instead of growing a queue (lower latency under load).
AIMD: caps frames in flight and adjusts from round-trip behavior.

Practical levers:

Lower encode resolution or JPEG quality to cut CPU and bandwidth.
WebGL2 compositing is much faster than 2D on large frames; encode and composite use separate workers so they don’t block each other.
Network RTT and server load cap throughput; variable frame rate in the source file also lowers measured FPS.

For reference, the example client has these optimizations as well:  [https://github.com/bria-ai/streaming-rmbg-example](https://github.com/bria-ai/streaming-rmbg-example)

# Examples

## Working Example

A complete end-to-end example (client + streaming flow) is available here:

[https://github.com/bria-ai/streaming-rmbg-example](https://github.com/bria-ai/streaming-rmbg-example)

## JavaScript Example

```jsx
const HEADER_SIZE = 24;
const VERSION = 3;
const APP = 1;
const MEDIA_VIDEO = 1;
const CODEC_JPEG = 1;

function buildWsUrl(serverUrl, auth) {
  const url = new URL(serverUrl);

  if (auth.apiToken) {
    url.searchParams.set("api_token", auth.apiToken);
  } else if (auth.oauth) {
    url.searchParams.set("oauth", auth.oauth);
  } else {
    throw new Error("Missing authentication");
  }

  return url.toString();
}

function buildHeader(frameId, ptsUs) {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);

  view.setUint8(0, 0x42);
  view.setUint8(1, 0x52);
  view.setUint8(2, 0x49);
  view.setUint8(3, 0x41);

  view.setUint8(4, VERSION);
  view.setUint8(5, APP);
  view.setUint8(6, MEDIA_VIDEO);
  view.setUint8(7, CODEC_JPEG);

  view.setUint32(8, Math.floor(frameId / 0x100000000), false);
  view.setUint32(12, frameId >>> 0, false);

  const ptsHi = Math.floor(ptsUs / 0x100000000);
  const ptsLo = ptsUs >>> 0;

  view.setInt32(16, ptsHi, false);
  view.setUint32(20, ptsLo, false);

  return buf;
}

const ws = new WebSocket(buildWsUrl(
  "wss://streaming.prod.bria-api.com",
  { apiToken: "YOUR_TOKEN" }
));

ws.binaryType = "arraybuffer";

ws.onmessage = (event) => {
  if (typeof event.data === "string") return;

  const jpegMask = event.data.slice(HEADER_SIZE);

  // Use mask as alpha and composite with original frame
};
```

---

## Python Example

```python
import struct
import websockets
import asyncio

HEADER_SIZE = 24

def build_header(frame_id, pts_us):
    buf = bytearray(HEADER_SIZE)

    buf[0:4] = b"BRIA"
    buf[4] = 3
    buf[5] = 1
    buf[6] = 1
    buf[7] = 1

    struct.pack_into(">I", buf, 8, frame_id >> 32)
    struct.pack_into(">I", buf, 12, frame_id & 0xFFFFFFFF)

    pts_hi = pts_us >> 32
    pts_lo = pts_us & 0xFFFFFFFF

    struct.pack_into(">i", buf, 16, pts_hi)
    struct.pack_into(">I", buf, 20, pts_lo)

    return bytes(buf)

def build_ws_url(server_url, api_token=None, oauth=None):
    if bool(api_token) == bool(oauth):
        raise ValueError("Provide exactly one auth method")

    sep = "&" if "?" in server_url else "?"
    if api_token:
        return f"{server_url}{sep}api_token={api_token}"
    return f"{server_url}{sep}oauth={oauth}"

async def main():
    uri = build_ws_url(
        "wss://streaming.prod.bria-api.com",
        api_token="YOUR_TOKEN"
    )

    async with websockets.connect(uri) as ws:
        pass

asyncio.run(main())
```

---

## Parsing Header (JS)

```jsx
function unpackHeader(buffer) {
  const view = new DataView(buffer);

  if (
    view.getUint8(0) !== 0x42 ||
    view.getUint8(1) !== 0x52 ||
    view.getUint8(2) !== 0x49 ||
    view.getUint8(3) !== 0x41
  ) return null;

  return {
    frameId:
      view.getUint32(8, false) * 0x100000000 +
      view.getUint32(12, false),
    ptsUs:
      view.getInt32(16, false) * 0x100000000 +
      view.getUint32(20, false),
    payload: buffer.slice(24),
  };
}
```

---

---