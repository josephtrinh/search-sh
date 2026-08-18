import os

os.environ["INFERENCE_BACKEND"] = "deterministic"
os.environ["EMBEDDING_DIMENSIONS"] = "32"
os.environ["DINOV2_DIMENSIONS"] = "32"
os.environ["DINOV3_DIMENSIONS"] = "32"
os.environ["TEXT_EMBEDDING_DIMENSIONS"] = "32"
