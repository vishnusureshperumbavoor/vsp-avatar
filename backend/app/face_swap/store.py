"""Filesystem-backed store of face identities (source portraits + embeddings)."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from threading import Lock

import cv2
import numpy as np
from fastapi import HTTPException

from ..config import FACE_DIR, MAX_FACE_UPLOAD_BYTES, THUMB_SIZE
from ..schemas import IdentityInfo
from .engine import FaceSwapEngine

_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]+")


def _slugify(value: str) -> str:
    slug = _NAME_RE.sub("-", value).strip("-_").lower()
    return slug[:48]


def _safe_id(identity_id: str) -> str:
    cleaned = _slugify(identity_id)
    if not cleaned:
        raise HTTPException(status_code=400, detail="Invalid identity id")
    return cleaned


class IdentityStore:
    def __init__(self, engine: FaceSwapEngine, root: Path = FACE_DIR) -> None:
        self.engine = engine
        self.root = root
        self._lock = Lock()
        self._embeddings: dict[str, np.ndarray] = {}

    # -- helpers -----------------------------------------------------------
    def _dir(self, identity_id: str) -> Path:
        return self.root / _safe_id(identity_id)

    def _meta_path(self, identity_id: str) -> Path:
        return self._dir(identity_id) / "meta.json"

    def _read_meta(self, identity_id: str) -> dict | None:
        path = self._meta_path(identity_id)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None

    def _to_info(self, identity_id: str, meta: dict) -> IdentityInfo:
        updated = self._dir(identity_id).stat().st_mtime
        return IdentityInfo(
            id=identity_id,
            name=meta.get("name", identity_id),
            thumbnail_url=f"/api/identities/{identity_id}/thumbnail?v={int(updated)}",
            created_at=float(meta.get("created_at", updated)),
            face_box=meta.get("face_box"),
        )

    # -- queries -----------------------------------------------------------
    def list(self) -> list[IdentityInfo]:
        if not self.root.exists():
            return []
        items: list[IdentityInfo] = []
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir():
                continue
            meta = self._read_meta(directory.name)
            if meta is not None and (directory / "embedding.npy").is_file():
                items.append(self._to_info(directory.name, meta))
        return items

    def exists(self, identity_id: str) -> bool:
        return (self._dir(identity_id) / "embedding.npy").is_file()

    def embedding(self, identity_id: str) -> np.ndarray | None:
        identity_id = _safe_id(identity_id)
        cached = self._embeddings.get(identity_id)
        if cached is not None:
            return cached
        path = self._dir(identity_id) / "embedding.npy"
        if not path.is_file():
            return None
        vector = np.load(path).astype(np.float32)
        self._embeddings[identity_id] = vector
        return vector

    def thumbnail_path(self, identity_id: str) -> Path:
        path = self._dir(identity_id) / "thumbnail.jpg"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Identity not found")
        return path

    # -- mutations ---------------------------------------------------------
    def save(self, filename: str, data: bytes) -> IdentityInfo:
        if len(data) > MAX_FACE_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Portrait exceeds {MAX_FACE_UPLOAD_BYTES // (1024 * 1024)} MB",
            )
        if not data:
            raise HTTPException(status_code=400, detail="Empty upload")

        try:
            profile = self.engine.profile_from_image(data)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - bad image data
            raise HTTPException(status_code=422, detail=f"Could not read image: {exc}") from exc

        stem = _slugify(Path(filename or "identity").stem) or "identity"
        with self._lock:
            identity_id = stem
            counter = 1
            while self._dir(identity_id).exists():
                identity_id = f"{stem}-{counter}"
                counter += 1

            directory = self._dir(identity_id)
            directory.mkdir(parents=True, exist_ok=False)

            thumbnail = profile.thumbnail
            height, width = thumbnail.shape[:2]
            scale = THUMB_SIZE / max(height, width)
            resized = cv2.resize(
                thumbnail,
                (max(int(width * scale), 1), max(int(height * scale), 1)),
                interpolation=cv2.INTER_AREA,
            )
            cv2.imwrite(
                str(directory / "thumbnail.jpg"),
                resized,
                [int(cv2.IMWRITE_JPEG_QUALITY), 90],
            )
            np.save(directory / "embedding.npy", profile.embedding)
            meta = {
                "name": Path(filename or identity_id).stem.replace("_", " ").title()
                or identity_id,
                "created_at": time.time(),
                "face_box": [round(value, 2) for value in profile.box],
            }
            (directory / "meta.json").write_text(
                json.dumps(meta, indent=2), encoding="utf-8"
            )
            self._embeddings[identity_id] = profile.embedding

        return self._to_info(identity_id, meta)

    def delete(self, identity_id: str) -> None:
        identity_id = _safe_id(identity_id)
        directory = self._dir(identity_id)
        if not directory.is_dir():
            raise HTTPException(status_code=404, detail="Identity not found")
        with self._lock:
            for path in sorted(directory.rglob("*"), reverse=True):
                if path.is_file() or path.is_symlink():
                    path.unlink(missing_ok=True)
                elif path.is_dir():
                    path.rmdir()
            directory.rmdir()
            self._embeddings.pop(identity_id, None)
