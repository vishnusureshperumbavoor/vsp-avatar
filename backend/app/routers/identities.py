from fastapi import APIRouter, File, Response, UploadFile
from fastapi.responses import FileResponse

from ..face_swap import get_engine
from ..face_swap.store import IdentityStore
from ..schemas import IdentityInfo

router = APIRouter(prefix="/identities", tags=["identities"])

store = IdentityStore(get_engine())


@router.get("", response_model=list[IdentityInfo])
def list_identities() -> list[IdentityInfo]:
    return store.list()


@router.post("", response_model=IdentityInfo, status_code=201)
async def upload_identity(file: UploadFile = File(...)) -> IdentityInfo:
    data = await file.read()
    return store.save(file.filename or "identity", data)


@router.get("/{identity_id}/thumbnail")
def identity_thumbnail(identity_id: str) -> FileResponse:
    path = store.thumbnail_path(identity_id)
    return FileResponse(path, media_type="image/jpeg")


@router.delete("/{identity_id}", status_code=204)
def delete_identity(identity_id: str) -> Response:
    store.delete(identity_id)
    return Response(status_code=204)
