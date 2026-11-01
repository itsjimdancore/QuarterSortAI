"""Server-side OCR fallback for QuarterSort AI.

The browser runs tesseract.js first and only calls this endpoint when its
result is weak. Served by Vercel's Python runtime as the function for
/api/ocr, or locally with: uvicorn api.ocr:app --reload --port 8000
"""

from __future__ import annotations

import io
import logging
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from rapidocr import RapidOCR

logger = logging.getLogger("quartersort.ocr")

# Vercel's request body limit is ~4.5 MB; keep a margin for multipart overhead.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024
# Server-side safety net; the client already downscales to 2000 px.
MAX_SIDE_PX = 4000
# Reject decompression bombs (tiny file, enormous pixel count).
Image.MAX_IMAGE_PIXELS = 40_000_000

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"}
ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/bmp",
    "image/x-ms-bmp",
    "image/tiff",
    "image/webp",
}
# Formats as reported by Pillow after actually decoding the bytes.
ALLOWED_PIL_FORMATS = {"PNG", "JPEG", "BMP", "TIFF", "WEBP", "MPO"}

# Loaded once per process so warm invocations skip model initialisation.
# RapidOCR's default detector forces the *short* side up to >= 736 px, which
# makes wide strips and A4 pages very slow on CPU. Capping the long side at
# 1280 px roughly halved latency in local tests with the same recognition.
ENGINE = RapidOCR(params={"Det.limit_type": "max", "Det.limit_side_len": 1280})

app = FastAPI(title="QuarterSort OCR fallback", docs_url=None, redoc_url=None, openapi_url=None)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _extension(filename: Optional[str]) -> str:
    if not filename or "." not in filename:
        return ""
    return filename.rsplit(".", 1)[-1].lower()


def _too_large() -> JSONResponse:
    return _error(413, f"File too large. Maximum upload size is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")


# GET /api/ocr is an alias: on Vercel, /api/ocr/health is rewritten to this
# function and the app may see either path.
@app.get("/api/ocr/health")
@app.get("/api/ocr")
def health() -> dict:
    return {"ok": True}


@app.post("/api/ocr")
async def ocr(request: Request, file: UploadFile = File(...)) -> JSONResponse:
    started = time.perf_counter()

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES + 64 * 1024:
        return _too_large()

    ext = _extension(file.filename)
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if ext not in ALLOWED_EXTENSIONS and content_type not in ALLOWED_CONTENT_TYPES:
        return _error(400, "Unsupported file type. Upload a PNG, JPEG, BMP, TIFF or WebP image.")

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        return _too_large()
    if not data:
        return _error(400, "Empty upload.")

    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format not in ALLOWED_PIL_FORMATS:
                return _error(400, "Unsupported image format.")
            img.seek(0)  # first frame only for multi-page TIFF
            rgb = img.convert("RGB")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        return _error(400, "Could not decode the uploaded image.")

    try:
        if max(rgb.size) > MAX_SIDE_PX:
            rgb.thumbnail((MAX_SIDE_PX, MAX_SIDE_PX))
        result = ENGINE(np.asarray(rgb))
        texts = list(result.txts or ())
        scores = [float(s) for s in (result.scores or ())]
    except Exception:  # noqa: BLE001 - never leak internals or file contents
        logger.exception("OCR failed")
        return _error(500, "OCR processing failed.")

    confidence = round(sum(scores) / len(scores) * 100, 1) if scores else 0.0
    return JSONResponse(
        {
            "text": "\n".join(texts).strip(),
            "confidence": confidence,
            "engine": "rapidocr",
            "ms": round((time.perf_counter() - started) * 1000),
        }
    )
