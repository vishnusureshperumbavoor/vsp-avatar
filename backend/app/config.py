"""Application configuration and filesystem layout."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
PRESETS_FILE = DATA_DIR / "presets.json"

MODEL_DIR = BASE_DIR / "models"
# Hyperswap 256 is faster and noticeably sharper than inswapper_128 on CPU.
SWAPPER_MODEL = MODEL_DIR / "hyperswap_1a_256.onnx"
EMBEDDER_MODEL = MODEL_DIR / "w600k_r50.onnx"
DETECTOR_MODEL = MODEL_DIR / "face_detection_yunet_2023mar.onnx"

FACE_DIR = DATA_DIR / "faces"
THUMB_SIZE = 256

for _directory in (STATIC_DIR, DATA_DIR, FACE_DIR, MODEL_DIR):
    _directory.mkdir(parents=True, exist_ok=True)

# Identity portraits are small; the swap stream carries JPEG frames, not these.
MAX_FACE_UPLOAD_MB = int(os.getenv("VSP_AVATAR_MAX_FACE_UPLOAD_MB", "16"))
MAX_FACE_UPLOAD_BYTES = MAX_FACE_UPLOAD_MB * 1024 * 1024

# How many swap streams may run at once. One keeps per-frame latency predictable
# on a CPU; raise it only if you have cores to spare.
MAX_SWAP_STREAMS = max(1, int(os.getenv("VSP_AVATAR_MAX_SWAP_STREAMS", "1")))

# 0 lets onnxruntime pick a sensible thread count for the machine.
INFERENCE_THREADS = int(os.getenv("VSP_AVATAR_INFERENCE_THREADS", "0"))

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "VSP_AVATAR_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]

API_VERSION = "0.2.0"
