"""Face alignment and paste-back helpers.

Reproduces the geometry parts of the InsightFace pipeline: the 5-point ArcFace
template, an affine crop, a colour-matched feathered composite.
"""
from __future__ import annotations

import cv2
import numpy as np

# Canonical 5-point template used by ArcFace/InsightFace, in 112x112 space.
# Order: image-left eye, image-right eye, nose tip, image-left mouth, image-right mouth.
ARCFACE_112 = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def template(size: int) -> np.ndarray:
    """Reference 5-point template for a ``size x size`` crop.

    Matches InsightFace's ``estimate_norm``: 112px multiples scale the template,
    while 128px multiples keep the 112px scale and shift it right by 8px. The
    swap generator was trained on the latter, so this matters.
    """
    if size % 112 == 0:
        ratio = size / 112.0
        diff_x = 0.0
    else:  # 128px multiples
        ratio = size / 128.0
        diff_x = 8.0 * ratio
    dst = ARCFACE_112 * ratio
    dst[:, 0] += diff_x
    return dst.astype(np.float32)


def affine(kps: np.ndarray, size: int) -> np.ndarray:
    """Affine matrix mapping the frame onto a ``size`` aligned crop."""
    src = np.asarray(kps, dtype=np.float32).reshape(5, 2)
    dst = template(size)
    matrix, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)
    if matrix is None:
        matrix = cv2.getAffineTransform(src[:3], dst[:3])
    return matrix


def norm_crop(
    image: np.ndarray, kps: np.ndarray, size: int = 112
) -> tuple[np.ndarray, np.ndarray]:
    """Align a face given its 5 landmarks; returns (crop, affine matrix)."""
    matrix = affine(kps, size)
    crop = cv2.warpAffine(
        image,
        matrix,
        (size, size),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return crop, matrix


def match_colour(
    swapped: np.ndarray, frame: np.ndarray, mask: np.ndarray
) -> np.ndarray:
    """Transfer the frame's LAB statistics onto the swapped face.

    Keeps the generator's skin tone from fighting the scene lighting, which is
    the most common "pasted on" artefact on CPU-friendly low-resolution swaps.
    """
    region = mask > 16
    if not region.any():
        return swapped
    lab_src = cv2.cvtColor(swapped, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab_ref = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB).astype(np.float32)
    for channel in range(3):
        src = lab_src[..., channel][region]
        ref = lab_ref[..., channel][region]
        src_std = float(src.std())
        if src_std < 1e-3:
            continue
        scale = float(ref.std()) / src_std
        scale = min(max(scale, 0.7), 1.4)  # avoid extreme corrections
        lab_src[..., channel] = (lab_src[..., channel] - float(src.mean())) * scale + float(
            ref.mean()
        )
    matched = cv2.cvtColor(np.clip(lab_src, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
    # Only trust the correction inside the mask; keep the original elsewhere.
    alpha = (mask.astype(np.float32) / 255.0)[..., None]
    return (matched.astype(np.float32) * alpha + swapped.astype(np.float32) * (1 - alpha)).astype(
        np.uint8
    )


def blend_masked(
    frame: np.ndarray,
    swapped: np.ndarray,
    mask: np.ndarray,
    matrix: np.ndarray,
    *,
    strength: float = 1.0,
    seamless: bool = False,
    colour_match: bool = True,
) -> np.ndarray:
    """Composite a 256x256 texture using the generator's own soft mask."""
    if strength <= 0.0:
        return frame

    height, width = frame.shape[:2]
    inverse = cv2.invertAffineTransform(matrix)
    warped = cv2.warpAffine(
        swapped,
        inverse,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    alpha = cv2.warpAffine(
        np.asarray(mask, dtype=np.float32),
        inverse,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    alpha = np.clip(alpha, 0.0, 1.0)
    alpha = cv2.GaussianBlur(alpha, (5, 5), 0)

    mask_u8 = (alpha * 255).astype(np.uint8)
    if colour_match and mask_u8.any():
        warped = match_colour(warped, frame, mask_u8)

    if seamless:
        clone_mask = (alpha > 0.5).astype(np.uint8) * 255
        if clone_mask.any():
            ys, xs = np.nonzero(clone_mask)
            center = (int(xs.mean()), int(ys.mean()))
            try:
                return cv2.seamlessClone(
                    warped, frame, clone_mask, center, cv2.NORMAL_CLONE
                )
            except cv2.error:
                pass  # fall through to the alpha blend

    alpha = (alpha * min(max(strength, 0.0), 1.0))[..., None]
    mixed = frame.astype(np.float32) * (1.0 - alpha) + warped.astype(np.float32) * alpha
    return np.clip(mixed, 0, 255).astype(np.uint8)

