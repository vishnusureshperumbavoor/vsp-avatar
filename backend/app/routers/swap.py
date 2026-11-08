"""WebSocket face-swap stream.

A *driver* client streams JPEG frames as binary messages and receives swapped
JPEG frames back. Viewers can join the same room (an OBS browser source or a
second screen) and receive a copy of those frames.

Two modes keep this usable on a CPU:

``smooth`` (default)
    Every frame is composited at preview speed (~15 fps) using the most recent
    swapped 256x256 face texture, while the generator refreshes that texture
    asynchronously on the newest frame. Head motion tracks in real time;
    expression/identity refresh at whatever the CPU can manage.

``exact``
    Every frame runs the full generator, so output is frame-accurate but the
    frame rate is whatever the model achieves on this machine.

Text messages are control/status only; binary messages are always image frames::

    driver -> server  {"type": "identity", "id": "maya"}
                      {"type": "config", "mode": "smooth", "seamless": false,
                       "strength": 1.0, "quality": 85, "colour_match": true}
                      <binary jpeg>
    server -> driver  {"type": "ready", "engine": {...}}
                      {"type": "stats", "ms": 24.1, "swap_ms": 2500, ...}
                      <binary jpeg>
    server -> viewer  {"type": "joined", "role": "viewer", "room": "main"}
                      <binary jpeg>
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketDisconnected

from ..config import MAX_SWAP_STREAMS
from ..face_swap import ModelUnavailable, get_engine
from ..face_swap.engine import DetectedFace, decode_jpeg, encode_jpeg
from ..face_swap.store import IdentityStore

logger = logging.getLogger("vsp_avatar.swap")

router = APIRouter(tags=["swap"])

engine = get_engine()
store = IdentityStore(engine)
swap_slots = asyncio.Semaphore(MAX_SWAP_STREAMS)


class Viewer:
    """One viewer with a single-frame mailbox so a slow client cannot block us."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=1)
        self.task = asyncio.create_task(self._writer())

    async def _writer(self) -> None:
        while True:
            frame = await self.queue.get()
            if frame is None:
                break
            try:
                await self.websocket.send_bytes(frame)
            except Exception:  # noqa: BLE001 - client went away
                break

    def offer(self, frame: bytes) -> None:
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            pass

    def close(self) -> None:
        if not self.queue.full():
            try:
                self.queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self.task.cancel()


class FrameHub:
    def __init__(self) -> None:
        self.rooms: dict[str, set[Viewer]] = {}

    def add(self, room: str, viewer: Viewer) -> None:
        self.rooms.setdefault(room, set()).add(viewer)

    def remove(self, room: str, viewer: Viewer) -> None:
        peers = self.rooms.get(room)
        if peers is None:
            return
        peers.discard(viewer)
        if not peers:
            self.rooms.pop(room, None)

    def broadcast(self, room: str, frame: bytes) -> None:
        for viewer in self.rooms.get(room, ()):
            viewer.offer(frame)


hub = FrameHub()


@router.get("/api/swap/status")
def swap_status() -> dict[str, object]:
    return {
        "engine": engine.status(),
        "streams": MAX_SWAP_STREAMS,
        "viewers": {room: len(peers) for room, peers in hub.rooms.items()},
    }


class StreamState:
    """Per-connection render state: the latest generated face texture."""

    def __init__(self) -> None:
        self.texture: np.ndarray | None = None
        self.mask: np.ndarray | None = None
        self.texture_at = 0.0
        self.swap_ms = 0.0
        self.swaps = 0
        self.generating = False
        self.alive = True
        self.embedding: np.ndarray | None = None


class Settings:
    def __init__(self) -> None:
        self.mode = "smooth"
        self.seamless = False
        self.strength = 1.0
        self.quality = 85
        self.colour_match = True

    def as_dict(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "seamless": self.seamless,
            "strength": self.strength,
            "quality": self.quality,
            "colour_match": self.colour_match,
        }


