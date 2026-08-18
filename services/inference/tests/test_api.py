import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.main import app


def make_image() -> str:
    image = Image.new("RGB", (8, 8), (255, 0, 0))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def test_text_and_image_endpoints(monkeypatch):
    with TestClient(app) as client:
        text = client.post(
            "/v1/embed/text",
            json={"texts": ["grey stone"], "inputType": "query", "priority": 0},
        )
        visual_text = client.post(
            "/v1/embed/visual-text", json={"texts": ["grey stone"], "priority": 0}
        )
        image = client.post("/v1/embed/images", json={"images": [make_image()], "priority": 0})
        dinov2 = client.post(
            "/v1/embed/images",
            json={"images": [make_image()], "model": "dinov2", "priority": 0},
        )
        dinov3 = client.post(
            "/v1/embed/images",
            json={"images": [make_image()], "model": "dinov3", "priority": 0},
        )
        catalog = client.post(
            "/v1/embed/catalog-images",
            json={
                "images": [make_image()],
                "model": "dinov2",
                "generation": "current",
                "priority": 0,
            },
        )
        caption = client.post("/v1/caption/images", json={"images": [make_image()], "priority": 10})

        def fail(_images, _generation):
            raise RuntimeError("DINOv3 archive was not found")

        monkeypatch.setattr(main.dinov3, "embed_images", fail)
        model_error = client.post(
            "/v1/embed/images",
            json={"images": [make_image()], "model": "dinov3", "priority": 0},
        )
    assert text.status_code == 200
    assert visual_text.status_code == 200
    assert image.status_code == 200
    assert dinov2.status_code == 200
    assert dinov3.status_code == 200
    assert catalog.status_code == 200
    assert caption.status_code == 200
    assert len(text.json()["embeddings"][0]) == 32
    assert len(visual_text.json()["embeddings"][0]) == 32
    assert len(image.json()["embeddings"][0]) == 32
    assert len(dinov2.json()["embeddings"][0]) == 32
    assert len(dinov3.json()["embeddings"][0]) == 32
    assert len(catalog.json()["embedding_sets"][0][0]) == 32
    assert dinov2.json()["model_id"] == "deterministic-dinov2-provider"
    assert dinov3.json()["model_id"] == "deterministic-dinov3-provider"
    assert caption.json()["captions"] == ["Test image with dimensions 8 by 8."]
    assert model_error.status_code == 503
    assert model_error.json()["detail"] == "DINOv3 archive was not found"
