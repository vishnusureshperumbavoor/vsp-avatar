from fastapi import APIRouter, File, Response, UploadFile
from fastapi.responses import FileResponse

from .. import avatar_store
from ..schemas import AvatarInfo

router = APIRouter(prefix="/avatars", tags=["avatars"])


@router.get("", response_model=list[AvatarInfo])
def list_avatars() -> list[AvatarInfo]:
    return avatar_store.list_avatars()


@router.post("", response_model=AvatarInfo, status_code=201)
async def upload_avatar(file: UploadFile = File(...)) -> AvatarInfo:
    return await avatar_store.save_upload(file)


@router.get("/{avatar_id}")
def download_avatar(avatar_id: str) -> FileResponse:
    path = avatar_store.get_avatar_path(avatar_id)
    media_type = "model/gltf-binary" if path.suffix.lower() in {".vrm", ".glb"} else "model/gltf+json"
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.delete("/{avatar_id}", status_code=204)
def delete_avatar(avatar_id: str) -> Response:
    avatar_store.delete_avatar(avatar_id)
    return Response(status_code=204)