def _as_bool(value: object, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _as_float(value: object, default: float) -> float:
    if isinstance(value, (int, float)):
        return min(max(float(value), 0.0), 1.0)
    return default


@router.websocket("/ws/swap/{room}")
async def swap_socket(websocket: WebSocket, room: str) -> None:
    room = (room or "main")[:48]
    role = websocket.query_params.get("role", "driver")
    await websocket.accept()

    if role == "viewer":
        viewer = Viewer(websocket)
        hub.add(room, viewer)
        try:
            await websocket.send_json(
                {"type": "joined", "role": "viewer", "room": room,
                 "viewers": len(hub.rooms.get(room, ()))}
            )
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
        except (WebSocketDisconnect, WebSocketDisconnected):
            pass
        finally:
            hub.remove(room, viewer)
            viewer.close()
        return

    await _run_driver(websocket, room)


async def _run_driver(websocket: WebSocket, room: str) -> None:
    await websocket.send_json(
        {"type": "hello", "role": "driver", "room": room, "engine": engine.status()}
    )
    try:
        await asyncio.to_thread(engine.load)
    except ModelUnavailable as exc:
        logger.error("face-swap engine unavailable: %s", exc)
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close(code=1011)
        return

    state = StreamState()
    settings = Settings()
    identity_id = websocket.query_params.get("identity") or None
    if identity_id:
        state.embedding = store.embedding(identity_id)
        if state.embedding is None:
            await websocket.send_json(
                {"type": "warning", "message": f"Unknown identity '{identity_id}'."}
            )
            identity_id = None

    await websocket.send_json(
        {
            "type": "ready",
            "engine": engine.status(),
            "identity": identity_id,
            "settings": settings.as_dict(),
        }
    )

    frames = 0
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            text = message.get("text")
            if text is not None:
                identity_id, state.embedding = await _handle_control(
                    websocket, text, settings, state, identity_id
                )
                continue

            payload = message.get("bytes")
            if not payload:
                continue
            if state.embedding is None:
                await websocket.send_json(
                    {"type": "error", "message": "Choose a source face before streaming."}
                )
                continue

            started = time.perf_counter()
            frame = await asyncio.to_thread(decode_jpeg, payload)
            if frame is None:
                await websocket.send_json({"type": "error", "message": "Could not decode frame"})
                continue

            found = False
            output = frame

            if settings.mode == "exact":
                output, found, elapsed = await asyncio.to_thread(
                    engine.swap,
                    frame,
                    state.embedding,
                    seamless=settings.seamless,
                    strength=settings.strength,
                    colour_match=settings.colour_match,
                )
                state.swap_ms = elapsed
                state.swaps += 1
            else:
                # Keep the generator busy on the freshest frame without blocking.
                if not state.generating:
                    state.generating = True
                    asyncio.create_task(
                        _refresh_texture(state, frame.copy(), settings)
                    )

                face: DetectedFace | None = await asyncio.to_thread(engine.detect, frame)
                found = face is not None
                if face is not None and state.texture is not None and state.mask is not None:
                    output = await asyncio.to_thread(
                        engine.composite,
                        frame,
                        state.texture,
                        state.mask,
                        face,
                        seamless=settings.seamless,
                        strength=settings.strength,
                        colour_match=settings.colour_match,
                    )

            encoded = await asyncio.to_thread(encode_jpeg, output, settings.quality)
            preview_ms = (time.perf_counter() - started) * 1000

            frames += 1
            await websocket.send_bytes(encoded)
            hub.broadcast(room, encoded)
            await websocket.send_json(
                {
                    "type": "stats",
                    "n": frames,
                    "ms": round(preview_ms, 1),
                    "swap_ms": round(state.swap_ms, 1),
                    "swaps": state.swaps,
                    "face": found,
                    "mode": settings.mode,
                    "texture_age_ms": round(
                        (time.time() - state.texture_at) * 1000 if state.texture_at else 0
                    ),
                    "bytes": len(encoded),
                }
            )
    except (WebSocketDisconnect, WebSocketDisconnected):
        pass
    except Exception:  # noqa: BLE001 - surface but keep the server up
        logger.exception("driver stream failed")
    finally:
        state.alive = False
        logger.info("driver left room %s after %d frames", room, frames)


async def _refresh_texture(state: StreamState, frame: np.ndarray, settings: Settings) -> None:
    """Run the generator on a snapshot and publish the new face texture."""
    try:
        if state.embedding is None:
            return
        async with swap_slots:
            started = time.perf_counter()
            texture, mask, _face = await asyncio.to_thread(
                engine.generate_texture, frame, state.embedding
            )
            elapsed = (time.perf_counter() - started) * 1000
        if not state.alive:
            return
        if texture is not None and mask is not None:
            state.texture = texture
            state.mask = mask
            state.texture_at = time.time()
            state.swap_ms = elapsed
            state.swaps += 1
    except Exception:  # noqa: BLE001
        logger.exception("texture refresh failed")
    finally:
        state.generating = False


async def _handle_control(
    websocket: WebSocket,
    text: str,
    settings: Settings,
    state: StreamState,
    identity_id: str | None,
) -> tuple[str | None, np.ndarray | None]:
    try:
        message = json.loads(text)
    except json.JSONDecodeError:
        await websocket.send_json({"type": "error", "message": "Invalid control message"})
        return identity_id, state.embedding

    kind = message.get("type")

    if kind == "identity":
        requested = message.get("id")
        vector = store.embedding(requested) if isinstance(requested, str) and requested else None
        if vector is None:
            await websocket.send_json(
                {"type": "error", "message": f"Identity '{requested}' not found"}
            )
            return identity_id, state.embedding
        state.texture = None
        state.mask = None
        state.texture_at = 0.0
        await websocket.send_json({"type": "identity", "ok": True, "id": requested})
        return requested, vector

    if kind == "config":
        if message.get("mode") in {"smooth", "exact"}:
            settings.mode = message["mode"]
        settings.seamless = _as_bool(message.get("seamless"), settings.seamless)
        settings.strength = _as_float(message.get("strength"), settings.strength)
        settings.colour_match = _as_bool(
            message.get("colour_match"), settings.colour_match
        )
        raw_quality = message.get("quality")
        if isinstance(raw_quality, int):
            settings.quality = min(max(raw_quality, 50), 95)
        await websocket.send_json({"type": "config", "ok": True, **settings.as_dict()})
        return identity_id, state.embedding

    await websocket.send_json({"type": "error", "message": f"Unknown control type '{kind}'"})
    return identity_id, state.embedding
