import base64
import io
import sys
from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.provider import (
    DeterministicEmbeddingProvider,
    FlorenceProvider,
    decode_image,
    resolve_device,
    text_context_length,
)


def image_payload(size=(12, 12), image_format="PNG") -> str:
    image = Image.new("RGB", size, (20, 80, 140))
    buffer = io.BytesIO()
    image.save(buffer, format=image_format)
    return base64.b64encode(buffer.getvalue()).decode()


def test_embeddings_are_deterministic_and_normalized():
    provider = DeterministicEmbeddingProvider(Settings(), "test", 32)
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


def test_deterministic_e5_input_types_are_distinct():
    provider = DeterministicEmbeddingProvider(Settings(), "e5", 32)
    assert provider.embed_texts(["tile"], "query") != provider.embed_texts(["tile"], "passage")


def test_resolve_device_rejects_unknown_backend():
    torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False))
    )
    with pytest.raises(RuntimeError, match="unsupported"):
        resolve_device(torch, "cuda", "auto")


def test_florence_uses_eager_attention_and_disables_generation_cache(monkeypatch):
    calls = {}

    class Tensor:
        def to(self, _device):
            return self

    class Model:
        config = SimpleNamespace(_commit_hash="resolved")

        def to(self, _device):
            return self

        def eval(self):
            return self

        def generate(self, **kwargs):
            calls["generate"] = kwargs
            return ["tokens"]

    class Processor:
        def __call__(self, **_kwargs):
            return {"input_ids": Tensor()}

        def batch_decode(self, _generated, skip_special_tokens=False):
            assert skip_special_tokens is False
            return ["raw"]

        def post_process_generation(self, _text, task, image_size):
            return {task: f"Caption for {image_size[0]}x{image_size[1]}"}

    class AutoModel:
        @classmethod
        def from_pretrained(cls, *_args, **kwargs):
            calls["load"] = kwargs
            return Model()

    class AutoProcessor:
        @classmethod
        def from_pretrained(cls, *_args, **_kwargs):
            return Processor()

    fake_torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        inference_mode=nullcontext,
    )
    fake_transformers = SimpleNamespace(
        AutoModelForCausalLM=AutoModel, AutoProcessor=AutoProcessor
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    provider = FlorenceProvider(Settings(inference_backend="cpu"))
    assert provider.caption_images([Image.new("RGB", (8, 6))]) == ["Caption for 8x6"]
    assert calls["load"]["attn_implementation"] == "eager"
    assert calls["generate"]["use_cache"] is False
