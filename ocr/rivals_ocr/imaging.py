"""Upload validation: the first stage of the screenshot pipeline."""

from __future__ import annotations

import cv2
import numpy as np

DEFAULT_MAX_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_DIMENSION = 4096
DEFAULT_MIN_DIMENSION = 320

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class ImageError(Exception):
    """A rejected upload, carrying the HTTP status the service should answer."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def sniff_type(data: bytes) -> str | None:
    """Magic bytes only: a renamed file must never reach the decoder."""
    if data.startswith(PNG_MAGIC):
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decode(
    data: bytes,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
    min_dimension: int = DEFAULT_MIN_DIMENSION,
) -> np.ndarray:
    """Validates size, type and dimensions, then returns a BGR image."""
    if not data:
        raise ImageError("invalid_image", "The upload is empty.", 400)
    if len(data) > max_bytes:
        raise ImageError(
            "too_large",
            f"Screenshots are up to {max_bytes // (1024 * 1024)} MB.",
            413,
        )
    if sniff_type(data) is None:
        raise ImageError(
            "unsupported_type", "Only PNG, JPEG or WebP screenshots are supported.", 415
        )
    buffer = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ImageError("invalid_image", "That image could not be decoded.", 400)
    height, width = image.shape[:2]
    if max(height, width) > max_dimension:
        raise ImageError(
            "invalid_image",
            f"Screenshots are up to {max_dimension} pixels on the longest side.",
            400,
        )
    if min(height, width) < min_dimension:
        raise ImageError(
            "invalid_image",
            f"Screenshots must be at least {min_dimension} pixels wide and tall.",
            400,
        )
    return image


def crop(image: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = box
    height, width = image.shape[:2]
    return image[
        max(0, y0) : min(height, max(0, y1)),
        max(0, x0) : min(width, max(0, x1)),
    ]
