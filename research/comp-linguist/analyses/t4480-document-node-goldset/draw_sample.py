#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/4480: draw the n=232 sample per allocation.json (seed 4480), freezing the
corpus commit used. Recomputes the SAME per-item (pov, bdi, rank-band) strata as
population_scan.py (same pool, same query field: attribution_text against every
non-pillar node across all four POV files), but keeps full item identity --
population_scan.py only kept per-cell COUNTS.

Writes:
  - sample.json: the frozen sample, one record per drawn item, with the data
    commit hash it was drawn from.
  - label_sheet_cl.json / label_sheet_agent.json: identical content, two files
    so the two raters' labels can't collide or be confused -- each rater fills
    in their own copy's "label" fields.

Usage: AI_TRIAD_DATA_ROOT=<data-repo> python draw_sample.py
"""
import glob
import json
import os
import random
import re
import subprocess
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[4]
RANK_BANDS = [(1, 1, "1"), (2, 5, "2-5"), (6, 30, "6-30"), (31, None, ">30")]
PILLAR_RE = re.compile(r"(?i)^\s*a thematic pillar\b")
SEED = 4480


def _data_origin() -> Path:
    env = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env:
        return Path(env)
    cfg = json.loads((_REPO / ".aitriad.json").read_text(encoding="utf-8"))
    root = Path(cfg.get("data_root", ".."))
    return root if root.is_absolute() else (_REPO / root)


DATA_ROOT = _data_origin()


def band_for(rank):
    for lo, hi, name in RANK_BANDS:
        if rank >= lo and (hi is None or rank <= hi):
            return name
    return ">30"


def git_head(path):
    r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(path), capture_output=True, text=True)
    return r.stdout.strip()


def main():
    from sentence_transformers import SentenceTransformer

    data_commit = git_head(DATA_ROOT)
    print("Data commit (frozen):", data_commit)

    emb = json.loads((DATA_ROOT / "taxonomy/Origin/embeddings.json").read_text(encoding="utf-8"))

    pillar_ids = set()
    bdi_of = {}
    label_of = {}
    for pov_file, pov in (("Accelerationist.json", "acc"), ("Safetyist.json", "saf"),
                          ("Skeptic.json", "skp"), ("CommonContext.json", "cc")):
        p = DATA_ROOT / "taxonomy/Origin" / pov_file
        if not p.exists():
            continue
        d = json.loads(p.read_text(encoding="utf-8-sig"))
        for n in d.get("nodes", []):
            nid = n.get("id")
            if not nid:
                continue
            if PILLAR_RE.match(str(n.get("description", ""))):
                pillar_ids.add(nid)
            parts = nid.split("-")
            if len(parts) >= 2:
                bdi_of[nid] = parts[1]
            label_of[nid] = n.get("label", "")

    ids, vecs = [], []
    for nid, rec in emb["nodes"].items():
        if nid in pillar_ids:
            continue
        ids.append(nid)
        vecs.append(rec["vector"])
    node_mat = np.asarray(vecs, dtype=np.float64)
    node_mat /= np.linalg.norm(node_mat, axis=1, keepdims=True)
    node_idx = {n: i for i, n in enumerate(ids)}

    items = []
    for f in sorted(glob.glob(str(DATA_ROOT / "summaries" / "*.json"))):
        try:
            d = json.loads(Path(f).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for camp, block in (d.get("pov_summaries") or {}).items():
            if not isinstance(block, dict):
                continue
            for kp_idx, kp in enumerate(block.get("key_points") or []):
                nid = kp.get("taxonomy_node_id")
                if not nid or nid not in node_idx:
                    continue
                attr = str(kp.get("attribution_text") or "").strip()
                if not attr:
                    continue
                items.append({
                    "doc": d.get("doc_id"), "camp": camp, "kp_idx": kp_idx,
                    "pov": nid.split("-")[0], "node": nid, "bdi": bdi_of.get(nid, "?"),
                    "attr": attr, "point_text": kp.get("point", ""),
                })

    model = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"))
    Q = np.asarray(model.encode([it["attr"] for it in items], normalize_embeddings=True,
                                 batch_size=128, show_progress_bar=False), dtype=np.float64)
    sims = Q @ node_mat.T

    strata = {}
    for i, it in enumerate(items):
        j = node_idx[it["node"]]
        s = sims[i]
        rank = int((s > s[j]).sum()) + 1
        band = band_for(rank)
        key = f"{it['pov']}|{it['bdi']}|{band}"
        rec = dict(it)
        rec["rank"] = rank
        rec["node_label"] = label_of.get(it["node"], "")
        strata.setdefault(key, []).append(rec)

    allocation = json.loads((_HERE.parent / "allocation.json").read_text(encoding="utf-8"))

    rng = random.Random(SEED)
    sample = []
    shortfalls = {}
    for cell, n_wanted in allocation.items():
        pool = strata.get(cell, [])
        if len(pool) < n_wanted:
            shortfalls[cell] = {"wanted": n_wanted, "available": len(pool)}
        pool_sorted = sorted(pool, key=lambda r: (r["doc"], r["camp"], r["kp_idx"]))
        drawn = rng.sample(pool_sorted, min(n_wanted, len(pool_sorted)))
        for d in drawn:
            d["cell"] = cell
            d["item_id"] = f"{d['doc']}::{d['camp']}::{d['kp_idx']}"
        sample.extend(drawn)

    sample.sort(key=lambda r: (r["cell"], r["doc"], r["camp"], r["kp_idx"]))

    out = {
        "seed": SEED,
        "data_commit": data_commit,
        "n": len(sample),
        "n_wanted": sum(allocation.values()),
        "shortfalls": shortfalls,
        "items": sample,
    }
    (_HERE.parent / "sample.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")

    for sheet_name, rater_id in [("label_sheet_cl.json", "CL"), ("label_sheet_agent.json", "agent")]:
        sheet = {
            "rater": rater_id,
            "data_commit": data_commit,
            "seed": SEED,
            "instructions": "For each item: label 'correct'/'borderline'/'misfire'. "
                             "If not 'correct': better_node (a node id, or 'none found') and "
                             "cause ('retrieval-fixable' or 'taxonomy-structure'). "
                             "If the assigned node is part of a known contested/superseded "
                             "family, label against the family's current canonical member and "
                             "set family_scored: true.",
            "items": [
                {
                    "item_id": r["item_id"], "doc": r["doc"], "camp": r["camp"],
                    "point_text": r["point_text"], "attribution_text": r["attr"],
                    "assigned_node": r["node"], "assigned_node_label": r["node_label"],
                    "cell": r["cell"], "rank": r["rank"],
                    "label": None, "better_node": None, "cause": None, "family_scored": False,
                }
                for r in sample
            ],
        }
        (_HERE.parent / sheet_name).write_text(json.dumps(sheet, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"n={len(sample)} (wanted {sum(allocation.values())}), shortfalls: {shortfalls}")
    print("wrote sample.json, label_sheet_cl.json, label_sheet_agent.json")


if __name__ == "__main__":
    main()
