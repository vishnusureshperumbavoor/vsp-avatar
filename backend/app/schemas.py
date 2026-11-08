"""Pydantic schemas shared by the API routers."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    version: str
    gpu_hint: str = "webgl-client"


class AvatarInfo(BaseModel):
    id: str
    name: str
    file_name: str
    url: str
    size_bytes: int
    updated_at: float | None = None


class PresetPayload(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class PresetInfo(BaseModel):
    name: str
    data: dict[str, Any] = Field(default_factory=dict)
    updated_at: float | None = None


class TrackingRoom(BaseModel):
    room: str
    clients: int
