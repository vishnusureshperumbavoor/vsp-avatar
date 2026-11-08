"""Application configuration and filesystem layout."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
AVATAR_DIR = STATIC_DIR / "avatars"
DATA_DIR = BASE_DIR / "data"
PRESETS_FILE = DATA_DIR / "presets.json"
MODEL_DIR = BASE_DIR / "models"

for _directory in (STATIC_DIR, AVATAR_DIR, DATA_DIR, MODEL_DIR):
    _directory.mkdir(parents=True, exist_ok=True)

ALLOWED_AVATAR_EXTENSIONS = {".vrm", ".glb", ".gltf"}
MAX_UPLOAD_MB = int(os.getenv("VSP_AVATAR_MAX_UPLOAD_MB", "200"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "VSP_AVATAR_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]

API_VERSION = "0.1.0"
