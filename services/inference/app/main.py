from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException

from app.config import get_settings
from app.models import (
    CaptionRequest,
    CaptionResponse,
    EmbeddingResponse,
    HealthResponse,
    ImageEmbeddingRequest,
    ModelHealth,
    TextEmbeddingRequest,
)
from app.provider import create_providers, decode_image
from app.scheduler import PriorityScheduler

settings = get_settings()
siglip, e5, florence = create_providers(settings)
scheduler = PriorityScheduler()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await scheduler.start()
    yield
    await scheduler.stop()


app = FastAPI(title="SampleHub Inference", version="0.2.0", lifespan=lifespan)


def model_health(provider: Any) -> ModelHealth:
    return ModelHealth(
        loaded=provider.loaded,
        model_id=provider.model_id,
        configured_revision=provider.configured_revision,
        resolved_revision=provider.resolved_revision,
        dimensions=provider.dimensions,
        device=provider.device,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        queued=scheduler.queued,
        models={
            "siglip": model_health(siglip),
            "e5": model_health(e5),
            "florence": model_health(florence),
        },
    )


async def embed_response(provider: Any, priority: int, operation: Any) -> EmbeddingResponse:
    embeddings, queue_ms, inference_ms = await scheduler.submit(priority, operation)
    return EmbeddingResponse(
        embeddings=embeddings,
        dimensions=provider.dimensions,
        model_id=provider.model_id,
        model_revision=provider.resolved_revision or provider.configured_revision,
        device=provider.device,
        queue_wait_ms=queue_ms,
        inference_ms=inference_ms,
    )


@app.post("/v1/embed/text", response_model=EmbeddingResponse)
async def embed_text(request: TextEmbeddingRequest) -> EmbeddingResponse:
    try:
        return await embed_response(
            e5,
            request.priority,
            lambda: e5.embed_texts(request.texts, request.inputType.value),
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/embed/visual-text", response_model=EmbeddingResponse)
async def embed_visual_text(request: TextEmbeddingRequest) -> EmbeddingResponse:
    try:
        return await embed_response(
            siglip, request.priority, lambda: siglip.embed_texts(request.texts)
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/embed/images", response_model=EmbeddingResponse)
async def embed_images(request: ImageEmbeddingRequest) -> EmbeddingResponse:
    try:
        images = [decode_image(encoded, settings) for encoded in request.images]
        return await embed_response(
            siglip, request.priority, lambda: siglip.embed_images(images)
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/caption/images", response_model=CaptionResponse)
async def caption_images(request: CaptionRequest) -> CaptionResponse:
    if len(request.images) > settings.max_caption_batch:
        raise HTTPException(
            status_code=422,
            detail=f"caption batch exceeds {settings.max_caption_batch} images",
        )
    try:
        images = [decode_image(encoded, settings) for encoded in request.images]
        captions, queue_ms, inference_ms = await scheduler.submit(
            request.priority, lambda: florence.caption_images(images)
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return CaptionResponse(
        captions=captions,
        task=florence.task,
        model_id=florence.model_id,
        model_revision=florence.resolved_revision or florence.configured_revision,
        device=florence.device,
        queue_wait_ms=queue_ms,
        inference_ms=inference_ms,
    )
