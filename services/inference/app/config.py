from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    embedding_model_id: str = "google/siglip2-base-patch16-naflex"
    embedding_model_revision: str = "b53b807d3a2d5e2b3911292f2d69e5341cdc064c"
    embedding_dimensions: int = 768
    siglip_max_num_patches: int = 576
    dinov2_model_id: str = "facebook/dinov2-base"
    dinov2_model_revision: str = "f9e44c814b77203eaa57a6bdbbd535f21ede1415"
    dinov2_dimensions: int = 768
    dinov2_image_size: int = 392
    dinov2_pooling: str = "cls_patch_mean"
    dinov3_model_id: str = "facebook/dinov3-vitb16-pretrain-lvd1689m"
    dinov3_model_archive: str = (
        "./temp/facebookdinov3-vitb16-pretrain-lvd1689m-transformers-default-v1.tar.gz"
    )
    dinov3_model_dir: str = "./temp/dinov3-vitb16-pretrain-lvd1689m"
    dinov3_archive_sha256: str = "037a1f688847bedfe533bc1c44b336160d56306c91ad008498c93659dbe85fe0"
    dinov3_dimensions: int = 768
    dinov3_image_size: int = 384
    dinov3_pooling: str = "cls_patch_mean"
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

    @field_validator("dinov2_image_size")
    @classmethod
    def validate_dinov2_image_size(cls, value: int) -> int:
        if value < 224 or value > 518 or value % 14:
            raise ValueError("DINOV2_IMAGE_SIZE must be a multiple of 14 between 224 and 518")
        return value

    @field_validator("dinov3_image_size")
    @classmethod
    def validate_dinov3_image_size(cls, value: int) -> int:
        if value < 224 or value > 512 or value % 16:
            raise ValueError("DINOV3_IMAGE_SIZE must be a multiple of 16 between 224 and 512")
        return value

    @field_validator("dinov2_pooling", "dinov3_pooling")
    @classmethod
    def validate_dino_pooling(cls, value: str) -> str:
        if value not in {"cls", "patch_mean", "cls_patch_mean"}:
            raise ValueError("DINO pooling must be cls, patch_mean, or cls_patch_mean")
        return value

    @field_validator("siglip_max_num_patches")
    @classmethod
    def validate_siglip_patches(cls, value: int) -> int:
        if value < 64 or value > 1024:
            raise ValueError("SIGLIP_MAX_NUM_PATCHES must be between 64 and 1024")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
