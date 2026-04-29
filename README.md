# Streaming realtime background removal — browser example

Small page that connects over **WebSocket**, sends video as JPEG frames, receives mask JPEGs, and shows a transparent composite. Use the code as a reference for your own client.

## Run

Open `index.html`, paste your **API token**, choose a **local video**, click **Start**.

## WebSocket usage

Integration flow:

1. **Open a WebSocket** with the API token in the query string (same default as `constants.js` → `DEFAULT_WS_URL`):

   ```text
   wss://streaming.prod.bria-api.com?api_token=<YOUR_API_TOKEN>
   ```

2. **Send each video frame** as **24-byte `BRIA` header + JPEG** (RGB frame you want segmented). Packing is in `frame_protocol.js` (`packVideoJpegFrame`); see your product API doc for header fields.

3. **Receive binary responses** with the same header layout; the **payload is a grayscale JPEG mask** keyed by the same **`frame_id`** you sent.

4. **Use the mask as alpha** — composite your original RGB with the mask (this sample does that in `rmbg_offscreen_worker.js`; shader: foreground × mask, alpha = mask).

On clean shutdown, send JSON `{ "type": "stop" }` before closing (see `StreamingRmbgWsClient.close` in `ws_client.js`). The server may also send JSON control messages (e.g. errors); binary vs text routing is in `ws_client.js`.

**Close events:** the sample UI may show `CloseEvent.reason` for selected policy codes only (`USER_VISIBLE_CLOSE_CODES` in `constants.js`).

Capture, JPEG encode, send pacing, and drawing are implemented in `algorithm.js` and the workers — you can swap those parts out and keep steps 1–4.

## Files (overview)

| File | Role |
| --- | --- |
| `ws_client.js` | Build URL, send binary / JSON, dispatch messages |
| `frame_protocol.js` | Pack and unpack the binary header + JPEG |
| `constants.js` | Protocol bytes, tuning, close-code set |
| `app.js` | Wires UI, WebSocket, workers, and the loop |
| `algorithm.js` | Send path and mask handling |
| `rmbg_encode_worker.js` / `rmbg_offscreen_worker.js` | JPEG encode and compositing |

## Getting better FPS

The on-screen FPS is a ~1s average of **completed composites**, not raw server inference time.

**Client behavior (tunable in `constants.js`):**

- **Latest-frame-wins:** new frames replace an unsent buffer instead of queueing forever (lower latency under load).
- **AIMD:** limits how many frames are in flight; adjusts from round-trip behavior (`AIMD_*`, `JPEG_QUALITY`, `MAX_ENCODE_PENDING`).

**Practical levers:**

- Lower **encode resolution** or **JPEG quality** to reduce CPU and bandwidth.
- **WebGL2** compositor path is much faster than 2D on large frames; encode and composite use **separate workers** so they do not block each other.
- **Network RTT** and server load cap throughput; variable-frame-rate video can also lower measured FPS.

## License / support

Example code is for integration reference; API terms and authentication follow your Bria product documentation.
