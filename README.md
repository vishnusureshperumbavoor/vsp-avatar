# VSP Avatar — Local Realtime Face Swap

Local **webcam → photoreal face swap** studio. A FastAPI backend runs a
Hyperswap face-swap pipeline on your CPU; a React frontend captures your
webcam, streams frames over a WebSocket, and renders the swapped result. No
cloud inference — frames never leave the machine.

This replaces the earlier VRM/three.js avatar path (still recoverable from git
history). The output is a realistic face, not a 3D character.

```
Browser (React)
  webcam -> JPEG frames over WebSocket ->
FastAPI
  YuNet detector -> 256px ArcFace align -> Hyperswap 256 -> mask + colour paste
  -> JPEG frames back -> canvas (record / OBS browser source)
```

- **Face tracking / alignment:** OpenCV YuNet (5 landmarks) + ArcFace template
- **Identity embedding:** InsightFace `w600k_r50` (512-d ArcFace embedding)
- **Swap generator:** FaceFusion Hyperswap 256 on ONNX Runtime (CPU)
- **Backend:** FastAPI (identity portraits, presets, WebSocket swap + viewer relay)
- **Capture:** canvas `captureStream()` → WebM download; OBS browser source for calls

## Performance on this machine (measured)

CPU-only, WSL2, i5-1235U (12 threads):

| Mode | Behaviour | Frame rate |
| --- | --- | --- |
| `smooth` (default) | Composites every frame with the latest generated face texture; refreshes the texture asynchronously | **~8–12 fps preview**, texture refresh every **~0.6–1 s** |
| `exact` | Full generator on every frame | **~1.3–1.6 fps** (~0.6–0.8 s/frame) |

