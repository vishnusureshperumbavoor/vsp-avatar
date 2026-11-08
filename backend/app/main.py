"""VSP Avatar API — FastAPI entrypoint.

Serves the avatar catalogue + presets, relays tracking WebSocket messages, and
exposes the static model directory for local-only VRM assets.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import API_VERSION, CORS_ORIGINS, STATIC_DIR
from .routers import avatars, health, presets, tracking

logger = logging.getLogger("vsp_avatar")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="VSP Avatar API",
    description="Local FastAPI backend for the VSP webcam VRM avatar app.",
    version=API_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(avatars.router, prefix="/api")
app.include_router(presets.router, prefix="/api")
app.include_router(tracking.router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api", tags=["meta"])
def api_root() -> dict[str, str]:
    return {"name": "VSP Avatar API", "version": API_VERSION, "docs": "/docs"}
