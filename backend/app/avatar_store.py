"""Filesystem-backed avatar catalogue (VRM / GLB / GLTF)."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .config import ALLOWED_AVATAR_EXTENSIONS, AVATAR_DIR, MAX_UPLOAD_BYTES
from .schemas import AvatarInfo


def _avatar_files() -> list[Path]:
    if not AVATAR_DIR.exists():
        return []
    return sorted(
        path
        for path in AVATAR_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in ALLOWED_AVATAR_EXTENSIONS
    )


def _to_info(path: Path) -> AvatarInfo:
    stat = path.stat()
    return AvatarInfo(
        id=path.stem,
        name=path.stem.replace("_", " ").replace("-", " ").title(),
        file_name=path.name,
        url=f"/api/avatars/{path.stem}",
        size_bytes=stat.st_size,
        updated_at=stat.st_mtime,
    )


def list_avatars() -> list[AvatarInfo]:
    return [_to_info(path) for path in _avatar_files()]


def get_avatar_path(avatar_id: str) -> Path:
    for path in _avatar_files():
        if path.stem == avatar_id:
            return path
    raise HTTPException(status_code=404, detail=f"Avatar '{avatar_id}' not found")


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-_").lower()
    return slug[:64]


async def save_upload(file: UploadFile) -> AvatarInfo:
    filename = Path(file.filename or "avatar.vrm").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_AVATAR_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_AVATAR_EXTENSIONS))
        raise HTTPException(status_code=400, detail=f"Unsupported file type. Allowed: {allowed}")

    stem = _slugify(Path(filename).stem) or "avatar"
    target = AVATAR_DIR / f"{stem}{suffix}"
    counter = 1
    while target.exists():
        target = AVATAR_DIR / f"{stem}-{counter}{suffix}"
        counter += 1

    temp = target.with_suffix(target.suffix + ".part")
    size = 0
    try:
        with temp.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
                    )
                out.write(chunk)
        temp.replace(target)
    except Exception:
        temp.unlink(missing_ok=True)
        raise

    return _to_info(target)


def delete_avatar(avatar_id: str) -> None:
    path = get_avatar_path(avatar_id)
    path.unlink(missing_ok=True)
