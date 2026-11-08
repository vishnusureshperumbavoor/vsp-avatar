from fastapi import APIRouter, Response

from .. import preset_store
from ..schemas import PresetInfo, PresetPayload

router = APIRouter(prefix="/presets", tags=["presets"])


@router.get("", response_model=list[PresetInfo])
def list_presets() -> list[PresetInfo]:
    return preset_store.list_presets()


@router.get("/{name}", response_model=PresetInfo)
def get_preset(name: str) -> PresetInfo:
    return preset_store.get_preset(name)


@router.put("/{name}", response_model=PresetInfo)
def put_preset(name: str, payload: PresetPayload) -> PresetInfo:
    return preset_store.put_preset(name, payload.data)


@router.delete("/{name}", status_code=204)
def delete_preset(name: str) -> Response:
    preset_store.delete_preset(name)
    return Response(status_code=204)
