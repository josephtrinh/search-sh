from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

import httpx
import numpy as np
from PIL import Image

from app.config import ROOT_ENV, Settings

DINOV3_ARCHIVE_ROOT = PurePosixPath("facebook/dinov3-vitb16-pretrain-lvd1689m")
DINOV3_REQUIRED_FILES = ("config.json", "preprocessor_config.json", "model.safetensors")
LEGACY_SIGLIP_MODEL_ID = "google/siglip2-base-patch16-224"
LEGACY_SIGLIP_REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
DINOV_PADDING = (124, 116, 104)


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
        is_model_entry = name == DINOV3_ARCHIVE_ROOT or DINOV3_ARCHIVE_ROOT in name.parents
        is_parent_entry = name in DINOV3_ARCHIVE_ROOT.parents and name != PurePosixPath(".")
        if not name.parts or not (is_model_entry or is_parent_entry):
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
        extracted = staging.joinpath(*DINOV3_ARCHIVE_ROOT.parts)
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


def adaptive_catalog_views(image: Image.Image) -> list[Image.Image]:
    """Keep the whole frame and add up to four square long-axis tiles."""
    width, height = image.size
    short, long = min(width, height), max(width, height)
    views = [image.copy()]
    if short <= 0 or long / short <= 1.2:
        return views
    tile_count = min(4, max(2, int(np.ceil(long / short))))
    travel = long - short
    offsets = [round(index * travel / (tile_count - 1)) for index in range(tile_count)]
    for offset in dict.fromkeys(offsets):
        box = (
            (offset, 0, offset + short, short)
            if width >= height
            else (0, offset, short, offset + short)
        )
        views.append(image.crop(box))
    return views


def letterbox_square(image: Image.Image) -> Image.Image:
    side = max(image.size)
    canvas = Image.new("RGB", (side, side), DINOV_PADDING)
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def dino_descriptor(torch: Any, outputs: Any, register_tokens: int, pooling: str) -> Any:
    cls = torch.nn.functional.normalize(outputs.last_hidden_state[:, 0], p=2, dim=1)
    patches = outputs.last_hidden_state[:, 1 + register_tokens :]
    patch_mean = torch.nn.functional.normalize(patches.mean(dim=1), p=2, dim=1)
    if pooling == "cls":
        return cls
    if pooling == "patch_mean":
        return patch_mean
    return torch.nn.functional.normalize((cls + patch_mean) * 0.5, p=2, dim=1)


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

    def embed_images(
        self, images: list[Image.Image], generation: str = "current"
    ) -> list[list[float]]:
        del generation
        return [self._vector(image.tobytes()) for image in images]


class DeterministicCaptionProvider(ProviderMetadata):
    def __init__(self, settings: Settings, provider: str = "florence"):
        self.model_id = f"deterministic-{provider}-caption-provider"
        self.configured_revision = "1"
        self.resolved_revision = "1"
        self.device = "cpu"
        self.loaded = True
        self.task = (
            settings.caption_task
            if provider == "florence"
            else settings.qwen_caption_prompt_version
        )

    def caption_images(self, images: list[Image.Image]) -> list[str]:
        return [f"Test image with dimensions {image.width} by {image.height}." for image in images]


NO_MATERIAL_SENTINEL = "<NO_MATERIAL>"
QWEN_USER_PROMPT = (
    "Describe the material surface according to the catalog-captioning instructions. "
    "Return only the final caption."
)


def normalize_qwen_caption(value: str, max_characters: int = 1200) -> str | None:
    text = re.sub(r"<think>.*?</think>", "", value, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"</?(?:pad|s|assistant|analysis|final)>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<\|[^>]+\|>", "", text)
    text = text.strip().strip('"\'').strip()
    if text == NO_MATERIAL_SENTINEL:
        return None
    if (
        not text
        or len(text) > max_characters
        or text.startswith(("{", "[", "#", "- ", "* "))
        or "\n\n" in text
    ):
        raise ValueError("Qwen returned a malformed material caption")
    return " ".join(text.split())


class QwenCaptionProvider(ProviderMetadata):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.qwen_caption_model_id
        self.configured_revision = settings.qwen_caption_model_sha256
        self.resolved_revision = settings.qwen_caption_model_sha256
        self.task = settings.qwen_caption_prompt_version
        self.device = "llama-server"
        self.loaded = False
        prompt_path = resolve_workspace_path(settings.qwen_caption_prompt_path)
        try:
            self.system_prompt = prompt_path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RuntimeError(f"Qwen caption prompt was not found at {prompt_path}") from exc
        actual_prompt_sha256 = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
        if actual_prompt_sha256 != settings.qwen_caption_prompt_sha256.lower():
            raise RuntimeError(
                "Qwen caption prompt checksum does not match QWEN_CAPTION_PROMPT_SHA256; "
                "update the prompt version and checksum together"
            )

    @staticmethod
    def _image_data_url(image: Image.Image) -> str:
        target = io.BytesIO()
        image.save(target, format="JPEG", quality=92, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(target.getvalue()).decode("ascii")

    def _caption_image(self, image: Image.Image) -> str | None:
        payload = {
            "model": self.model_id,
            "messages": [
                {"role": "system", "content": self.system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": QWEN_USER_PROMPT},
                        {"type": "image_url", "image_url": {"url": self._image_data_url(image)}},
                    ],
                },
            ],
            "temperature": 0,
            "seed": self.settings.qwen_caption_seed,
            "max_tokens": self.settings.qwen_caption_max_tokens,
            "stream": False,
            "reasoning_format": "none",
            "chat_template_kwargs": {"enable_thinking": False},
        }
        last_error: Exception | None = None
        for _ in range(2):
            try:
                response = httpx.post(
                    f"{self.settings.qwen_caption_url.rstrip('/')}/v1/chat/completions",
                    json=payload,
                    timeout=self.settings.qwen_caption_timeout_seconds,
                )
                response.raise_for_status()
                body = response.json()
                content = body["choices"][0]["message"]["content"]
                if not isinstance(content, str):
                    raise ValueError("Qwen response did not contain text content")
                caption = normalize_qwen_caption(content)
                self.loaded = True
                return caption
            except httpx.HTTPStatusError as exc:
                detail = exc.response.text.strip()[:1000]
                message = f"Qwen server returned HTTP {exc.response.status_code}: {detail or exc}"
                last_error = (
                    ValueError(message)
                    if exc.response.status_code in {400, 413, 422}
                    else RuntimeError(message)
                )
            except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
                last_error = exc
        if isinstance(last_error, ValueError):
            raise last_error
        raise RuntimeError(f"Qwen caption server request failed: {last_error}") from last_error

    def caption_images(self, images: list[Image.Image]) -> list[str | None]:
        return [self._caption_image(image) for image in images]


