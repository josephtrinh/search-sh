from __future__ import annotations

import base64
import hashlib
import io
from abc import ABC, abstractmethod
from typing import Any

import numpy as np
from PIL import Image

from app.config import Settings


def normalize_rows(values: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(norms, np.finfo(values.dtype).eps)


def text_context_length(model: Any) -> int:
    text_config = getattr(getattr(model, "config", None), "text_config", None)
    value = getattr(text_config, "max_position_embeddings", 64)
    return value if isinstance(value, int) and value > 0 else 64


def decode_image(encoded: str, settings: Settings) -> Image.Image:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ValueError("image is not valid base64") from exc
    if len(raw) > settings.max_upload_bytes:
        raise ValueError(f"image exceeds {settings.max_upload_bytes} bytes")
    try:
        image = Image.open(io.BytesIO(raw))
        width, height = image.size
        if width * height > settings.max_image_pixels:
            raise ValueError(f"decoded image exceeds {settings.max_image_pixels} pixels")
        if image.format not in {"JPEG", "PNG", "WEBP"}:
            raise ValueError("image must be JPEG, PNG, or WebP")
        image.load()
        return image.convert("RGB")
    except Image.DecompressionBombError as exc:
        raise ValueError("decoded image is too large") from exc
    except (OSError, SyntaxError) as exc:
        raise ValueError("image cannot be decoded") from exc


class EmbeddingProvider(ABC):
    model_id: str
    configured_revision: str
    resolved_revision: str | None = None
    dimensions: int
    device: str
    loaded: bool = False

    @abstractmethod
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...

    @abstractmethod
    def embed_images(self, images: list[Image.Image]) -> list[list[float]]: ...


class DeterministicProvider(EmbeddingProvider):
    """Cheap normalized embeddings for tests and UI development."""

    def __init__(self, settings: Settings):
        self.model_id = "deterministic-test-provider"
        self.configured_revision = "1"
        self.resolved_revision = "1"
        self.dimensions = settings.embedding_dimensions
        self.device = "cpu"
        self.loaded = True

    def _vector(self, payload: bytes) -> list[float]:
        seed = int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")
        vector = (
            np.random.default_rng(seed)
            .standard_normal((1, self.dimensions))
            .astype(np.float32)
        )
        return normalize_rows(vector)[0].tolist()

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(text.encode("utf-8")) for text in texts]

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        return [self._vector(image.tobytes()) for image in images]


class SiglipProvider(EmbeddingProvider):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.embedding_model_id
        self.configured_revision = settings.embedding_model_revision
        self.dimensions = settings.embedding_dimensions
        self.device = "unloaded"
        self._torch: Any = None
        self._model: Any = None
        self._processor: Any = None

    def _load(self) -> None:
        if self.loaded:
            return
        import torch
        from transformers import AutoModel, AutoProcessor

        if self.settings.inference_backend == "cpu":
            device = "cpu"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
        self._torch = torch
        self._processor = AutoProcessor.from_pretrained(
            self.model_id, revision=self.configured_revision
        )
        self._model = AutoModel.from_pretrained(
            self.model_id, revision=self.configured_revision
        ).to(device).eval()
        self.device = device
        self.resolved_revision = getattr(self._model.config, "_commit_hash", None)
        projection_dim = getattr(self._model.config, "projection_dim", None)
        if projection_dim is not None and projection_dim != self.dimensions:
            raise RuntimeError(
                f"configured dimensions {self.dimensions} do not match model {projection_dim}"
            )
        self.loaded = True

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self._load()
        inputs = self._processor(
            text=texts,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=text_context_length(self._model),
        ).to(self.device)
        with self._torch.inference_mode():
            embeddings = self._model.get_text_features(**inputs)
            embeddings = embeddings / embeddings.norm(dim=-1, keepdim=True)
        return embeddings.cpu().float().numpy().tolist()

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        self._load()
        inputs = self._processor(images=images, return_tensors="pt").to(self.device)
        with self._torch.inference_mode():
            embeddings = self._model.get_image_features(**inputs)
            embeddings = embeddings / embeddings.norm(dim=-1, keepdim=True)
        return embeddings.cpu().float().numpy().tolist()


def create_provider(settings: Settings) -> EmbeddingProvider:
    if settings.inference_backend == "deterministic":
        return DeterministicProvider(settings)
    return SiglipProvider(settings)
