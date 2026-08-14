from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from app.config import get_settings
from app.models import (
    EmbeddingResponse,
    HealthResponse,
    ImageEmbeddingRequest,
    TextEmbeddingRequest,
)
from app.provider import create_provider, decode_image
from app.scheduler import PriorityScheduler

settings = get_settings()
provider = create_provider(settings)
scheduler = PriorityScheduler()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await scheduler.start()
    yield
    await scheduler.stop()


app = FastAPI(title="SampleHub Inference", version="0.1.0", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        loaded=provider.loaded,
        model_id=provider.model_id,
        configured_revision=provider.configured_revision,
        resolved_revision=provider.resolved_revision,
        dimensions=provider.dimensions,
        device=provider.device,
        queued=scheduler.queued,
    )


@app.post("/v1/embed/text", response_model=EmbeddingResponse)
async def embed_text(request: TextEmbeddingRequest) -> EmbeddingResponse:
    try:
        embeddings, queue_ms, inference_ms = await scheduler.submit(
            request.priority, lambda: provider.embed_texts(request.texts)
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return EmbeddingResponse(
        embeddings=embeddings,
        dimensions=provider.dimensions,
        model_id=provider.model_id,
        model_revision=provider.resolved_revision or provider.configured_revision,
        device=provider.device,
        queue_wait_ms=queue_ms,
        inference_ms=inference_ms,
    )


@app.post("/v1/embed/images", response_model=EmbeddingResponse)
async def embed_images(request: ImageEmbeddingRequest) -> EmbeddingResponse:
    try:
        images = [decode_image(encoded, settings) for encoded in request.images]
        embeddings, queue_ms, inference_ms = await scheduler.submit(
            request.priority, lambda: provider.embed_images(images)
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return EmbeddingResponse(
        embeddings=embeddings,
        dimensions=provider.dimensions,
        model_id=provider.model_id,
        model_revision=provider.resolved_revision or provider.configured_revision,
        device=provider.device,
        queue_wait_ms=queue_ms,
        inference_ms=inference_ms,
    )
