#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
backfill_taxonomy_mappings.py — Re-map null and stale taxonomy_node_id
values in summary key points using embedding cosine similarity.

Usage:
  python scripts/backfill_taxonomy_mappings.py [--dry-run] [--threshold 0.35] [--re-evaluate]

Modes:
  Default: fix null + stale mappings only
  --re-evaluate: also check existing mappings for better matches
  --dry-run: report what would change without writing files
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Optional

from data_tree_guard import assert_clean_data_tree  # t/2902

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
MODEL_NAME = "all-MiniLM-L6-v2"


def resolve_paths():
    aitriad = SCRIPT_DIR.parent / ".aitriad.json"
    if aitriad.exists():
        cfg = json.loads(aitriad.read_text())
        data_root = (SCRIPT_DIR.parent / cfg.get("data_root", "../ai-triad-data")).resolve()
    else:
        data_root = SCRIPT_DIR.parent.parent / "ai-triad-data"

    tax_dir = data_root / "taxonomy" / "Origin"
    summ_dir = data_root / "summaries"
    return tax_dir, summ_dir


def load_embeddings(tax_dir: Path):
    emb_file = tax_dir / "embeddings.json"
    if not emb_file.exists():
        print(f"ERROR: embeddings.json not found at {emb_file}", file=sys.stderr)
        print("Run: python scripts/embed_taxonomy.py generate", file=sys.stderr)
        sys.exit(1)

    data = json.loads(emb_file.read_text())
    nodes = {}
    for nid, entry in data.get("nodes", {}).items():
        vec = entry.get("vector")
        if vec:
            nodes[nid] = {
                "vector": np.array(vec, dtype=np.float32),
                "pov": entry.get("pov", ""),
            }
    return nodes, data.get("node_count", 0), data.get("generated_at", "")


def load_taxonomy_ids(tax_dir: Path) -> set:
    ids = set()
    for f in tax_dir.glob("*.json"):
        if f.name in ("embeddings.json", "edges.json", "policy_actions.json", "Temp.json"):
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8-sig"))
            for node in data.get("nodes", []):
                if node.get("id"):
                    ids.add(node["id"])
        except (json.JSONDecodeError, OSError) as e:
            print(f"  Warning: skipping {f.name}: {e}", file=sys.stderr)
    return ids


def node_pov_from_id(nid: str) -> str:
    if nid.startswith("acc-"):
        return "accelerationist"
    if nid.startswith("saf-"):
        return "safetyist"
    if nid.startswith("skp-"):
        return "skeptic"
    if nid.startswith("sit-") or nid.startswith("cc-"):
        return "situations"
    return "unknown"


def pov_prefix(pov: str) -> str:
    return {"accelerationist": "acc-", "safetyist": "saf-", "skeptic": "skp-"}.get(pov, "")


def encode_texts(texts: list[str], model=None) -> np.ndarray:
    import embed_model_pins  # t/110: pinned revision, shared with embed_taxonomy and CI

    if model is None:
        model = embed_model_pins.load_sentence_transformer(MODEL_NAME)
    print(f"  Encoding {len(texts)} texts with {MODEL_NAME}...", file=sys.stderr)
    vecs = model.encode(texts, normalize_embeddings=True, show_progress_bar=True,
                        batch_size=64)
    return np.array(vecs, dtype=np.float32)


# Pre-computed POV matrices for vectorized similarity search
_pov_matrices: dict[str, tuple[list[str], np.ndarray]] = {}


def _get_pov_matrix(node_embeddings: dict, prefix: str) -> tuple[list[str], np.ndarray]:
    """Build or retrieve a cached (ids, matrix) pair for a POV prefix."""
    cache_key = prefix or "__all__"
    if cache_key not in _pov_matrices:
        ids = []
        vecs = []
        for nid, entry in node_embeddings.items():
            if prefix and not nid.startswith(prefix):
                continue
            ids.append(nid)
            vecs.append(entry["vector"])
        if vecs:
            _pov_matrices[cache_key] = (ids, np.stack(vecs))
        else:
            _pov_matrices[cache_key] = ([], np.empty((0, 384), dtype=np.float32))
    return _pov_matrices[cache_key]


