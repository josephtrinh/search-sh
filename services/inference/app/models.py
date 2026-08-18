from enum import IntEnum, StrEnum

from pydantic import BaseModel, Field, model_validator


class Priority(IntEnum):
    interactive = 0
    indexing = 10


class TextInputType(StrEnum):
    query = "query"
    passage = "passage"


class VisualModel(StrEnum):
    siglip2 = "siglip2"
    dinov2 = "dinov2"
    dinov3 = "dinov3"


class EmbeddingGeneration(StrEnum):
    legacy = "legacy"
    current = "current"


class TextEmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=32)
    inputType: TextInputType = TextInputType.query
    priority: Priority = Priority.interactive
    generation: EmbeddingGeneration = EmbeddingGeneration.current

    @model_validator(mode="after")
    def validate_texts(self) -> "TextEmbeddingRequest":
        if any(not text.strip() for text in self.texts):
            raise ValueError("texts must not contain blank values")
        return self


class ImageEmbeddingRequest(BaseModel):
    images: list[str] = Field(min_length=1, max_length=8, description="Base64-encoded images")
    model: VisualModel = VisualModel.siglip2
    priority: Priority = Priority.interactive
    generation: EmbeddingGeneration = EmbeddingGeneration.current


class CaptionRequest(BaseModel):
    images: list[str] = Field(min_length=1, max_length=8, description="Base64-encoded images")
    priority: Priority = Priority.indexing


class EmbeddingResponse(BaseModel):
    embeddings: list[list[float]]
    dimensions: int
    model_id: str
    model_revision: str
    device: str
    queue_wait_ms: float
    inference_ms: float


class CatalogEmbeddingResponse(BaseModel):
    embedding_sets: list[list[list[float]]]
    dimensions: int
    model_id: str
    model_revision: str
    device: str
    queue_wait_ms: float
    inference_ms: float


class CaptionResponse(BaseModel):
    captions: list[str]
    task: str
    model_id: str
    model_revision: str
    device: str
    queue_wait_ms: float
    inference_ms: float


class ModelHealth(BaseModel):
    loaded: bool
    model_id: str
    configured_revision: str
    resolved_revision: str | None
    device: str
    dimensions: int | None = None


class HealthResponse(BaseModel):
    status: str
    queued: int
    models: dict[str, ModelHealth]
