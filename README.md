# Streaming realtime background removal — browser example

Small page that connects over **WebSocket**, sends video as JPEG frames, receives mask JPEGs, and composites a transparent preview. Use it as a reference for your own client.

**Full protocol, authentication options, message layout, and limits** are documented in the **[Video Editing API reference](https://docs.bria.ai/video-editing)**

## Run

Open `index.html`, paste your **API token**, choose a **local video**, click **Start**.

## WebSocket usage

Integration flow:

1. **Open a WebSocket** with the API token in the query string.

   ```text
   wss://streaming.prod.bria-api.com?api_token=<YOUR_API_TOKEN>
   ```

2. **Send each video frame** as **24-byte `BRIA` header + JPEG** (RGB frame to segment). Packing: `frame_protocol.js` (`packVideoJpegFrame`). Header field details: **[Video Editing API — WebSocket / binary protocol](https://docs.bria.ai/video-editing)**.

3. **Receive binary responses** with the same header layout; **payload is a grayscale JPEG mask** for the same **`frame_id`** you sent.

4. **Use the mask as alpha** — composite your original RGB with the mask (this sample: `rmbg_offscreen_worker.js`; shader treats mask as α, RGB as premultiplied foreground).

On clean shutdown, send `{ "type": "stop" }` before closing (`StreamingRmbgWsClient.close` in `ws_client.js`). The server may send JSON control messages (e.g. errors); routing of binary vs string frames is in `ws_client.js`.

**Close events:** the sample may show `CloseEvent.reason` for policy close codes only (`USER_VISIBLE_CLOSE_CODES` in `constants.js`). See the **[API docs](https://docs.bria.ai/video-editing)** for which codes carry user-visible reasons.

Capture, JPEG encode, send pacing, and drawing live in `algorithm.js` and the workers — you can replace those pieces and keep steps 1–4.

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

The on-screen FPS is a ~1s average of **completed composites**, not server inference time alone.

**Behavior (tunable in `constants.js`):**

- **Latest-frame-wins:** new frames replace an unsent buffer instead of growing a queue (lower latency under load).
- **AIMD:** caps frames in flight and adjusts from round-trip behavior (`AIMD_*`, `JPEG_QUALITY`, `MAX_ENCODE_PENDING`).

**Practical levers:**

- Lower **encode resolution** or **JPEG quality** to cut CPU and bandwidth.
- **WebGL2** compositing is much faster than 2D on large frames; encode and composite use **separate workers** so they don’t block each other.
- **Network RTT** and server load cap throughput; **variable frame rate** in the source file also lowers measured FPS.

## License / support

Example code is for integration reference. API terms, authentication, and product limits are covered in the **[Video Editing API documentation](https://docs.bria.ai/video-editing)**.
