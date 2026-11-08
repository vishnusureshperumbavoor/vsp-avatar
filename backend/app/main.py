"""VSP Avatar API — FastAPI entrypoint.

Local face-swap studio: identity portraits, presets, and the WebSocket frame
swap/relay. All inference runs on this machine.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import API_VERSION, CORS_ORIGINS, STATIC_DIR
from .face_swap import ModelUnavailable, get_engine
from .routers import health, identities, presets, swap

logger = logging.getLogger("vsp_avatar")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


async def _warm_engine() -> None:
    try:
        await asyncio.to_thread(get_engine().load)
    except ModelUnavailable as exc:
        logger.warning("%s", exc)
    except Exception:  # noqa: BLE001
        logger.exception("unexpected error while warming the face-swap engine")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_warm_engine())
    yield
    task.cancel()


app = FastAPI(
    title="VSP Avatar API",
    description="Local FastAPI backend for the VSP realtime face-swap studio.",
    version=API_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(identities.router, prefix="/api")
app.include_router(presets.router, prefix="/api")
app.include_router(swap.router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api", tags=["meta"])
def api_root() -> dict[str, str]:
    return {"name": "VSP Avatar API", "version": API_VERSION, "docs": "/docs"}
