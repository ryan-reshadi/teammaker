"""PaddleOCR behind a small, replaceable text-recognition seam.

The pipeline never imports PaddleOCR directly: it asks a `TextReader` for lines.
Tests inject a fixture reader, so layout and parsing are verified without the
heavy engine and the engine can be swapped without touching the geometry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np


class EngineUnavailable(Exception):
    """The OCR engine is missing, failed to start, or failed on an image."""


@dataclass
class TextLine:
    text: str
    confidence: float
    #: x0, y0, x1, y1 in crop coordinates.
    box: tuple[float, float, float, float]


class TextReader(Protocol):
    name: str

    def read(
        self,
        image: np.ndarray,
        region: str = "row",
        box: tuple[int, int, int, int] | None = None,
    ) -> list[TextLine]:
        """Recognises the text in a crop; `region` names the crop and `box` is
        where it sits in the screenshot. Neither changes recognition: the engine
        only sees pixels. They let a test reader place its fixture text."""
        ...


def _bbox(poly) -> tuple[float, float, float, float]:
    points = np.asarray(poly, dtype=float).reshape(-1, 2)
    if points.size == 0:
        return (0.0, 0.0, 0.0, 0.0)
    xs = points[:, 0]
    ys = points[:, 1]
    return (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


def _from_predict(result) -> list[TextLine]:
    """PaddleOCR 3.x: a list of result objects carrying rec_* arrays."""
    lines: list[TextLine] = []
    for item in result or []:
        data = item
        if hasattr(item, "json"):
            data = item.json
            if callable(data):
                data = data()
        if isinstance(data, dict) and isinstance(data.get("res"), dict):
            data = data["res"]
        if not isinstance(data, dict):
            continue
        texts = data.get("rec_texts") or []
        scores = data.get("rec_scores") or []
        polys = data.get("rec_polys")
        if polys is None:
            polys = data.get("dt_polys") or []
        for index, text in enumerate(texts):
            if not str(text).strip():
                continue
            score = _clamp(scores[index]) if index < len(scores) else 0.0
            box = _bbox(polys[index]) if index < len(polys) else (0.0, 0.0, 0.0, 0.0)
            lines.append(TextLine(str(text), score, box))
    return lines


def _from_ocr(result) -> list[TextLine]:
    """PaddleOCR 2.x: [[ [poly, (text, score)], ... ]] per page."""
    lines: list[TextLine] = []
    for page in result or []:
        for entry in page or []:
            try:
                poly, (text, score) = entry[0], entry[1]
            except (TypeError, IndexError):
                continue
            if not str(text).strip():
                continue
            lines.append(TextLine(str(text), _clamp(score), _bbox(poly)))
    return lines


class PaddleTextReader:
    name = "paddleocr"

    def __init__(self, lang: str = "en"):
        self.lang = lang
        self._engine = None

    def _load(self):
        if self._engine is not None:
            return self._engine
        try:
            from paddleocr import PaddleOCR
        except Exception as error:  # pragma: no cover - depends on the host
            raise EngineUnavailable(
                "PaddleOCR is not installed. Install ocr/requirements.txt in the service environment."
            ) from error
        try:
            self._engine = PaddleOCR(
                lang=self.lang,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                # Paddle 3.x on Windows throws
                # "ConvertPirAttribute2RuntimeAttribute not support" from the
                # oneDNN path, so the CPU backend runs without MKLDNN.
                enable_mkldnn=False,
            )
        except TypeError:
            # PaddleOCR 2.x has different keyword names.
            try:
                self._engine = PaddleOCR(
                    lang=self.lang, use_angle_cls=False, show_log=False
                )
            except Exception as error:  # pragma: no cover - depends on the host
                raise EngineUnavailable("The OCR engine could not start.") from error
        except Exception as error:  # pragma: no cover - depends on the host
            raise EngineUnavailable("The OCR engine could not start.") from error
        return self._engine

    def read(
        self,
        image: np.ndarray,
        region: str = "row",
        box: tuple[int, int, int, int] | None = None,
    ) -> list[TextLine]:
        # `region` and `box` describe the crop for test readers; Paddle sees only
        # the pixels and does not need either.
        engine = self._load()
        if image.size == 0:
            return []
        try:
            if hasattr(engine, "predict"):
                return _from_predict(engine.predict(image))
            return _from_ocr(engine.ocr(image, cls=False))
        except EngineUnavailable:
            raise
        except Exception as error:  # pragma: no cover - depends on the host
            raise EngineUnavailable("The OCR engine failed on this image.") from error

    def warmup(self) -> None:
        """Loads the engine and models once, so the first upload is not the wait."""
        canvas = np.zeros((64, 256, 3), dtype=np.uint8)
        self.read(canvas, "warmup")
