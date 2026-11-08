#!/usr/bin/env bash
# Start the FastAPI backend and the Vite dev server together.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$ROOT/backend"
WEB_DIR="$ROOT/frontend"

if [ ! -x "$API_DIR/.venv/bin/uvicorn" ]; then
  echo "backend venv missing. See README 'Backend setup'." >&2
  exit 1
fi

if [ ! -d "$WEB_DIR/node_modules" ]; then
  echo "frontend deps missing. Run: cd frontend && npm install" >&2
  exit 1
fi

if [ ! -f "$API_DIR/models/hyperswap_1a_256.onnx" ] || [ ! -f "$API_DIR/models/w600k_r50.onnx" ] || [ ! -f "$API_DIR/models/face_detection_yunet_2023mar.onnx" ]; then
  echo "ONNX models missing. Run: backend/.venv/bin/python backend/scripts/fetch_models.py" >&2
  exit 1
fi

cleanup() {
  kill "${API_PID:-}" "${WEB_PID:-}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

(
  cd "$API_DIR"
  exec .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
) &
API_PID=$!

(
  cd "$WEB_DIR"
  exec npm run dev
) &
WEB_PID=$!

echo "API:  http://127.0.0.1:8000/docs"
echo "App:  http://127.0.0.1:5173"
wait
