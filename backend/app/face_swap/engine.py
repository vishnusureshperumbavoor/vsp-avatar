"""CPU face-swap engine: detect -> align -> Hyperswap 256 -> paste back."""
from __future__ import annotations

import io
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

from ..config import DETECTOR_MODEL, EMBEDDER_MODEL, INFERENCE_THREADS, SWAPPER_MODEL
from . import align

SWAP_SIZE = 256
EMBED_SIZE = 112
DETECT_SCORE = 0.6


class ModelUnavailable(RuntimeError):
    """Raised when the ONNX models have not been fetched yet."""


@dataclass(frozen=True)
class DetectedFace:
    box: tuple[float, float, float, float]
    kps: np.ndarray
    score: float


@dataclass(frozen=True)
class FaceProfile:
    embedding: np.ndarray
    thumbnail: np.ndarray
    box: tuple[float, float, float, float]


def decode_jpeg(data: bytes) -> np.ndarray | None:
    buffer = np.frombuffer(data, dtype=np.uint8)
    if buffer.size == 0:
        return None
    return cv2.imdecode(buffer, cv2.IMREAD_COLOR)


def decode_upload(data: bytes) -> np.ndarray:
    """Decode a user portrait, honouring EXIF orientation, as BGR."""
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image).convert("RGB")
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def encode_jpeg(image: np.ndarray, quality: int = 85) -> bytes:
    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buffer.tobytes()