Hyperswap 256 is both faster and sharper than the previous `inswapper_128` path.
`smooth` keeps the preview responsive while expressions/identity refresh at the
CPU's ceiling, so lip-sync lags the refresh interval. Real-time 30 fps still
needs a GPU (see [Next steps](#next-steps)).

## Project layout

```text
vsp-avatar/
├── backend/
│   ├── app/
│   │   ├── main.py              FastAPI entrypoint + engine warm-up
│   │   ├── config.py            paths, model files, limits
│   │   ├── schemas.py           API models
│   │   ├── face_swap/
│   │   │   ├── align.py         5-point template, crop, masked colour paste
│   │   │   ├── engine.py        YuNet + ArcFace + Hyperswap 256 (CPU)
│   │   │   └── store.py         identity portraits + embeddings
│   │   └── routers/             health, identities, presets, swap
│   ├── models/                  ONNX models (fetched, gitignored)
│   ├── data/faces/              uploaded identities (gitignored)
│   ├── scripts/fetch_models.py  downloads the three ONNX models
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx              driver UI + viewer page routing
│   │   ├── hooks/useFaceSwap.ts webcam → WS → canvas loop
│   │   ├── hooks/useSwapViewer.ts read-only viewer socket
│   │   ├── lib/frame.ts         JPEG frame → canvas painter
│   │   ├── api.ts               REST + WS helpers
│   │   └── types.ts             shared types
│   ├── vite.config.ts           /api + /ws proxy
│   └── package.json
├── dev.sh
└── README.md
```

## Prerequisites

- Python 3.11+ (tested on 3.13) and [uv](https://docs.astral.sh/uv/)
- Node.js 20+
- A webcam and a WebGL2-capable browser (Chrome/Edge recommended)
- ~600 MB free disk for the ONNX models

## Backend setup

```bash
cd backend
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt

# Hyperswap 256 (~385 MB), w600k_r50 (~167 MB), YuNet (~230 KB)
.venv/bin/python scripts/fetch_models.py

.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: http://127.0.0.1:8000/docs

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

App: http://127.0.0.1:5173

Or run both with `./dev.sh`.

## Using it

1. **Upload a source portrait** (the face you want to appear as). One clear,
   front-facing face works best; the backend detects it, stores its embedding,
   and makes a thumbnail.
2. **Start the camera** and allow webcam access.
3. The preview updates in `smooth` mode at ~12–16 fps while the swap texture
   refreshes in the background. (Frame-accurate mode is available over the
   WebSocket protocol as `{"type":"config","mode":"exact"}`, but is not yet
   exposed as a UI toggle.)
4. **Record result** downloads a WebM of the rendered canvas.
5. For Zoom/Meet/Discord, add the **viewer URL** (`?viewer=1&room=main`) as an
   OBS browser source, then send OBS Virtual Camera to your call. On Linux use
   `v4l2loopback`.

The **viewer URL** subscribes to the same room as the driver. Multiple viewers
are supported; each has a single-frame mailbox so a slow viewer drops old frames
instead of blocking the driver.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | health + engine readiness + missing models |
| GET | `/api/identities` | list uploaded source faces |
| POST | `/api/identities` | upload a portrait (`multipart/form-data`, field `file`) |
| GET | `/api/identities/{id}/thumbnail` | portrait thumbnail |
| DELETE | `/api/identities/{id}` | delete an identity |
| GET | `/api/presets` | list presets |
| GET/PUT/DELETE | `/api/presets/{name}` | read/write/delete a preset |
| GET | `/api/swap/status` | engine status + active streams/viewers |
| WS | `/ws/swap/{room}` | driver frame stream / viewer relay |

### WebSocket protocol

`/ws/swap/{room}?role=driver` (or `role=viewer`):

```text
driver -> server  {"type":"identity","id":"portrait"}
                  {"type":"config","mode":"smooth","seamless":false,
                   "strength":1.0,"quality":85,"colour_match":true}
                  <binary JPEG frame>
server -> driver  {"type":"hello","engine":{...}}
                  {"type":"ready","engine":{...},"identity":"portrait"}
                  {"type":"stats","ms":42.1,"swap_ms":2100,"swaps":3,
                   "texture_age_ms":820,"face":true,"n":12,"bytes":66744}
                  <binary JPEG frame>
server -> viewer  {"type":"joined","role":"viewer","room":"main","viewers":1}
                  <binary JPEG frame>
```

One frame in flight per driver: the client waits for the response before sending
the next frame, which bounds latency instead of queueing.

## Configuration

Backend environment variables:

- `VSP_AVATAR_MAX_FACE_UPLOAD_MB` — portrait upload limit (default 16)
- `VSP_AVATAR_MAX_SWAP_STREAMS` — concurrent generator streams (default 1)
- `VSP_AVATAR_INFERENCE_THREADS` — onnxruntime intra-op threads (default 0 = auto)
- `VSP_AVATAR_CORS_ORIGINS` — comma-separated allowed origins

Frontend:

- `VITE_API_BASE` — only needed when the frontend is served from a different
  origin than the API; the default Vite proxy handles local dev.

## Models & licensing

`backend/scripts/fetch_models.py` downloads:

| File | Source | Licence |
| --- | --- | --- |
| `hyperswap_1a_256.onnx` | FaceFusion models | check upstream FaceFusion terms |
| `w600k_r50.onnx` | InsightFace `buffalo_l` | non-commercial research/testing |
| `face_detection_yunet_2023mar.onnx` | OpenCV Zoo | MIT |

See `backend/models/ATTRIBUTION.md` (written by the fetch script). If you plan to
use this commercially, check the FaceFusion and InsightFace terms first.

## Limitations

- The generator is 256×256; detail comes from the source texture, not the target.
- `smooth` mode lags expressions by the texture-refresh interval (~0.6–1 s here).
- No restoration/enhancement pass yet (GFPGAN/RestoreFormer would sharpen
  recordings but is far too slow for the live loop on CPU).
- Extreme profile angles and heavy occlusion (hands, hair) can still seam.
- No temporal stabilisation of the detection; slight jitter is possible frame
  to frame.

## Next steps

- GPU path (CUDA on Linux; DirectML/OpenVINO on Windows) for real-time 30 fps
- Optional GFPGAN/RestoreFormer pass for recorded output
- Pose/expression stabilisation and a tighter face-parsing mask
- Docker Compose (backend + built frontend)

## Responsible use

Use only faces you own or have explicit permission to use. Do not impersonate
real, identifiable people. No watermark is burned into the output by default —
add a disclosure label before sharing, and tell people when media is synthetic.
All processing is local.
