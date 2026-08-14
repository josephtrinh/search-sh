**Full setup guide: Meilisearch + SigLIP 2 Base on M2 Mac (16 GB) for testing/development**

This guide sets up:
- Meilisearch locally
- Local SigLIP 2 Base for both **text** and **image** embeddings
- A Python indexing script that:
  - Reads product data + image URLs from your API
  - Resizes images before embedding
  - Generates embeddings
  - Pushes documents with `_vectors` into Meilisearch (`userProvided` mode)

This is the most reliable approach on an M2 16 GB for testing.

---

### 1. Install Meilisearch

```bash
# Using Homebrew (recommended on Mac)
brew install meilisearch

# Or download the binary
curl -L https://install.meilisearch.com | sh
```

Start Meilisearch:

```bash
meilisearch --master-key="MASTER_KEY_CHANGE_ME" --db-path=./meili_data
```

Keep this terminal open. Default URL: `http://127.0.0.1:7700`

---

### 2. Create the products index + enable features

```bash
# Create index
curl -X POST 'http://127.0.0.1:7700/indexes' \
  -H 'Authorization: Bearer MASTER_KEY_CHANGE_ME' \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "uid": "products",
    "primaryKey": "id"
  }'

# Enable multimodal (experimental)
curl -X PATCH 'http://127.0.0.1:7700/experimental-features/' \
  -H 'Authorization: Bearer MASTER_KEY_CHANGE_ME' \
  -H 'Content-Type: application/json' \
  --data-binary '{ "multimodal": true }'
```

Configure the embedder as **userProvided** (we will generate vectors ourselves):

```bash
curl -X PATCH 'http://127.0.0.1:7700/indexes/products/settings' \
  -H 'Authorization: Bearer MASTER_KEY_CHANGE_ME' \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "embedders": {
      "siglip": {
        "source": "userProvided",
        "dimensions": 768
      }
    },
    "searchableAttributes": ["name", "description", "material", "color", "category"],
    "filterableAttributes": ["category", "material", "color", "price", "brand"],
    "sortableAttributes": ["price"]
  }'
```

> Note: `google/siglip2-base-patch16-224` outputs **768-dimensional** embeddings.

---

### 3. Python environment + dependencies (M2 friendly)

```bash
python3 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install torch torchvision torchaudio
pip install transformers pillow requests meilisearch tqdm
```

On Apple Silicon, PyTorch will use **MPS** automatically when available.

---

### 4. Indexing script (reads API → resize → embed → push to Meilisearch)

Save as `index_products.py`:

