import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

from api.ocr import MAX_UPLOAD_BYTES, app

client = TestClient(app)


def _text_image(text: str) -> bytes:
    img = Image.new("RGB", (1100, 220), "white")
    draw = ImageDraw.Draw(img)
    draw.text((30, 70), text, fill="black", font=ImageFont.load_default(size=56))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_health():
    res = client.get("/api/ocr/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_recognizes_known_text():
    png = _text_image("INVOICE Q3 2025 TOTAL 4500")
    res = client.post("/api/ocr", files={"file": ("invoice.png", png, "image/png")})
    assert res.status_code == 200
    body = res.json()
    assert body["engine"] == "rapidocr"
    assert 0 <= body["confidence"] <= 100
    assert isinstance(body["ms"], int)
    text = body["text"].upper()
    for word in ("INVOICE", "Q3", "2025", "TOTAL", "4500"):
        assert word in text, f"{word!r} not found in {body['text']!r}"


def test_blank_image_returns_empty_text():
    buf = io.BytesIO()
    Image.new("RGB", (200, 200), "white").save(buf, format="PNG")
    res = client.post("/api/ocr", files={"file": ("blank.png", buf.getvalue(), "image/png")})
    assert res.status_code == 200
    assert res.json()["text"] == ""
    assert res.json()["confidence"] == 0


def test_rejects_oversized_upload():
    big = b"\x00" * (MAX_UPLOAD_BYTES + 1024)
    res = client.post("/api/ocr", files={"file": ("big.png", big, "image/png")})
    assert res.status_code == 413
    assert "too large" in res.json()["error"].lower()


def test_rejects_text_file():
    res = client.post("/api/ocr", files={"file": ("notes.txt", b"secret notes", "text/plain")})
    assert res.status_code == 400
    assert "secret" not in res.text


@pytest.mark.parametrize("name", ["fake.png", "fake.jpg"])
def test_rejects_non_image_bytes_with_image_name(name):
    res = client.post("/api/ocr", files={"file": (name, b"not really an image", "image/png")})
    assert res.status_code == 400
    assert "not really" not in res.text
