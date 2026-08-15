import base64
import io
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.provider import DeterministicProvider, decode_image, text_context_length


def image_payload(size=(12, 12), image_format="PNG") -> str:
    image = Image.new("RGB", size, (20, 80, 140))
    buffer = io.BytesIO()
    image.save(buffer, format=image_format)
    return base64.b64encode(buffer.getvalue()).decode()


def test_embeddings_are_deterministic_and_normalized():
    provider = DeterministicProvider(Settings(embedding_dimensions=32))
    first, second = provider.embed_texts(["tile", "tile"])
    assert first == second
    assert len(first) == 32
    assert np.linalg.norm(first) == pytest.approx(1.0)


def test_image_validation_accepts_png():
    image = decode_image(image_payload(), Settings())
    assert image.size == (12, 12)


def test_image_validation_rejects_bad_base64():
    with pytest.raises(ValueError, match="base64"):
        decode_image("not-base64", Settings())


def test_text_context_length_uses_model_limit():
    model = SimpleNamespace(
        config=SimpleNamespace(text_config=SimpleNamespace(max_position_embeddings=64))
    )
    assert text_context_length(model) == 64


def test_text_context_length_has_safe_fallback():
    assert text_context_length(SimpleNamespace()) == 64
