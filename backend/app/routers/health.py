from fastapi import APIRouter

from ..config import API_VERSION
from ..face_swap import get_engine
from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    engine = get_engine()
    status = engine.status()
    return HealthResponse(
        status="ok",
        version=API_VERSION,
        engine_ready=bool(status["ready"]),
        engine_error=status["error"],  # type: ignore[arg-type]
        missing_models=status["missing"],  # type: ignore[arg-type]
    )
