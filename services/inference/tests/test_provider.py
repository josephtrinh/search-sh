import base64
import hashlib
import io
import sys
import tarfile
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.provider import (
    DeterministicEmbeddingProvider,
    Dinov2Provider,
    Dinov3Provider,
    FlorenceProvider,
    decode_image,
    ensure_dinov3_model,
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


def test_dinov2_uses_pooler_output_and_l2_normalizes(monkeypatch):
    calls = {}

    class Tensor:
        def __init__(self, values):
            self.values = values

        def to(self, _device):
            return self

        def cpu(self):
            return self

        def float(self):
            return self

        def numpy(self):
            return np.asarray(self.values)

    class Model:
        config = SimpleNamespace(_commit_hash="resolved-dino", hidden_size=2)

        def to(self, device):
            calls["device"] = device
            return self

        def eval(self):
            return self

        def __call__(self, **_kwargs):
            return SimpleNamespace(pooler_output=Tensor([[3.0, 4.0]]))

    class Inputs(dict):
        def to(self, _device):
            return self

    class Processor:
        def __call__(self, **kwargs):
            calls["processor"] = kwargs
            return Inputs()

    class AutoModel:
        @classmethod
        def from_pretrained(cls, *_args, **kwargs):
            calls["model_load"] = kwargs
            return Model()

    class AutoImageProcessor:
        @classmethod
        def from_pretrained(cls, *_args, **kwargs):
            calls["processor_load"] = kwargs
            return Processor()

    def normalize(tensor, p, dim):
        calls["normalize"] = (tensor.values, p, dim)
        return Tensor([[0.6, 0.8]])

    fake_torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        inference_mode=nullcontext,
        nn=SimpleNamespace(functional=SimpleNamespace(normalize=normalize)),
    )
    fake_transformers = SimpleNamespace(AutoImageProcessor=AutoImageProcessor, AutoModel=AutoModel)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    settings = Settings(
        inference_backend="cpu",
        dinov2_dimensions=2,
        dinov2_model_revision="pinned-dino",
    )
    provider = Dinov2Provider(settings)
    result = provider.embed_images([Image.new("RGB", (8, 6))])

    assert result == [[0.6, 0.8]]
    assert calls["normalize"] == ([[3.0, 4.0]], 2, 1)
    assert calls["model_load"] == {
        "revision": "pinned-dino",
        "use_safetensors": True,
    }
    assert calls["processor_load"] == {"revision": "pinned-dino"}
    assert calls["processor"]["images"][0].size == (8, 6)
    assert provider.resolved_revision == "resolved-dino"


def test_dinov3_uses_local_pooler_output_configured_size_and_l2(monkeypatch, tmp_path):
    calls = {}

    class Tensor:
        def __init__(self, values):
            self.values = values

        def to(self, _device):
            return self

        def cpu(self):
            return self

        def float(self):
            return self

        def numpy(self):
            return np.asarray(self.values)

    class Model:
        config = SimpleNamespace(hidden_size=2)

        def to(self, device):
            calls["device"] = device
            return self

        def eval(self):
            return self

        def __call__(self, **_kwargs):
            return SimpleNamespace(pooler_output=Tensor([[5.0, 12.0]]))

    class Inputs(dict):
        def to(self, _device):
            return self

    class Processor:
        def __call__(self, **kwargs):
            calls["processor"] = kwargs
            return Inputs()

    class AutoModel:
        @classmethod
        def from_pretrained(cls, model_path, **kwargs):
            calls["model_path"] = model_path
            calls["model_load"] = kwargs
            return Model()

    class AutoImageProcessor:
        @classmethod
        def from_pretrained(cls, model_path, **kwargs):
            calls["processor_path"] = model_path
            calls["processor_load"] = kwargs
            return Processor()

    def normalize(tensor, p, dim):
        calls["normalize"] = (tensor.values, p, dim)
        return Tensor([[5 / 13, 12 / 13]])

    fake_torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        inference_mode=nullcontext,
        nn=SimpleNamespace(functional=SimpleNamespace(normalize=normalize)),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(AutoImageProcessor=AutoImageProcessor, AutoModel=AutoModel),
    )
    monkeypatch.setattr("app.provider.ensure_dinov3_model", lambda _settings: tmp_path)

    settings = Settings(
        inference_backend="cpu",
        dinov3_dimensions=2,
        dinov3_image_size=320,
        dinov3_archive_sha256="abc123",
    )
    provider = Dinov3Provider(settings)
    result = provider.embed_images([Image.new("RGB", (8, 6))])

    assert result == [[5 / 13, 12 / 13]]
    assert calls["model_path"] == tmp_path
    assert calls["model_load"] == {"local_files_only": True, "use_safetensors": True}
    assert calls["processor_load"] == {"local_files_only": True}
    assert calls["processor"]["size"] == {"height": 320, "width": 320}
    assert calls["normalize"] == ([[5.0, 12.0]], 2, 1)
    assert provider.resolved_revision == "abc123"


