"""Minimal room-based WebSocket relay for face/head tracking payloads.

The React client does local inference; this relay only fans out JSON messages so
multiple viewers (e.g. an OBS browser source, a second monitor, or a future
multi-user call) can mirror the same avatar pose.
"""
from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["tracking"])


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, set[WebSocket]] = {}

    async def connect(self, room: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.rooms.setdefault(room, set()).add(websocket)

    def disconnect(self, room: str, websocket: WebSocket) -> None:
        peers = self.rooms.get(room)
        if peers is None:
            return
        peers.discard(websocket)
        if not peers:
            self.rooms.pop(room, None)

    async def broadcast(self, room: str, message: str, sender: WebSocket) -> None:
        for peer in list(self.rooms.get(room, ())):
            if peer is sender:
                continue
            try:
                await peer.send_text(message)
            except Exception:
                self.disconnect(room, peer)


manager = RoomManager()


@router.get("/api/tracking/rooms")
def list_rooms() -> dict[str, dict[str, int]]:
    return {"rooms": {room: len(peers) for room, peers in manager.rooms.items()}}


@router.websocket("/ws/tracking/{room}")
async def tracking_socket(websocket: WebSocket, room: str) -> None:
    room = room[:64]
    await manager.connect(room, websocket)
    try:
        await websocket.send_json(
            {"type": "joined", "room": room, "clients": len(manager.rooms.get(room, ()))}
        )
        while True:
            message = await websocket.receive_text()
            await manager.broadcast(room, message, websocket)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(room, websocket)
