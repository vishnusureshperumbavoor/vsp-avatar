"""JSON-file-backed preset storage for camera / avatar settings."""
from __future__ import annotations

import json
import re
import time
from threading import Lock
from typing import Any

from fastapi import HTTPException

from .config import PRESETS_FILE
from .schemas import PresetInfo

_lock = Lock()
_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def _validate_name(name: str) -> str:
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Preset name must be 1-64 chars: a-z, 0-9, _ or -")
    return name


def _read() -> dict[str, dict[str, Any]]:
    if not PRESETS_FILE.exists():
        return {}
    try:
        raw = json.loads(PRESETS_FILE.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError:
        return {}
    return raw if isinstance(raw, dict) else {}


def _write(data: dict[str, dict[str, Any]]) -> None:
    PRESETS_FILE.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def list_presets() -> list[PresetInfo]:
    return [
        PresetInfo(name=name, data=entry.get("data", {}), updated_at=entry.get("updated_at"))
        for name, entry in sorted(_read().items())
    ]


def get_preset(name: str) -> PresetInfo:
    _validate_name(name)
    entry = _read().get(name)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Preset '{name}' not found")
    return PresetInfo(name=name, data=entry.get("data", {}), updated_at=entry.get("updated_at"))


def put_preset(name: str, data: dict[str, Any]) -> PresetInfo:
    _validate_name(name)
    entry = {"data": data, "updated_at": time.time()}
    with _lock:
        store = _read()
        store[name] = entry
        _write(store)
    return PresetInfo(name=name, **entry)


def delete_preset(name: str) -> None:
    _validate_name(name)
    with _lock:
        store = _read()
        if name not in store:
            raise HTTPException(status_code=404, detail=f"Preset '{name}' not found")
        del store[name]
        _write(store)
