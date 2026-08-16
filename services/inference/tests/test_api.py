import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def make_image() -> str:
    image = Image.new("RGB", (8, 8), (255, 0, 0))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def test_text_and_image_endpoints():
    with TestClient(app) as client:
        text = client.post(
            "/v1/embed/text",
            json={"texts": ["grey stone"], "inputType": "query", "priority": 0},
        )
        visual_text = client.post(
            "/v1/embed/visual-text", json={"texts": ["grey stone"], "priority": 0}
        )
        image = client.post("/v1/embed/images", json={"images": [make_image()], "priority": 0})
        caption = client.post(
            "/v1/caption/images", json={"images": [make_image()], "priority": 10}
        )
    assert text.status_code == 200
    assert visual_text.status_code == 200
    assert image.status_code == 200
    assert caption.status_code == 200
    assert len(text.json()["embeddings"][0]) == 32
    assert len(visual_text.json()["embeddings"][0]) == 32
    assert len(image.json()["embeddings"][0]) == 32
    assert caption.json()["captions"] == ["Test image with dimensions 8 by 8."]
