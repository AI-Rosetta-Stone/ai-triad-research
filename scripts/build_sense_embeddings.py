#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
build_sense_embeddings.py — Build sense embeddings for the taxonomy vocabulary dictionary.

Computes embeddings for every standardized term's `definition + characteristic_phrases`
and writes them to `dictionary/sense_embeddings.json`. Uses incremental rebuild: only
recomputes embeddings when the source fields change (hash-based invalidation).

Usage:
    python scripts/build_sense_embeddings.py [--data-root PATH] [--model MODEL] [--force]
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

from data_tree_guard import assert_clean_data_tree  # t/2902

_SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = "all-MiniLM-L6-v2"


def _resolve_data_root(override=None):
    """Resolve the data root from override, .aitriad.json, or default."""
    if override:
        return Path(override).resolve()

    config_path = _SCRIPT_DIR.parent / ".aitriad.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
            data_root = cfg.get("data_root", ".")
            base = (
                Path(data_root)
                if Path(data_root).is_absolute()
                else (_SCRIPT_DIR.parent / data_root)
            )
            return base.resolve()
        except (json.JSONDecodeError, OSError):
            pass

    return (_SCRIPT_DIR.parent).resolve()


def compute_source_hash(term: dict) -> str:
    """Hash the fields that affect the embedding: definition + characteristic_phrases."""
    content = term.get("definition", "") + "\n" + "\n".join(term.get("characteristic_phrases", []))
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def build_embedding_text(term: dict) -> str:
    """Construct the text to embed from definition and characteristic phrases."""
    parts = [term.get("definition", "")]
    for phrase in term.get("characteristic_phrases", []):
        parts.append(phrase)
    return ". ".join(p for p in parts if p)


def load_standardized_terms(dictionary_dir: Path) -> list[dict]:
    """Load all standardized term JSON files."""
    std_dir = dictionary_dir / "standardized"
    if not std_dir.exists():
        return []
    terms = []
    for f in sorted(std_dir.glob("*.json")):
        try:
            terms.append(json.loads(f.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError) as e:
            print(f"WARNING: Skipping {f.name}: {e}", file=sys.stderr)
    return terms


def load_existing_embeddings(embeddings_path: Path) -> dict:
    """Load the existing sense_embeddings.json if it exists."""
    if not embeddings_path.exists():
        return {"$schema_version": "1.0.0", "model": "", "dimensions": 0, "entries": {}}
    try:
        return json.loads(embeddings_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"$schema_version": "1.0.0", "model": "", "dimensions": 0, "entries": {}}


def main():
    parser = argparse.ArgumentParser(description="Build sense embeddings for the vocabulary dictionary")
    parser.add_argument("--data-root", help="Override data root directory")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Embedding model (default: {DEFAULT_MODEL})")
    parser.add_argument("--force", action="store_true", help="Force rebuild of all embeddings")
    args = parser.parse_args()

    data_root = _resolve_data_root(args.data_root)
    dictionary_dir = data_root / "dictionary"
    embeddings_path = dictionary_dir / "sense_embeddings.json"

    if not dictionary_dir.exists():
        print(f"ERROR: Dictionary directory not found at {dictionary_dir}", file=sys.stderr)
        sys.exit(1)

    terms = load_standardized_terms(dictionary_dir)
    existing = load_existing_embeddings(embeddings_path)

    # t/110: sense_embeddings.json is consumed in production, so the model must be PINNED
    # (scripts/embed_model_pins.json) -- an unpinned --model is refused, never loaded from `main`
    # (TL p/37#17). The revision is recorded in the output and is part of the cache key.
    import embed_model_pins

    try:
        revision = embed_model_pins.pinned_revision(args.model)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    cached_revision = existing.get("model_revision")
    if existing.get("entries") and cached_revision is None and existing.get("model") == args.model:
        print(f"WARN: {embeddings_path.name} predates model_revision (t/110); treating its cached vectors "
              f"as {revision[:7]}, the pin that matched `main` when it was introduced (t/62).", file=sys.stderr)
        cached_revision = revision

    # Determine which terms need (re)embedding
    to_embed = []
    unchanged = {}

    for term in terms:
        canonical = term["canonical_form"]
        source_hash = compute_source_hash(term)

        if (
            not args.force
            and canonical in existing.get("entries", {})
            and existing["entries"][canonical].get("hash") == source_hash
            and existing.get("model") == args.model
            and cached_revision == revision
        ):
            unchanged[canonical] = existing["entries"][canonical]
        else:
            to_embed.append((canonical, term, source_hash))

    # Remove entries for terms that no longer exist
    current_canonicals = {t["canonical_form"] for t in terms}
    removed = [k for k in existing.get("entries", {}) if k not in current_canonicals]

    if not to_embed and not removed:
        print(f"All {len(unchanged)} sense embeddings are up to date.", file=sys.stderr)
        sys.exit(0)

    print(
        f"Sense embeddings: {len(unchanged)} cached, {len(to_embed)} to compute, {len(removed)} to remove",
        file=sys.stderr,
    )

    # Compute new embeddings
    new_entries = dict(unchanged)
    dimensions = existing.get("dimensions", 0)

    if to_embed:
        try:
            import sentence_transformers  # noqa: F401 -- fail early with the install hint
        except ImportError:
            print(
                "ERROR: sentence-transformers not installed.\n"
                "  pip install sentence-transformers",
                file=sys.stderr,
            )
            sys.exit(1)

        print(f"Loading model: {args.model}@{revision[:7]}", file=sys.stderr)
        t0 = time.time()
        model = embed_model_pins.load_sentence_transformer(args.model)
        print(f"Model loaded in {time.time() - t0:.1f}s", file=sys.stderr)

        texts = [build_embedding_text(term) for _, term, _ in to_embed]
        print(f"Encoding {len(texts)} texts...", file=sys.stderr)
        t0 = time.time()
        vectors = model.encode(texts, show_progress_bar=len(texts) > 5)
        print(f"Encoded in {time.time() - t0:.1f}s", file=sys.stderr)

        dimensions = int(vectors.shape[1])

        for i, (canonical, _, source_hash) in enumerate(to_embed):
            new_entries[canonical] = {
                "hash": source_hash,
                "embedding": [round(float(v), 6) for v in vectors[i]],
            }

    output = {
        "$schema_version": "1.0.0",
        "model": args.model,
        "model_revision": revision,   # t/110: the pinned commit these vectors came from
        "dimensions": dimensions if dimensions else 0,
        "entries": new_entries,
    }

    assert_clean_data_tree(embeddings_path)  # t/2902
    embeddings_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(
        f"Wrote {len(new_entries)} entries to {embeddings_path.relative_to(data_root)}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