class SiglipProvider(ProviderMetadata):
    def __init__(self, settings: Settings, legacy: bool = False):
        self.settings = settings
        self.legacy = legacy
        self.model_id = LEGACY_SIGLIP_MODEL_ID if legacy else settings.embedding_model_id
        self.configured_revision = (
            LEGACY_SIGLIP_REVISION if legacy else settings.embedding_model_revision
        )
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

    def embed_images(
        self, images: list[Image.Image], generation: str = "current"
    ) -> list[list[float]]:
        del generation
        self._load()
        kwargs = {} if self.legacy else {"max_num_patches": self.settings.siglip_max_num_patches}
        inputs = self._processor(images=images, return_tensors="pt", **kwargs).to(self.device)
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

    def embed_images(
        self, images: list[Image.Image], generation: str = "current"
    ) -> list[list[float]]:
        self._load()
        if generation == "legacy":
            inputs = self._processor(images=images, return_tensors="pt").to(self.device)
        else:
            prepared = [letterbox_square(image) for image in images]
            size = {
                "height": self.settings.dinov2_image_size,
                "width": self.settings.dinov2_image_size,
            }
            inputs = self._processor(
                images=prepared, size=size, do_center_crop=False, return_tensors="pt"
            ).to(self.device)
        with self._torch.inference_mode():
            outputs = self._model(**inputs)
            embeddings = (
                self._torch.nn.functional.normalize(outputs.pooler_output, p=2, dim=1)
                if generation == "legacy"
                else dino_descriptor(self._torch, outputs, 0, self.settings.dinov2_pooling)
            )
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

    def embed_images(
        self, images: list[Image.Image], generation: str = "current"
    ) -> list[list[float]]:
        self._load()
        if generation == "legacy":
            inputs = self._processor(
                images=images, size={"height": 224, "width": 224}, return_tensors="pt"
            ).to(self.device)
        else:
            prepared = [letterbox_square(image) for image in images]
            size = {
                "height": self.settings.dinov3_image_size,
                "width": self.settings.dinov3_image_size,
            }
            inputs = self._processor(
                images=prepared, size=size, do_center_crop=False, return_tensors="pt"
            ).to(self.device)
        with self._torch.inference_mode():
            outputs = self._model(**inputs)
            embeddings = (
                self._torch.nn.functional.normalize(outputs.pooler_output, p=2, dim=1)
                if generation == "legacy"
                else dino_descriptor(
                    self._torch,
                    outputs,
                    int(getattr(self._model.config, "num_register_tokens", 4)),
                    self.settings.dinov3_pooling,
                )
            )
        return embeddings.cpu().float().numpy().tolist()


def embed_catalog_images(
    provider: Any, images: list[Image.Image], generation: str, batch_size: int
) -> list[list[list[float]]]:
    view_sets = [
        [image] if generation == "legacy" else adaptive_catalog_views(image) for image in images
    ]
    flat = [view for views in view_sets for view in views]
    vectors: list[list[float]] = []
    for offset in range(0, len(flat), batch_size):
        vectors.extend(provider.embed_images(flat[offset : offset + batch_size], generation))
    result: list[list[list[float]]] = []
    cursor = 0
    for views in view_sets:
        result.append(vectors[cursor : cursor + len(views)])
        cursor += len(views)
    return result


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
            captions.append(re.sub(r"(?:<pad>|</s>|<s>)", "", str(caption)).strip())
        return captions


def create_providers(
    settings: Settings,
) -> tuple[
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
    ProviderMetadata,
]:
    if settings.inference_backend == "deterministic":
        return (
            DeterministicEmbeddingProvider(settings, "siglip", settings.embedding_dimensions),
            DeterministicEmbeddingProvider(
                settings, "siglip-legacy", settings.embedding_dimensions
            ),
            DeterministicEmbeddingProvider(settings, "dinov2", settings.dinov2_dimensions),
            DeterministicEmbeddingProvider(settings, "dinov3", settings.dinov3_dimensions),
            DeterministicEmbeddingProvider(settings, "e5", settings.text_embedding_dimensions),
            DeterministicCaptionProvider(settings),
            DeterministicCaptionProvider(settings, "qwen"),
        )
    return (
        SiglipProvider(settings),
        SiglipProvider(settings, legacy=True),
        Dinov2Provider(settings),
        Dinov3Provider(settings),
        E5Provider(settings),
        FlorenceProvider(settings),
        QwenCaptionProvider(settings),
    )
