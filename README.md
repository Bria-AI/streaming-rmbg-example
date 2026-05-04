# Streaming realtime background removal — browser example

Small page that connects over **WebSocket**, sends video as JPEG frames, receives mask JPEGs, and composites a transparent preview. Use it as a reference for your own client.

**Full protocol, authentication options, message layout, and limits** are documented in the **[Streaming video remove background](http://docs.bria.ai/streaming-rmbg)**

## Run

```bash
npx serve .
```

Open the page, paste an API token, choose a video, optional output background, then **Start**.

## Layout of the code

1. **Streaming path** — pack/send JPEGs, AIMD window on in-flight frames, decode masks (`algorithm.js`, `frame_protocol.js`, `ws_client.js`, `rmbg_encode_worker.js`, `constants.js`). This path does not implement “what goes behind the subject.”
2. **Output background** — solid: per-frame `backgroundRgb` to the compositor. Image: `set_background` with a static bitmap. Video: a looping `<video>` **behind** the processed canvas; the worker still outputs **alpha** over the subject only.

**Throughput** counts **mask messages per second** from the server (not `composite_done`).

## WebSocket (minimal)

- URL: `wss://streaming.prod.bria-api.com?api_token=<TOKEN>` (or `oauth=`; use one auth method).
- **Outbound:** `BRIA` header + JPEG payload (`frame_protocol.js`).
- **Inbound:** same header + **mask JPEG** (grayscale weights; composite with your source frame using `frame_id`).
- **Stop:** send `{ "type": "stop" }`, then close (see `ws_client.js`).

## Files

| File | Role |
| --- | --- |
| `app.js` | UI, workers, WebSocket, animation loop |
| `media.js` | Small helper: wait for `<video>` metadata |
| `algorithm.js` | Encode/send + mask handling + compositor queue |
| `frame_protocol.js` | Binary header pack/unpack |
| `ws_client.js` | WebSocket helper |
| `rmbg_encode_worker.js` | JPEG encode in a worker |
| `rmbg_output_background.js` | Background UI + worker `set_background` + solid RGB hook |
| `rmbg_compositor_core.js` | Module worker: blend (WebGL2 or 2D) |
| `constants.js` | URL, protocol constants, AIMD / JPEG / queue limits |
| `srmbg_docs.md` | Protocol and tuning reference |

Example only; product terms follow the official API documentation **[Streaming video remove background](http://docs.bria.ai/streaming-rmbg)**
