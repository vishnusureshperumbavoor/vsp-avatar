"""Pydantic schemas shared by the API routers."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    version: str
    engine_ready: bool = False
    engine_error: str | None = None
    provider: str = "CPUExecutionProvider"
    missing_models: list[str] = Field(default_factory=list)


class IdentityInfo(BaseModel):
    id: str
    name: str
    thumbnail_url: str
    created_at: float
    face_box: list[float] | None = None


class PresetPayload(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class PresetInfo(BaseModel):
    name: str
    data: dict[str, Any] = Field(default_factory=dict)
    updated_at: float | None = None
