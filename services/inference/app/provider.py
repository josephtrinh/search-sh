from __future__ import annotations

import base64
import hashlib
import io
import os
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
from PIL import Image

from app.config import ROOT_ENV, Settings

DINOV3_ARCHIVE_ROOT = "dinov3-vith16plus-pretrain-lvd1689m"
DINOV3_REQUIRED_FILES = ("config.json", "preprocessor_config.json", "model.safetensors")


def resolve_workspace_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT_ENV.parent / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_dinov3_directory(path: Path) -> None:
    missing = [name for name in DINOV3_REQUIRED_FILES if not (path / name).is_file()]
    if missing:
        raise RuntimeError(f"DINOv3 model directory is incomplete: missing {', '.join(missing)}")


def _safe_archive_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    for member in members:
        name = PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts:
            raise RuntimeError(f"DINOv3 archive contains an unsafe path: {member.name}")
        if not name.parts or name.parts[0] != DINOV3_ARCHIVE_ROOT:
            raise RuntimeError(f"DINOv3 archive has an unexpected root: {member.name}")
        if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
            raise RuntimeError(f"DINOv3 archive contains an unsupported entry: {member.name}")
    return members


def ensure_dinov3_model(settings: Settings) -> Path:
    archive_path = resolve_workspace_path(settings.dinov3_model_archive)
    model_path = resolve_workspace_path(settings.dinov3_model_dir)
    marker = model_path / ".samplehub-archive-sha256"
    expected_sha256 = settings.dinov3_archive_sha256.lower()

    if model_path.is_dir() and marker.is_file():
        _validate_dinov3_directory(model_path)
        if marker.read_text(encoding="utf-8").strip().lower() != expected_sha256:
            raise RuntimeError("DINOv3 extracted model fingerprint does not match configuration")
        return model_path

    if not archive_path.is_file():
        raise RuntimeError(f"DINOv3 archive was not found at {archive_path}")
    actual_sha256 = sha256_file(archive_path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"DINOv3 archive checksum mismatch: expected {expected_sha256}, got {actual_sha256}"
        )

    if model_path.exists():
        _validate_dinov3_directory(model_path)
        marker.write_text(f"{expected_sha256}\n", encoding="utf-8")
        return model_path

    model_path.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".dinov3-extract-", dir=model_path.parent))
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = _safe_archive_members(archive)
            archive.extractall(staging, members=members, filter="data")
        extracted = staging / DINOV3_ARCHIVE_ROOT
        _validate_dinov3_directory(extracted)
        try:
            os.replace(extracted, model_path)
        except OSError:
            if not model_path.is_dir():
                raise
            _validate_dinov3_directory(model_path)
        marker.write_text(f"{expected_sha256}\n", encoding="utf-8")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return model_path


