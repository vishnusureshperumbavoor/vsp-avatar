#!/usr/bin/env python3
"""Fetch a CC0 sample VRM avatar into backend/static/avatars.

The default asset comes from the Open Source Avatars "100Avatars" collection,
which is released under CC0 (public domain). A VRM sample shipped with the
pixiv/three-vrm repository is used as a fallback.

Usage:
    python scripts/fetch_sample_avatar.py
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST_DIR = ROOT / "static" / "avatars"
DEST = DEST_DIR / "rose-cc0.vrm"

SOURCES = [
    (
        "https://arweave.net/Ea1KXujzJatQgCFSMzGOzp_UtHqB1pyia--U3AtkMAY",
        "rose-cc0.vrm",
    ),
    (
        "https://github.com/pixiv/three-vrm/raw/dev/"
        "packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm",
        "constraint-sample.vrm",
    ),
]


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "vsp-avatar/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read()
    if data[:4] != b"glTF":
        raise ValueError(f"{url} did not return a binary glTF/VRM payload")
    destination.write_bytes(data)
    print(f"wrote {destination} ({len(data) / 1_048_576:.2f} MB)")


def main() -> int:
    DEST_DIR.mkdir(parents=True, exist_ok=True)
    if DEST.exists() and DEST.stat().st_size > 0:
        print(f"already present: {DEST}")
        return 0

    for url, filename in SOURCES:
        target = DEST_DIR / filename
        try:
            print(f"downloading {url}")
            _download(url, target)
            if target != DEST:
                target.replace(DEST)
            return 0
        except Exception as exc:  # try the next source
            print(f"  failed: {exc}", file=sys.stderr)
            target.unlink(missing_ok=True)

    print("could not fetch a sample avatar", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
