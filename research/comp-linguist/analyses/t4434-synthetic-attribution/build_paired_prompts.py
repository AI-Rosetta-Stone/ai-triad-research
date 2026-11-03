#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/4434 AC2 step 2: paired-prompt construction for a blind preference read.

For each PRIMARY (human-labelled) claim, pair its gold node's DOLCE description
against the gold node's own best-matching synthetic statement for that claim.
Order is blinded per pair (X/Y, coin flip seeded) so a rater can't infer which
rendering is which from position. Writes pairs.json (blinded) and pairs_key.json
(the X/Y -> arm mapping, kept separate so the rater isn't holding the answer key
while rating).

Usage:  AI_TRIAD_DATA_ROOT=<data-repo> python build_paired_prompts.py
"""
import glob
import importlib.util
import json
import os
import random
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[4]
RESEARCH = _REPO / "research" / "comp-linguist"
SEED = 4434


def _data_origin() -> Path:
    env = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env:
        return Path(env) / "taxonomy" / "Origin"
    cfg = json.loads((_REPO / ".aitriad.json").read_text(encoding="utf-8"))
    root = Path(cfg.get("data_root", ".."))
    base = root if root.is_absolute() else (_REPO / root)
    return base / cfg.get("taxonomy_dir", "taxonomy/Origin")


ORIGIN = _data_origin()
_spec = importlib.util.spec_from_file_location("embed_taxonomy", _REPO / "scripts" / "embed_taxonomy.py")
et = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(et)


def load_node_by_id():
    by_id = {}
    for p in sorted(glob.glob(str(ORIGIN / "*.json"))):
        b = os.path.basename(p)
        if b in et.SKIP_FILES or b.startswith("embeddings-"):
            continue
        try:
            d = json.loads(Path(p).read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            continue
        pov = b[:-5].lower()
        for n in d.get("nodes", []):
            if isinstance(n, dict) and isinstance(n.get("id"), str):
                by_id[n["id"]] = (n, pov)
    return by_id


def main():
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")
    by_id = load_node_by_id()

    et.TAXONOMY_DIR = ORIGIN
    try:
        lineage_map = et._load_lineage_categories()
    except Exception:
        lineage_map = {}

    gs = {(c.get("debate_id"), c["claim_id"]): c
          for c in json.loads((RESEARCH / "_golden_test_set.json").read_text(encoding="utf-8"))["claims"]}
    gv = json.loads((RESEARCH / "_golden_validation_results.json").read_text(encoding="utf-8"))["results"]
    primary = []
    for r in gv:
        v = r["verdict"]; key = (r.get("debate_id"), r["claim_id"])
        gold = r.get("original_node") if v == "correct" else (r.get("corrected_node") if v == "incorrect" else None)
        if gold and gold in by_id and key in gs:
            primary.append((gs[key]["claim_text"], gs[key]["pov"], gold))

    syn = {}
    for pov in ("acc", "saf", "skp"):
        d = ORIGIN / "synthetic"
        corpus = json.loads((d / f"corpus_{pov}.json").read_text(encoding="utf-8"))
        index = json.loads((d / f"index_{pov}.json").read_text(encoding="utf-8"))
        emb = np.load(d / f"embeddings_{pov}.npy").astype(np.float64)
        by_node = {}
        for e in corpus["entries"]:
            if not e.get("pruned"):
                by_node.setdefault(e["node_id"], []).append(e["statement"])
        offset = 0
        for nid in sorted(by_node):
            n = len(by_node[nid])
            ix = index.get(nid)
            if ix is None or ix["start"] != offset or ix["count"] != n:
                raise SystemExit(f"alignment mismatch {pov} {nid}")
            syn[nid] = (by_node[nid], emb[offset:offset + n])
            offset += n

    rng = random.Random(SEED)
    pairs, key = [], []
    for i, (claim, pov, gold) in enumerate(primary):
        node, node_pov = by_id[gold]
        desc_text = et._compose_field_texts(node, lineage_map)[0]
        s = syn.get(gold)
        if not s:
            continue  # no synthetic coverage for this gold node; can't pair
        qv = model.encode([claim], normalize_embeddings=True, show_progress_bar=False)[0].astype(np.float64)
        texts, V = s
        sims = V @ qv
        j = int(np.argmax(sims))
        statement_text = texts[j]
        blind_order = rng.random() < 0.5  # True: X=description, Y=statement
        x_text, y_text = (desc_text, statement_text) if blind_order else (statement_text, desc_text)
        pair_id = f"p{i:02d}"
        pairs.append({
            "pair_id": pair_id,
            "claim": claim,
            "node_id": gold,
            "node_pov": node_pov,
            "X": x_text,
            "Y": y_text,
        })
        key.append({
            "pair_id": pair_id,
            "X_is": "description" if blind_order else "statement",
            "Y_is": "statement" if blind_order else "description",
            "statement_cos_to_claim": round(float(sims[j]), 3),
        })

    out = Path(__file__).parent
    (out / "pairs.json").write_text(json.dumps(pairs, indent=2), encoding="utf-8")
    (out / "pairs_key.json").write_text(json.dumps(key, indent=2), encoding="utf-8")
    print(f"wrote {len(pairs)} pairs (of {len(primary)} PRIMARY claims; "
          f"{len(primary) - len(pairs)} gold nodes had no synthetic coverage)")


if __name__ == "__main__":
    main()