def _make_dinov3_archive(tmp_path: Path, unsafe_name: str | None = None) -> tuple[Path, str]:
    source = tmp_path / "source"
    model = source / "dinov3-vith16plus-pretrain-lvd1689m"
    model.mkdir(parents=True)
    for name in ("config.json", "preprocessor_config.json", "model.safetensors"):
        (model / name).write_bytes(name.encode())
    archive_path = tmp_path / "model.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(model, arcname=model.name)
        if unsafe_name:
            entry = tarfile.TarInfo(unsafe_name)
            payload = b"unsafe"
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    return archive_path, digest


def test_dinov3_archive_extracts_once_and_reuses_marker(tmp_path):
    archive_path, digest = _make_dinov3_archive(tmp_path)
    target = tmp_path / "extracted"
    settings = Settings(
        dinov3_model_archive=str(archive_path),
        dinov3_model_dir=str(target),
        dinov3_archive_sha256=digest,
    )

    assert ensure_dinov3_model(settings) == target
    assert (target / "model.safetensors").is_file()
    archive_path.unlink()
    assert ensure_dinov3_model(settings) == target


def test_dinov3_archive_rejects_checksum_mismatch(tmp_path):
    archive_path, _ = _make_dinov3_archive(tmp_path)
    settings = Settings(
        dinov3_model_archive=str(archive_path),
        dinov3_model_dir=str(tmp_path / "extracted"),
        dinov3_archive_sha256="0" * 64,
    )
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        ensure_dinov3_model(settings)


def test_dinov3_archive_reports_missing_file(tmp_path):
    settings = Settings(
        dinov3_model_archive=str(tmp_path / "missing.tar.gz"),
        dinov3_model_dir=str(tmp_path / "extracted"),
        dinov3_archive_sha256="0" * 64,
    )
    with pytest.raises(RuntimeError, match="archive was not found"):
        ensure_dinov3_model(settings)


def test_dinov3_existing_directory_must_be_complete(tmp_path):
    archive_path, digest = _make_dinov3_archive(tmp_path)
    target = tmp_path / "extracted"
    target.mkdir()
    (target / "config.json").write_text("{}", encoding="utf-8")
    settings = Settings(
        dinov3_model_archive=str(archive_path),
        dinov3_model_dir=str(target),
        dinov3_archive_sha256=digest,
    )
    with pytest.raises(RuntimeError, match="directory is incomplete"):
        ensure_dinov3_model(settings)


def test_dinov3_archive_rejects_path_traversal(tmp_path):
    archive_path, digest = _make_dinov3_archive(tmp_path, "../outside")
    settings = Settings(
        dinov3_model_archive=str(archive_path),
        dinov3_model_dir=str(tmp_path / "extracted"),
        dinov3_archive_sha256=digest,
    )
    with pytest.raises(RuntimeError, match="unsafe path"):
        ensure_dinov3_model(settings)


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
    fake_transformers = SimpleNamespace(AutoModelForCausalLM=AutoModel, AutoProcessor=AutoProcessor)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    provider = FlorenceProvider(Settings(inference_backend="cpu"))
    assert provider.caption_images([Image.new("RGB", (8, 6))]) == ["Caption for 8x6"]
    assert calls["load"]["attn_implementation"] == "eager"
    assert calls["generate"]["use_cache"] is False
