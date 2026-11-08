#!/usr/bin/env python3
"""Fetch the ONNX models used by the face-swap engine.

Downloads into ``backend/models/``:

* ``hyperswap_1a_256.onnx``            — FaceFusion Hyperswap 256 generator (~385 MB)
* ``w600k_r50.onnx``                   — ArcFace identity embedder (~167 MB)
* ``face_detection_yunet_2023mar.onnx``— OpenCV YuNet face detector (~230 KB)

Models are *not* committed to git (see .gitignore). They are licensed by their
upstream projects; see ``backend/models/ATTRIBUTION.md``.

Usage:
    python scripts/fetch_models.py [--force]
"""
from __future__ import annotations

import argparse
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models"

SWAPPER_URLS = [
    "https://huggingface.co/facefusion/models-3.3.0/resolve/main/"
    "hyperswap_1a_256.onnx",
]
# The GitHub release is occasionally flaky (HTTP 504); the Hugging Face mirror
# serves the same ArcFace recognition model directly, so try it first.
EMBEDDER_URLS = [
    "https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx",
]
BUFFALO_ZIP_URLS = [
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
]
YUNET_URLS = [
    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/"
    "face_detection_yunet_2023mar.onnx",
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx",
]

# file -> minimum plausible size in bytes
EXPECTED = {
    "hyperswap_1a_256.onnx": 300 * 1024 * 1024,
    "w600k_r50.onnx": 100 * 1024 * 1024,
    "face_detection_yunet_2023mar.onnx": 100 * 1024,
}

HEADERS = {"User-Agent": "vsp-avatar/0.2 (local model fetch)"}


def _download(url: str, destination: Path) -> None:
    """Stream ``url`` to ``destination`` with progress and HTTP range resume."""
    offset = destination.stat().st_size if destination.exists() else 0
    request = urllib.request.Request(url, headers=HEADERS)
    if offset:
        request.add_header("Range", f"bytes={offset}-")

    with urllib.request.urlopen(request, timeout=60) as response:
        if offset and response.status != 206:
            offset = 0  # server ignored the range request; start over
        total = response.headers.get("Content-Length")
        total = int(total) + offset if total else None
        mode = "ab" if offset else "wb"
        written = offset
        with destination.open(mode) as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
                written += len(chunk)
                if total:
                    pct = written * 100 / total
                    sys.stdout.write(
                        f"\r  {destination.name}: {written / 1_048_576:.1f}"
                        f"/{total / 1_048_576:.1f} MB ({pct:5.1f}%)"
                    )
                else:
                    sys.stdout.write(f"\r  {destination.name}: {written / 1_048_576:.1f} MB")
                sys.stdout.flush()
    sys.stdout.write("\n")


def _try_urls(urls: list[str], destination: Path) -> None:
    errors: list[str] = []
    for url in urls:
        try:
            print(f"downloading {url}")
            _download(url, destination)
            return
        except Exception as exc:  # noqa: BLE001 - try the next mirror
            errors.append(f"{url}: {exc}")
            print(f"  failed: {exc}", file=sys.stderr)
            destination.unlink(missing_ok=True)
    raise RuntimeError("all mirrors failed:\n  " + "\n  ".join(errors))


def _fetch_swapper(force: bool) -> None:
    target = MODEL_DIR / "hyperswap_1a_256.onnx"
    if target.exists() and not force and target.stat().st_size >= EXPECTED[target.name]:
        print(f"already present: {target.name}")
        return
    target.unlink(missing_ok=True)
    _try_urls(SWAPPER_URLS, target)


def _fetch_embedder(force: bool) -> None:
    target = MODEL_DIR / "w600k_r50.onnx"
    if target.exists() and not force and target.stat().st_size >= EXPECTED[target.name]:
        print(f"already present: {target.name}")
        return
    target.unlink(missing_ok=True)

    try:
        _try_urls(EMBEDDER_URLS, target)
        return
    except RuntimeError as exc:
        print(f"direct embedder mirror failed, trying buffalo_l.zip\n{exc}", file=sys.stderr)

    archive = MODEL_DIR / "buffalo_l.zip"
    try:
        _try_urls(BUFFALO_ZIP_URLS, archive)
        print("extracting w600k_r50.onnx from buffalo_l.zip")
        with zipfile.ZipFile(archive) as bundle:
            member = next(
                name
                for name in bundle.namelist()
                if Path(name).name == "w600k_r50.onnx"
            )
            with bundle.open(member) as source, target.open("wb") as out:
                while chunk := source.read(1024 * 1024):
                    out.write(chunk)
    finally:
        archive.unlink(missing_ok=True)


def _fetch_yunet(force: bool) -> None:
    target = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
    if target.exists() and not force and target.stat().st_size >= EXPECTED[target.name]:
        print(f"already present: {target.name}")
        return
    target.unlink(missing_ok=True)
    _try_urls(YUNET_URLS, target)


ATTRIBUTION = """\
# Third-party model attribution

These files are downloaded at setup time; they are not part of this repository.

- `hyperswap_1a_256.onnx` — FaceFusion Hyperswap 256 face-swap generator.
  https://github.com/facefusion/facefusion
  Check the upstream FaceFusion and model terms before commercial use.
- `w600k_r50.onnx` — InsightFace `buffalo_l` ArcFace recognition model.
  Distributed by InsightFace for **non-commercial research purposes only**.
  https://github.com/deepinsight/insightface
- `face_detection_yunet_2023mar.onnx` — OpenCV Zoo YuNet detector (MIT).
  https://github.com/opencv/opencv_zoo

Use these only with faces you own or have explicit permission to use, and
disclose synthetic media when sharing it with other people.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args()

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _fetch_swapper(args.force)
        _fetch_embedder(args.force)
        _fetch_yunet(args.force)
    except Exception as exc:  # noqa: BLE001
        print(f"model download failed: {exc}", file=sys.stderr)
        return 1

    for name, minimum in EXPECTED.items():
        path = MODEL_DIR / name
        if not path.exists() or path.stat().st_size < minimum:
            print(f"model looks incomplete: {name}", file=sys.stderr)
            return 1

    (MODEL_DIR / "ATTRIBUTION.md").write_text(ATTRIBUTION, encoding="utf-8")
    print("\nmodels ready in", MODEL_DIR)
    for name in EXPECTED:
        print(f"  {name}: {(MODEL_DIR / name).stat().st_size / 1_048_576:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
