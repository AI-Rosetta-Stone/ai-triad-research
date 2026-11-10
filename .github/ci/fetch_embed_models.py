"""Pre-fetch the embedding models into the HF cache (t/1989, t/55).

Kept as a SEPARATE step from the value-stability assertion so a failure here is
unambiguously an HF/network outage (infrastructure), while a failure in the
offline assertion step is a real dependency incompatibility. Never conflate them.

t/55: the job stalled the merge queue at its 10-minute timeout because this
script pulled every file in both repos unauthenticated, ~5.4 GB (ONNX, OpenVINO,
TF, rust and pytorch_model.bin copies we never load). Three changes:

- Each model is pinned to a commit, so the CI cache key is stable and an upstream
  re-upload can't silently move the drift baseline. Bump a pin deliberately (and
  re-check embed_reference.json); the workflow's cache key hashes this file, so a
  bump rotates the cache.
- ALLOW_PATTERNS fetches only what sentence-transformers loads (~660 MB total).
- refs/main is pointed at the pinned commit, so name-only loaders running with
  HF_HUB_OFFLINE=1 (assert_embed_stability.py, check_composition_drift.py)
  resolve the pinned snapshot instead of failing to find a ref.

With HF_HUB_OFFLINE=1 (set by ci.yml on a cache hit) this makes no network calls
and fails fast if the cache is incomplete. Online, it retries with backoff.
"""
import os
import sys
import time
from pathlib import Path

from huggingface_hub import snapshot_download

MODELS = {
    "sentence-transformers/all-MiniLM-L6-v2": "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    "cross-encoder/nli-deberta-v3-small": "fa2804872c3b4bd748f38c0185cc85775361e735",
}
# fnmatch-style; '*' also matches '/', so '*.json' covers 1_Pooling/config.json.
ALLOW_PATTERNS = ["*.json", "*.txt", "*.model", "model.safetensors", "README.md"]
ATTEMPTS = 3

offline = os.environ.get("HF_HUB_OFFLINE") == "1"


def fetch(repo_id: str, revision: str) -> Path:
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return Path(snapshot_download(repo_id, revision=revision, allow_patterns=ALLOW_PATTERNS))
        except Exception as exc:  # noqa: BLE001 -- any hub/network error is retryable here
            if offline or attempt == ATTEMPTS:
                raise
            delay = 15 * attempt
            print(f"WARN: {repo_id}@{revision[:7]} attempt {attempt}/{ATTEMPTS} failed ({exc}); retrying in {delay}s",
                  file=sys.stderr)
            time.sleep(delay)
    raise AssertionError("unreachable")


for repo_id, revision in MODELS.items():
    snapshot = fetch(repo_id, revision)
    refs_main = snapshot.parent.parent / "refs" / "main"
    refs_main.parent.mkdir(parents=True, exist_ok=True)
    refs_main.write_text(revision)
    size = sum(f.stat().st_size for f in snapshot.rglob("*") if f.is_file())
    print(f"{repo_id}@{revision[:7]}: {size / 1e6:.0f} MB {'(offline, from cache)' if offline else ''}")

print("models fetched to cache")
