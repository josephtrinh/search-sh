from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    embedding_model_id: str = "google/siglip2-base-patch16-224"
    embedding_model_revision: str = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
    embedding_dimensions: int = 768
    dinov2_model_id: str = "facebook/dinov2-base"
    dinov2_model_revision: str = "f9e44c814b77203eaa57a6bdbbd535f21ede1415"
    dinov2_dimensions: int = 768
    dinov3_model_id: str = "facebook/dinov3-vith16plus-pretrain-lvd1689m"
    dinov3_model_archive: str = (
        "./temp/dinov3-vith16plus-pretrain-lvd1689m-transformers-default-v1.tar.gz"
    )
    dinov3_model_dir: str = "./temp/dinov3-vith16plus-pretrain-lvd1689m"
    dinov3_archive_sha256: str = "57a28916842ed1d39728ae18c0732ffc31a904407c135232a9a15c87cc28b10d"
    dinov3_dimensions: int = 1280
    dinov3_image_size: int = 224
    text_embedding_model_id: str = "intfloat/multilingual-e5-base"
    text_embedding_model_revision: str = "d128750597153bb5987e10b1c3493a34e5a4502a"
    text_embedding_dimensions: int = 768
    caption_model_id: str = "microsoft/Florence-2-base-ft"
    caption_model_revision: str = "f6c1a25888ffc1d945ee8a1a77ac833c7303d46e"
    caption_task: str = "<DETAILED_CAPTION>"
    caption_max_new_tokens: int = 128
    caption_num_beams: int = 3
    inference_backend: str = "auto"
    siglip_backend: str | None = None
    dinov2_backend: str | None = None
    dinov3_backend: str | None = None
    text_embedding_backend: str | None = None
    caption_backend: str | None = None
    max_upload_bytes: int = 10 * 1024 * 1024
    max_image_pixels: int = 25_000_000
    max_text_batch: int = 32
    max_image_batch: int = 8
    max_caption_batch: int = 2

    @field_validator("dinov3_image_size")
    @classmethod
    def validate_dinov3_image_size(cls, value: int) -> int:
        if value < 224 or value > 512 or value % 16:
            raise ValueError("DINOV3_IMAGE_SIZE must be a multiple of 16 between 224 and 512")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