```python
import os
import io
import requests
from PIL import Image
from tqdm import tqdm
import torch
from transformers import AutoModel, AutoProcessor
from meilisearch import Client

# ========== CONFIG ==========
MEILI_URL = "http://127.0.0.1:7700"
MEILI_KEY = "MASTER_KEY_CHANGE_ME"
INDEX_UID = "products"

# Your product API (change this)
PRODUCT_API_URL = "https://your-api.com/products"   # should return list of products
# Expected product fields example:
# {
#   "id": "123",
#   "name": "...",
#   "description": "...",
#   "material": "marble",
#   "color": "grey",
#   "category": "tile",
#   "price": 45.0,
#   "images": ["https://....jpg", "https://....jpg"]   # 1–4 images
# }

MODEL_ID = "google/siglip2-base-patch16-224"
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
BATCH_SIZE = 4          # keep low on 16GB
IMAGE_SIZE = (224, 224) # matches the model
MAX_IMAGES_PER_PRODUCT = 4
# ============================

print(f"Using device: {DEVICE}")

# Load model
processor = AutoProcessor.from_pretrained(MODEL_ID)
model = AutoModel.from_pretrained(MODEL_ID).to(DEVICE).eval()

client = Client(MEILI_URL, MEILI_KEY)
index = client.index(INDEX_UID)


def resize_image(img: Image.Image) -> Image.Image:
    """Resize while keeping aspect ratio, then pad to square."""
    img = img.convert("RGB")
    img.thumbnail(IMAGE_SIZE, Image.Resampling.LANCZOS)
    # Create square canvas
    new_img = Image.new("RGB", IMAGE_SIZE, (255, 255, 255))
    offset = ((IMAGE_SIZE[0] - img.width) // 2, (IMAGE_SIZE[1] - img.height) // 2)
    new_img.paste(img, offset)
    return new_img


def get_image_embedding(image: Image.Image):
    inputs = processor(images=image, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        emb = model.get_image_features(**inputs)
        emb = emb / emb.norm(dim=-1, keepdim=True)  # normalize
    return emb.cpu().numpy()[0].tolist()


def get_text_embedding(text: str):
    inputs = processor(text=[text], return_tensors="pt", padding=True).to(DEVICE)
    with torch.no_grad():
        emb = model.get_text_features(**inputs)
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb.cpu().numpy()[0].tolist()


def fetch_products():
    """Replace this with your real API call."""
    resp = requests.get(PRODUCT_API_URL, timeout=30)
    resp.raise_for_status()
    return resp.json()  # expect a list


def process_product(product: dict):
    """Create one Meilisearch document with averaged image vectors + text vector."""
    doc = {
        "id": str(product["id"]),
        "name": product.get("name", ""),
        "description": product.get("description", ""),
        "material": product.get("material", ""),
        "color": product.get("color", ""),
        "model": product.get("model", ""),
        "series": product.get("series", ""),
        "surface": product.get("surface", ""),
        "edge": product.get("edge", ""),
        "size_group": product.get("size_group", ""),
        "brand": product.get("brand", ""),
        "water_absorption": product.get("water_absorption", ""),
        "fire_resistance": product.get("fire_resistance", ""),
        "remarks": product.get("remarks", ""),
        "image_urls": product.get("images", [])[:MAX_IMAGES_PER_PRODUCT],
    }

    # --- Text embedding ---
    text_for_embed = f"{doc['name']}. {doc['description']}. Material: {doc['material']}. Color: {doc['color']}"
    text_vec = get_text_embedding(text_for_embed)

    # --- Image embeddings (average multiple images) ---
    image_vecs = []
    for url in doc["image_urls"]:
        try:
            r = requests.get(url, timeout=15)
            r.raise_for_status()
            img = Image.open(io.BytesIO(r.content))
            img = resize_image(img)
            image_vecs.append(get_image_embedding(img))
        except Exception as e:
            print(f"  Failed image {url}: {e}")

    if image_vecs:
        # Average the image vectors
        avg_image = [sum(x) / len(x) for x in zip(*image_vecs)]
    else:
        avg_image = text_vec  # fallback

    # Store both under different names (Meilisearch supports multiple vectors)
    doc["_vectors"] = {
        "siglip": text_vec,           # used for text/semantic search
        "siglip_image": avg_image     # used for pure visual search
    }

    return doc


def main():
    products = fetch_products()
    print(f"Fetched {len(products)} products")

    documents = []
    for p in tqdm(products, desc="Embedding"):
        try:
            doc = process_product(p)
            documents.append(doc)
        except Exception as e:
            print(f"Failed product {p.get('id')}: {e}")

        # Push in small batches to avoid memory spikes
        if len(documents) >= 20:
            index.add_documents(documents)
            documents = []

    if documents:
        index.add_documents(documents)

    print("Indexing complete. Check tasks in Meilisearch.")


if __name__ == "__main__":
    main()
```

Run it:

```bash
python index_products.py
```

---

### 5. Searching

**Text / semantic search**

```bash
curl -X POST 'http://127.0.0.1:7700/indexes/products/search' \
  -H 'Authorization: Bearer MASTER_KEY_CHANGE_ME' \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "q": "light grey marble tile for living room",
    "hybrid": {
      "embedder": "siglip",
      "semanticRatio": 0.7
    },
    "limit": 10
  }'
```

**Pure visual search (image → similar products)**

You need to generate the query image embedding yourself (same way as in the script) and send it:

```python
# In a small query script
query_vec = get_image_embedding(resized_query_image)

# Then:
curl ... --data-binary '{
  "vector": QUERY_VEC_HERE,
  "hybrid": { "embedder": "siglip" },
  "limit": 10
}'
```

For production you would normally expose a small FastAPI/Flask endpoint that accepts an uploaded image, embeds it, and calls Meilisearch.

---

### 6. Tips for M2 16 GB

| Tip | Why |
|-----|-----|
| Keep `BATCH_SIZE = 4` or lower | Prevents memory spikes |
| Use `mps` device | Much faster than pure CPU |
| Resize to 224×224 | Matches the model and saves memory |
| Process & push in small batches | Avoids OOM during indexing |
| Close other heavy apps | Leaves more unified memory free |