class FaceSwapEngine:
    """Loads the three ONNX models once and swaps faces on CPU."""

    def __init__(
        self,
        swapper: Path = SWAPPER_MODEL,
        embedder: Path = EMBEDDER_MODEL,
        detector: Path = DETECTOR_MODEL,
    ) -> None:
        self._paths = {
            "swapper": Path(swapper),
            "embedder": Path(embedder),
            "detector": Path(detector),
        }
        self._load_lock = threading.Lock()
        self._detect_lock = threading.Lock()
        self._swapper: ort.InferenceSession | None = None
        self._embedder: ort.InferenceSession | None = None
        self._detector: cv2.FaceDetectorYN | None = None
        self._loaded = False
        self._error: str | None = None
        self._warm = False
        cv2.setNumThreads(1)  # onnxruntime owns the parallelism

    # -- lifecycle ---------------------------------------------------------
    def missing_models(self) -> list[str]:
        return [str(path) for path in self._paths.values() if not path.is_file()]

    @property
    def loaded(self) -> bool:
        return self._loaded

    def status(self) -> dict[str, object]:
        return {
            "ready": self._loaded,
            "error": self._error,
            "provider": "CPUExecutionProvider",
            "missing": self.missing_models(),
            "models": {name: path.stat().st_size for name, path in self._paths.items() if path.is_file()},
        }

    def load(self) -> None:
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return
            missing = self.missing_models()
            if missing:
                self._error = (
                    "Missing ONNX models. Run: backend/.venv/bin/python "
                    "backend/scripts/fetch_models.py"
                )
                raise ModelUnavailable(self._error)

            options = ort.SessionOptions()
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            options.intra_op_num_threads = INFERENCE_THREADS
            options.inter_op_num_threads = 1
            options.log_severity_level = 3

            started = time.perf_counter()
            try:
                self._swapper = ort.InferenceSession(
                    str(self._paths["swapper"]),
                    options,
                    providers=["CPUExecutionProvider"],
                )
                self._embedder = ort.InferenceSession(
                    str(self._paths["embedder"]),
                    options,
                    providers=["CPUExecutionProvider"],
                )
                self._detector = cv2.FaceDetectorYN.create(
                    str(self._paths["detector"]), "", (320, 320), DETECT_SCORE, 0.3, 5000
                )
                self._loaded = True
                self._error = None
                self._warmup()
            except Exception as exc:  # noqa: BLE001 - surfaced to the client
                self._error = f"Failed to load models: {exc}"
                raise ModelUnavailable(self._error) from exc
            finally:
                elapsed = (time.perf_counter() - started) * 1000
                if self._loaded:
                    print(f"[face-swap] models loaded in {elapsed:.0f} ms")

    def _warmup(self) -> None:
        if self._warm or self._swapper is None:
            return
        target = np.random.default_rng(0).integers(0, 255, (SWAP_SIZE, SWAP_SIZE, 3), np.uint8)
        source = np.zeros((1, 512), np.float32)
        source[0, 0] = 1.0
        self._run_swapper(target, source[0])
        self._warm = True

    # -- inference ---------------------------------------------------------
    def detect(self, image: np.ndarray) -> DetectedFace | None:
        if self._detector is None:
            raise ModelUnavailable("models not loaded")
        height, width = image.shape[:2]
        face = None
        with self._detect_lock:
            self._detector.setInputSize((width, height))
            _, faces = self._detector.detect(image)
            if faces is not None and len(faces) > 0:
                # Largest detection wins; webcam frames should hold one face.
                best = max(faces, key=lambda row: float(row[2] * row[3]))
                face = DetectedFace(
                    box=tuple(float(value) for value in best[:4]),  # type: ignore[arg-type]
                    kps=np.asarray(best[4:14], dtype=np.float32).reshape(5, 2),
                    score=float(best[14]),
                )
        return face

    def embed(self, aligned: np.ndarray) -> np.ndarray:
        if self._embedder is None:
            raise ModelUnavailable("models not loaded")
        blob = cv2.dnn.blobFromImage(
            aligned, 1.0 / 127.5, (EMBED_SIZE, EMBED_SIZE), (127.5, 127.5, 127.5), swapRB=True
        )
        input_name = self._embedder.get_inputs()[0].name
        vector = self._embedder.run(None, {input_name: blob})[0][0].astype(np.float32)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm > 0 else vector

    def _run_swapper(
        self, aligned: np.ndarray, embedding: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Run the generator; returns (BGR 256x256 texture, soft face mask)."""
        if self._swapper is None:
            raise ModelUnavailable("models not loaded")
        blob = cv2.dnn.blobFromImage(
            aligned, 1.0 / 255.0, (SWAP_SIZE, SWAP_SIZE), (0.0, 0.0, 0.0), swapRB=True
        )
        # Hyperswap takes the raw normalized ArcFace embedding plus a 256px crop.
        feed: dict[str, np.ndarray] = {}
        for model_input in self._swapper.get_inputs():
            if len(model_input.shape) == 4:
                feed[model_input.name] = blob
            else:
                feed[model_input.name] = embedding.reshape(1, -1).astype(np.float32)

        outputs = self._swapper.run(None, feed)
        prediction = outputs[0][0]
        if float(prediction.max()) > 1.5:  # some exports emit 0..255 instead of 0..1
            prediction = prediction / 255.0
        rgb = np.clip(prediction, 0.0, 1.0).transpose(1, 2, 0)
        texture = (rgb[:, :, ::-1] * 255.0).astype(np.uint8)

        mask = np.ones((SWAP_SIZE, SWAP_SIZE), dtype=np.float32)
        if len(outputs) > 1:
            raw_mask = np.asarray(outputs[1])[0, 0]
            if raw_mask.shape != (SWAP_SIZE, SWAP_SIZE):
                raw_mask = cv2.resize(
                    raw_mask, (SWAP_SIZE, SWAP_SIZE), interpolation=cv2.INTER_LINEAR
                )
            mask = np.clip(raw_mask.astype(np.float32), 0.0, 1.0)
        return texture, mask

    # -- public operations -------------------------------------------------
    def profile_from_image(self, data: bytes) -> FaceProfile:
        """Detect the largest face in an upload and produce its embedding."""
        self.load()
        image = decode_upload(data)
        face = self.detect(image)
        if face is None:
            raise ValueError("No face found in that image. Use a clear, front-facing portrait.")
        if min(face.box[2], face.box[3]) < 64:
            raise ValueError(
                "That face is too small. Use a larger portrait "
                "(at least ~256px across the face)."
            )

        aligned, _ = align.norm_crop(image, face.kps, EMBED_SIZE)
        embedding = self.embed(aligned)

        x, y, w, h = face.box
        pad = 0.55
        left = max(int(x - w * pad), 0)
        top = max(int(y - h * pad), 0)
        right = min(int(x + w * (1 + pad)), image.shape[1])
        bottom = min(int(y + h * (1 + pad)), image.shape[0])
        crop = image[top:bottom, left:right]
        if crop.size == 0:
            crop = image
        return FaceProfile(embedding=embedding, thumbnail=crop, box=face.box)

    def generate_texture(
        self, frame: np.ndarray, embedding: np.ndarray
    ) -> tuple[np.ndarray | None, np.ndarray | None, DetectedFace | None]:
        """Run the generator for one frame and return its 256px texture + mask."""
        self.load()
        face = self.detect(frame)
        if face is None:
            return None, None, None
        aligned, _ = align.norm_crop(frame, face.kps, SWAP_SIZE)
        texture, mask = self._run_swapper(aligned, embedding)
        return texture, mask, face

    def composite(
        self,
        frame: np.ndarray,
        texture: np.ndarray,
        mask: np.ndarray,
        face: DetectedFace,
        *,
        seamless: bool = False,
        strength: float = 1.0,
        colour_match: bool = True,
    ) -> np.ndarray:
        """Paste a pre-generated 256px texture + model mask onto ``face``."""
        matrix = align.affine(face.kps, SWAP_SIZE)
        return align.blend_masked(
            frame,
            texture,
            mask,
            matrix,
            strength=strength,
            seamless=seamless,
            colour_match=colour_match,
        )

    def swap(
        self,
        frame: np.ndarray,
        embedding: np.ndarray,
        *,
        seamless: bool = False,
        strength: float = 1.0,
        colour_match: bool = True,
    ) -> tuple[np.ndarray, bool, float]:
        """Swap ``embedding``'s identity onto the largest face in ``frame``."""
        started = time.perf_counter()
        texture, mask, face = self.generate_texture(frame, embedding)
        if texture is None or mask is None or face is None:
            return frame, False, (time.perf_counter() - started) * 1000
        result = self.composite(
            frame,
            texture,
            mask,
            face,
            seamless=seamless,
            strength=strength,
            colour_match=colour_match,
        )
        return result, True, (time.perf_counter() - started) * 1000


_engine: FaceSwapEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> FaceSwapEngine:
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = FaceSwapEngine()
    return _engine