def find_best_match(query_vec: np.ndarray, node_embeddings: dict,
                    pov_filter: str, threshold: float,
                    exclude_id: Optional[str] = None) -> tuple[Optional[str], float]:
    prefix = pov_prefix(pov_filter)
    ids, matrix = _get_pov_matrix(node_embeddings, prefix)

    if len(ids) == 0:
        return None, -1.0

    # Vectorized: (N, 384) @ (384,) → (N,) cosine similarities
    sims = matrix @ query_vec

    if exclude_id and exclude_id in ids:
        exclude_idx = ids.index(exclude_id)
        sims[exclude_idx] = -1.0

    best_idx = int(np.argmax(sims))
    best_sim = float(sims[best_idx])

    if best_sim >= threshold:
        return ids[best_idx], best_sim
    return None, best_sim


def main():
    parser = argparse.ArgumentParser(description="Backfill null/stale taxonomy_node_id in summaries")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing files")
    parser.add_argument("--threshold", type=float, default=0.35,
                        help="Minimum cosine similarity for a match (default: 0.35)")
    parser.add_argument("--re-evaluate", action="store_true",
                        help="Also re-evaluate existing mappings for better matches")
    parser.add_argument("--re-evaluate-margin", type=float, default=0.08,
                        help="Minimum improvement to reassign an existing mapping (default: 0.08)")
    args = parser.parse_args()

    tax_dir, summ_dir = resolve_paths()

    # Load data
    print("Loading taxonomy...", file=sys.stderr)
    known_ids = load_taxonomy_ids(tax_dir)
    print(f"  {len(known_ids)} taxonomy nodes", file=sys.stderr)

    print("Loading embeddings...", file=sys.stderr)
    node_embs, emb_count, emb_date = load_embeddings(tax_dir)
    print(f"  {len(node_embs)} embedded nodes (generated {emb_date})", file=sys.stderr)

    missing_embeddings = known_ids - set(node_embs.keys())
    if missing_embeddings:
        pov_missing = {}
        for nid in missing_embeddings:
            p = node_pov_from_id(nid)
            pov_missing[p] = pov_missing.get(p, 0) + 1
        print(f"\n  WARNING: {len(missing_embeddings)} nodes have no embeddings:", file=sys.stderr)
        for p, c in sorted(pov_missing.items()):
            print(f"    {p}: {c}", file=sys.stderr)
        print("  Run: python scripts/embed_taxonomy.py generate", file=sys.stderr)
        print("  Continuing with available embeddings...\n", file=sys.stderr)

    # Scan summaries
    print("Scanning summaries...", file=sys.stderr)
    summ_files = sorted(summ_dir.glob("*.json"))

    tasks = []  # (file, pov, kp_index, text, current_id, reason)
    for sf in summ_files:
        try:
            data = json.loads(sf.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"  Warning: skipping {sf.name}: {e}", file=sys.stderr)
            continue

        for pov, ps in (data.get("pov_summaries") or {}).items():
            for i, kp in enumerate(ps.get("key_points", [])):
                current = kp.get("taxonomy_node_id")
                text = kp.get("point", "")
                if not text:
                    continue

                if current is None:
                    tasks.append((sf, pov, i, text, current, "null"))
                elif current not in known_ids:
                    tasks.append((sf, pov, i, text, current, "stale"))
                elif args.re_evaluate and current in node_embs:
                    tasks.append((sf, pov, i, text, current, "re-evaluate"))

    null_count = sum(1 for t in tasks if t[5] == "null")
    stale_count = sum(1 for t in tasks if t[5] == "stale")
    reeval_count = sum(1 for t in tasks if t[5] == "re-evaluate")
    print(f"  Found: {null_count} null, {stale_count} stale, {reeval_count} re-evaluate", file=sys.stderr)

    if not tasks:
        print("\nNothing to backfill.", file=sys.stderr)
        return

    # Encode key point texts
    texts = [t[3] for t in tasks]
    vectors = encode_texts(texts)

    # Find best matches
    print("\nComputing matches...", file=sys.stderr)
    changes = []  # (file, pov, kp_index, old_id, new_id, similarity, reason)
    no_match = 0

    for idx, (sf, pov, kp_idx, text, current_id, reason) in enumerate(tasks):
        query_vec = vectors[idx]

        if reason == "re-evaluate":
            current_sim = float(np.dot(query_vec, node_embs[current_id]["vector"]))
            best_id, best_sim = find_best_match(
                query_vec, node_embs, pov, args.threshold, exclude_id=current_id
            )
            if best_id and (best_sim - current_sim) >= args.re_evaluate_margin:
                changes.append((sf, pov, kp_idx, current_id, best_id, best_sim, reason))
        else:
            best_id, best_sim = find_best_match(query_vec, node_embs, pov, args.threshold)
            if best_id:
                changes.append((sf, pov, kp_idx, current_id, best_id, best_sim, reason))
            else:
                no_match += 1

    # Report
    null_fixed = sum(1 for c in changes if c[6] == "null")
    stale_fixed = sum(1 for c in changes if c[6] == "stale")
    reassigned = sum(1 for c in changes if c[6] == "re-evaluate")

    print(f"\n{'DRY RUN — ' if args.dry_run else ''}Results:", file=sys.stderr)
    print(f"  Null → mapped:    {null_fixed}", file=sys.stderr)
    print(f"  Stale → remapped: {stale_fixed}", file=sys.stderr)
    print(f"  Re-evaluated:     {reassigned}", file=sys.stderr)
    print(f"  No match found:   {no_match}", file=sys.stderr)
    print(f"  Total changes:    {len(changes)}", file=sys.stderr)

    # Group by similarity bucket
    if changes:
        sims = [c[5] for c in changes]
        print(f"\n  Similarity distribution:", file=sys.stderr)
        for lo, hi, label in [(0.6, 1.0, "0.60+  (strong)"),
                               (0.5, 0.6, "0.50-0.59 (good)"),
                               (0.4, 0.5, "0.40-0.49 (fair)"),
                               (0.35, 0.4, "0.35-0.39 (weak)")]:
            count = sum(1 for s in sims if lo <= s < hi)
            if count:
                print(f"    {label}: {count}", file=sys.stderr)

    # Show sample changes
    if changes:
        print(f"\n  Sample changes:", file=sys.stderr)
        for sf, pov, kp_idx, old_id, new_id, sim, reason in changes[:10]:
            old_label = old_id or "null"
            print(f"    [{reason}] {sf.stem[:35]}  {pov[:4]}[{kp_idx}]  "
                  f"{old_label} → {new_id}  (sim={sim:.3f})", file=sys.stderr)

    if args.dry_run:
        print("\nDry run complete. No files modified.", file=sys.stderr)
        # Output JSON report to stdout
        report = {
            "null_fixed": null_fixed,
            "stale_fixed": stale_fixed,
            "reassigned": reassigned,
            "no_match": no_match,
            "changes": [
                {
                    "file": str(c[0].name),
                    "pov": c[1],
                    "kp_index": c[2],
                    "old_id": c[3],
                    "new_id": c[4],
                    "similarity": round(c[5], 4),
                    "reason": c[6],
                }
                for c in changes
            ],
        }
        json.dump(report, sys.stdout, indent=2)
        return

    # Apply changes
    print("\nApplying changes...", file=sys.stderr)
    files_to_update = {}
    for sf, pov, kp_idx, old_id, new_id, sim, reason in changes:
        key = str(sf)
        if key not in files_to_update:
            files_to_update[key] = json.loads(sf.read_text(encoding="utf-8-sig"))
        data = files_to_update[key]
        kp = data["pov_summaries"][pov]["key_points"][kp_idx]
        kp["taxonomy_node_id"] = new_id
        if "_backfill" not in kp:
            kp["_backfill"] = {}
        kp["_backfill"] = {
            "previous_id": old_id,
            "similarity": round(sim, 4),
            "reason": reason,
            "backfill_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    for fpath, data in files_to_update.items():
        assert_clean_data_tree(fpath)  # t/2902
        Path(fpath).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")

    print(f"  Updated {len(files_to_update)} summary files.", file=sys.stderr)
    print("\nDone.", file=sys.stderr)


if __name__ == "__main__":
    main()
