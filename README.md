# VSP Avatar

Local **webcam → VRM 3D avatar** studio. A FastAPI backend with a React +
three.js frontend that tracks your face in the browser and drives a VRM avatar in
real time. No cloud inference — the webcam frames never leave the machine.

- **Face tracking:** MediaPipe Face Landmarker (vendored WASM + model)
- **Rendering:** three.js + [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm)
- **Backend:** FastAPI (avatar catalogue/upload, presets, WebSocket pose relay)
- **Capture:** canvas `captureStream()` → WebM download; OBS Virtual Camera for calls

```
Browser (React)
  webcam -> MediaPipe Face Landmarker (wasm) -> blendshapes + head pose
         -> three.js / three-vrm render -> canvas (record / virtual camera)

FastAPI
  GET/POST /api/avatars          catalogue + upload .vrm
  GET/PUT/DELETE /api/presets    settings presets
  WS /ws/tracking/{room}         local pose relay (mirror to OBS / second view)
```

## Project layout

```text
vsp-avatar/
├── backend/
│   ├── app/
│   │   ├── main.py            FastAPI entrypoint
│   │   ├── config.py          paths + env
│   │   ├── avatar_store.py    VRM catalogue/upload
│   │   ├── preset_store.py    JSON presets
│   │   └── routers/           health, avatars, presets, tracking
│   ├── static/avatars/        sample CC0 VRM (rose-cc0)
│   ├── scripts/               fetch_sample_avatar.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/AvatarStage.tsx   three.js + three-vrm renderer
│   │   ├── hooks/useFaceTracking.ts     MediaPipe loop
│   │   ├── lib/expressionMap.ts         ARKit → VRM expressions
│   │   ├── lib/headPose.ts              landmarks → yaw/pitch/roll
│   │   └── App.tsx
│   ├── scripts/vendor-mediapipe.mjs     copies wasm + model locally
│   └── vite.config.ts                   /api + /ws proxy
├── dev.sh
└── README.md
```

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/) (or a plain venv + pip)
- Node.js 20+
- A webcam and a WebGL2-capable browser (Chrome/Edge recommended)

## Backend setup

```bash
cd backend
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt

# CC0 sample avatar (Rose, 100Avatars). Safe to re-run.
.venv/bin/python scripts/fetch_sample_avatar.py

.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: http://127.0.0.1:8000/docs

## Frontend setup

```bash
cd frontend
npm install
npm run vendor:mediapipe     # copies WASM runtime + downloads face_landmarker.task
npm run dev
```

App: http://127.0.0.1:5173

Or run both with:

```bash
./dev.sh
```

## Using it

1. Pick an avatar (or upload a `.vrm`).
2. **Start camera** and allow webcam access.
3. The avatar mirrors your expressions and head pose.
4. **Record avatar** downloads a WebM of the rendered canvas.
5. For Zoom/Meet/Discord, add the app (or an OBS browser source) to
   **OBS Virtual Camera**. On Linux use `v4l2loopback`.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | health/version |
| GET | `/api/avatars` | list VRM/GLB avatars |
| POST | `/api/avatars` | upload (`multipart/form-data`, field `file`) |
| GET | `/api/avatars/{id}` | download avatar binary |
| DELETE | `/api/avatars/{id}` | delete avatar |
| GET | `/api/presets` | list presets |
| GET/PUT/DELETE | `/api/presets/{name}` | read/write/delete a preset |
| WS | `/ws/tracking/{room}` | relay JSON pose frames to peers in a room |

### WebSocket frame shape

```json
{
  "t": 1730000000,
  "blendshapes": { "jawOpen": 0.12, "eyeBlinkLeft": 0.02 },
  "head": { "yaw": 0.01, "pitch": -0.03, "roll": 0.0 }
}
```

## Configuration

Backend (environment variables):

- `VSP_AVATAR_CORS_ORIGINS` — comma-separated allowed origins
- `VSP_AVATAR_MAX_UPLOAD_MB` — upload limit (default 200)

Frontend:

- `VITE_API_BASE` — only needed when the frontend is served from a different
  origin than the API; the default Vite proxy handles local dev.

## Notes & limits

- MediaPipe tries the **GPU** delegate first and falls back to **CPU**.
- The sample avatar `rose-cc0.vrm` is CC0 (see
  `backend/static/avatars/ATTRIBUTION.md`). Any avatar you upload remains your
  responsibility — check its VRM license (`allowRedistribution`,
  `commercialUsage`).
- This is for **characters you own or have rights to**. Don't impersonate real
  people (celebrity likenesses, Disney characters, etc.), and disclose AI
  avatars when talking to other people.
- The vendored `frontend/public/mediapipe/` directory (~33 MB) is gitignored;
  re-run `npm run vendor:mediapipe` after a fresh clone.
- The renderer starts the avatar in its rest (often T) pose; animation/idle
  clips are a next step.

## Next steps

- Idle/blink animation clips + a pose editor
- Optional WebSocket relay client so the avatar mirrors across tabs/OBS
- Extract landmark→VRM mapping into a reusable `@vsp/avatar-core` package
- Docker Compose (backend + built frontend) for one-command deployment
