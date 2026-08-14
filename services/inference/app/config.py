from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    embedding_model_id: str = "google/siglip2-base-patch16-224"
    embedding_model_revision: str = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
    embedding_dimensions: int = 768
    inference_backend: str = "auto"
    max_upload_bytes: int = 10 * 1024 * 1024
    max_image_pixels: int = 25_000_000
    max_text_batch: int = 32
    max_image_batch: int = 8


@lru_cache
def get_settings() -> Settings:
    return Settings()