def normalize_rows(values: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(norms, np.finfo(values.dtype).eps)


def text_context_length(model: Any) -> int:
    text_config = getattr(getattr(model, "config", None), "text_config", None)
    value = getattr(text_config, "max_position_embeddings", 64)
    return value if isinstance(value, int) and value > 0 else 64


def resolve_device(torch: Any, backend: str | None, fallback: str) -> str:
    selected = (backend or fallback).strip().lower()
    if selected == "deterministic":
        return "cpu"
    if selected == "cpu":
        return "cpu"
    if selected not in {"auto", "mps"}:
        raise RuntimeError(f"unsupported inference backend: {selected}")
    if torch.backends.mps.is_available():
        return "mps"
    if selected == "mps":
        raise RuntimeError("MPS was requested but is not available")
    return "cpu"


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


class ProviderMetadata:
    model_id: str
    configured_revision: str
    resolved_revision: str | None = None
    dimensions: int | None = None
    device: str = "unloaded"
    loaded: bool = False


class DeterministicEmbeddingProvider(ProviderMetadata):
    """Cheap normalized embeddings for tests and UI development."""

    def __init__(self, settings: Settings, namespace: str, dimensions: int):
        self.model_id = f"deterministic-{namespace}-provider"
        self.configured_revision = "1"
        self.resolved_revision = "1"
        self.dimensions = dimensions
        self.device = "cpu"
        self.loaded = True

    def _vector(self, payload: bytes) -> list[float]:
        seed = int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")
        vector = (
            np.random.default_rng(seed).standard_normal((1, self.dimensions)).astype(np.float32)
        )
        return normalize_rows(vector)[0].tolist()

    def embed_texts(self, texts: list[str], input_type: str | None = None) -> list[list[float]]:
        prefix = f"{input_type}:" if input_type else ""
        return [self._vector(f"{prefix}{text}".encode()) for text in texts]

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        return [self._vector(image.tobytes()) for image in images]


class DeterministicCaptionProvider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.model_id = "deterministic-caption-provider"
        self.configured_revision = "1"
        self.resolved_revision = "1"
        self.device = "cpu"
        self.loaded = True
        self.task = settings.caption_task

    def caption_images(self, images: list[Image.Image]) -> list[str]:
        return [f"Test image with dimensions {image.width} by {image.height}." for image in images]


class SiglipProvider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.embedding_model_id
        self.configured_revision = settings.embedding_model_revision
        self.dimensions = settings.embedding_dimensions
        self._torch: Any = None
        self._model: Any = None
        self._processor: Any = None

    def _load(self) -> None:
        if self.loaded:
            return
        import torch
        from transformers import AutoModel, AutoProcessor

        device = resolve_device(
            torch, self.settings.siglip_backend, self.settings.inference_backend
        )
        self._torch = torch
        self._processor = AutoProcessor.from_pretrained(
            self.model_id, revision=self.configured_revision
        )
        self._model = (
            AutoModel.from_pretrained(
                self.model_id, revision=self.configured_revision, use_safetensors=True
            )
            .to(device)
            .eval()
        )
        self.device = device
        self.resolved_revision = getattr(self._model.config, "_commit_hash", None)
        projection_dim = getattr(self._model.config, "projection_dim", None)
        if projection_dim is not None and projection_dim != self.dimensions:
            raise RuntimeError(
                f"configured dimensions {self.dimensions} do not match model {projection_dim}"
            )
        self.loaded = True

    def embed_texts(self, texts: list[str], input_type: str | None = None) -> list[list[float]]:
        del input_type
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


class Dinov2Provider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.dinov2_model_id
        self.configured_revision = settings.dinov2_model_revision
        self.dimensions = settings.dinov2_dimensions
        self._torch: Any = None
        self._model: Any = None
        self._processor: Any = None

    def _load(self) -> None:
        if self.loaded:
            return
        import torch
        from transformers import AutoImageProcessor, AutoModel

        device = resolve_device(
            torch, self.settings.dinov2_backend, self.settings.inference_backend
        )
        self._torch = torch
        self._processor = AutoImageProcessor.from_pretrained(
            self.model_id, revision=self.configured_revision
        )
        self._model = (
            AutoModel.from_pretrained(
                self.model_id, revision=self.configured_revision, use_safetensors=True
            )
            .to(device)
            .eval()
        )
        self.device = device
        self.resolved_revision = getattr(self._model.config, "_commit_hash", None)
        hidden_size = getattr(self._model.config, "hidden_size", None)
        if hidden_size is not None and hidden_size != self.dimensions:
            raise RuntimeError(
                f"configured dimensions {self.dimensions} do not match model {hidden_size}"
            )
        self.loaded = True

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        self._load()
        inputs = self._processor(images=images, return_tensors="pt").to(self.device)
        with self._torch.inference_mode():
            outputs = self._model(**inputs)
            embeddings = self._torch.nn.functional.normalize(outputs.pooler_output, p=2, dim=1)
        return embeddings.cpu().float().numpy().tolist()


class Dinov3Provider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.dinov3_model_id
        self.configured_revision = settings.dinov3_archive_sha256
        self.dimensions = settings.dinov3_dimensions
        self._torch: Any = None
        self._model: Any = None
        self._processor: Any = None

    def _load(self) -> None:
        if self.loaded:
            return
        import torch
        from transformers import AutoImageProcessor, AutoModel

        model_path = ensure_dinov3_model(self.settings)
        device = resolve_device(
            torch, self.settings.dinov3_backend, self.settings.inference_backend
        )
        self._torch = torch
        self._processor = AutoImageProcessor.from_pretrained(model_path, local_files_only=True)
        self._model = (
            AutoModel.from_pretrained(model_path, local_files_only=True, use_safetensors=True)
            .to(device)
            .eval()
        )
        self.device = device
        self.resolved_revision = self.settings.dinov3_archive_sha256
        hidden_size = getattr(self._model.config, "hidden_size", None)
        if hidden_size is not None and hidden_size != self.dimensions:
            raise RuntimeError(
                f"configured dimensions {self.dimensions} do not match model {hidden_size}"
            )
        self.loaded = True

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        self._load()
        size = {
            "height": self.settings.dinov3_image_size,
            "width": self.settings.dinov3_image_size,
        }
        inputs = self._processor(images=images, size=size, return_tensors="pt").to(self.device)
        with self._torch.inference_mode():
            outputs = self._model(**inputs)
            embeddings = self._torch.nn.functional.normalize(outputs.pooler_output, p=2, dim=1)
        return embeddings.cpu().float().numpy().tolist()


class E5Provider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.text_embedding_model_id
        self.configured_revision = settings.text_embedding_model_revision
        self.dimensions = settings.text_embedding_dimensions
        self._torch: Any = None
        self._model: Any = None
        self._tokenizer: Any = None

    def _load(self) -> None:
        if self.loaded:
            return
        import torch
        from transformers import AutoModel, AutoTokenizer

        device = resolve_device(
            torch, self.settings.text_embedding_backend, self.settings.inference_backend
        )
        self._torch = torch
        self._tokenizer = AutoTokenizer.from_pretrained(
            self.model_id, revision=self.configured_revision
        )
        self._model = (
            AutoModel.from_pretrained(
                self.model_id, revision=self.configured_revision, use_safetensors=True
            )
            .to(device)
            .eval()
        )
        self.device = device
        self.resolved_revision = getattr(self._model.config, "_commit_hash", None)
        hidden_size = getattr(self._model.config, "hidden_size", None)
        if hidden_size is not None and hidden_size != self.dimensions:
            raise RuntimeError(
                f"configured dimensions {self.dimensions} do not match model {hidden_size}"
            )
        self.loaded = True

    def embed_texts(self, texts: list[str], input_type: str | None = None) -> list[list[float]]:
        self._load()
        kind = input_type or "query"
        if kind not in {"query", "passage"}:
            raise ValueError("input_type must be query or passage")
        values = [f"{kind}: {text}" for text in texts]
        inputs = self._tokenizer(
            values, max_length=512, padding=True, truncation=True, return_tensors="pt"
        ).to(self.device)
        with self._torch.inference_mode():
            outputs = self._model(**inputs)
            mask = inputs["attention_mask"].unsqueeze(-1).bool()
            hidden = outputs.last_hidden_state.masked_fill(~mask, 0.0)
            embeddings = hidden.sum(dim=1) / mask.sum(dim=1).clamp(min=1)
            embeddings = self._torch.nn.functional.normalize(embeddings, p=2, dim=1)
        return embeddings.cpu().float().numpy().tolist()


class FlorenceProvider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.caption_model_id
        self.configured_revision = settings.caption_model_revision
        self.task = settings.caption_task
        self._torch: Any = None
        self._model: Any = None
        self._processor: Any = None

    def _load(self) -> None:
        if self.loaded:
            return
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        device = resolve_device(
            torch, self.settings.caption_backend, self.settings.inference_backend
        )
        self._torch = torch
        self._processor = AutoProcessor.from_pretrained(
            self.model_id, revision=self.configured_revision, trust_remote_code=True
        )
        self._model = (
            AutoModelForCausalLM.from_pretrained(
                self.model_id,
                revision=self.configured_revision,
                trust_remote_code=True,
                use_safetensors=True,
                attn_implementation="eager",
            )
            .to(device)
            .eval()
        )
        self.device = device
        self.resolved_revision = getattr(self._model.config, "_commit_hash", None)
        self.loaded = True

    def caption_images(self, images: list[Image.Image]) -> list[str]:
        self._load()
        prompts = [self.task] * len(images)
        inputs = self._processor(text=prompts, images=images, return_tensors="pt", padding=True)
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self._torch.inference_mode():
            generated = self._model.generate(
                **inputs,
                max_new_tokens=self.settings.caption_max_new_tokens,
                num_beams=self.settings.caption_num_beams,
                do_sample=False,
                use_cache=False,
            )
        decoded = self._processor.batch_decode(generated, skip_special_tokens=False)
        captions: list[str] = []
        for text, image in zip(decoded, images, strict=True):
            parsed = self._processor.post_process_generation(
                text, task=self.task, image_size=(image.width, image.height)
            )
            caption = parsed.get(self.task, "") if isinstance(parsed, dict) else str(parsed)
            captions.append(str(caption).strip())
        return captions


def create_providers(
    settings: Settings,
) -> tuple[
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
]:
    if settings.inference_backend == "deterministic":
        return (
            DeterministicEmbeddingProvider(settings, "siglip", settings.embedding_dimensions),
            DeterministicEmbeddingProvider(settings, "dinov2", settings.dinov2_dimensions),
            DeterministicEmbeddingProvider(settings, "dinov3", settings.dinov3_dimensions),
            DeterministicEmbeddingProvider(settings, "e5", settings.text_embedding_dimensions),
            DeterministicCaptionProvider(settings),
        )
    return (
        SiglipProvider(settings),
        Dinov2Provider(settings),
        Dinov3Provider(settings),
        E5Provider(settings),
        FlorenceProvider(settings),
    )
