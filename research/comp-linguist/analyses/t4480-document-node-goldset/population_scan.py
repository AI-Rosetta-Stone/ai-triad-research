#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/4480 PREREG support: population scan for the document key_point gold-set strata.

Computes, for every document key_point with a taxonomy_node_id and attribution_text,
the assigned node's retrieval rank within the SAME pool and query field as production
(Invoke-RetrievalConfidencePass.ps1): all non-pillar nodes across every POV, cosine
against attribution_text. This is a uniform recompute, not a read of the stored
retrieval_confidence/taxonomy_node_candidates fields (those exist for only ~11% of
key_points -- a non-random subset -- so a stratified sample built on them would be
biased toward whichever batch was reprocessed under t/2288).

Sanity check: for the ~1,565 key_points that already carry retrieval_confidence,
recomputed rank-1 should match (assigned node has the highest recomputed score)
whenever the stored confidence is itself the max in taxonomy_node_candidates.

Usage:  AI_TRIAD_DATA_ROOT=<data-repo> python population_scan.py
Writes population.json next to this file.
"""
import glob
import json
import os
import re
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[4]
RANK_BANDS = [(1, 1, "1"), (2, 5, "2-5"), (6, 30, "6-30"), (31, None, ">30")]
PILLAR_RE = re.compile(r"(?i)^\s*a thematic pillar\b")


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


def main():
    from sentence_transformers import SentenceTransformer

    emb = json.loads((DATA_ROOT / "taxonomy/Origin/embeddings.json").read_text(encoding="utf-8"))
    node_pov_map = json.loads((DATA_ROOT / "taxonomy/Origin/embeddings.json").read_text(encoding="utf-8"))

    # Load node descriptions (for pillar exclusion) from the four POV files.
    pillar_ids = set()
    bdi_of = {}
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

    ids, vecs, povs = [], [], []
    for nid, rec in emb["nodes"].items():
        if nid in pillar_ids:
            continue
        ids.append(nid)
        vecs.append(rec["vector"])
        povs.append(nid.split("-")[0])
    node_mat = np.asarray(vecs, dtype=np.float64)
    node_mat /= np.linalg.norm(node_mat, axis=1, keepdims=True)
    node_idx = {n: i for i, n in enumerate(ids)}
    povs = np.array(povs)

    items = []
    skipped = {"no_node": 0, "node_excluded_or_missing": 0, "no_attribution_text": 0}
    for f in sorted(glob.glob(str(DATA_ROOT / "summaries" / "*.json"))):
        try:
            d = json.loads(Path(f).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for camp, block in (d.get("pov_summaries") or {}).items():
            if not isinstance(block, dict):
                continue
            for kp in block.get("key_points") or []:
                nid = kp.get("taxonomy_node_id")
                if not nid:
                    skipped["no_node"] += 1
                    continue
                if nid not in node_idx:
                    skipped["node_excluded_or_missing"] += 1
                    continue
                attr = str(kp.get("attribution_text") or "").strip()
                if not attr:
                    skipped["no_attribution_text"] += 1
                    continue
                items.append({
                    "doc": d.get("doc_id"), "pov": nid.split("-")[0], "node": nid,
                    "bdi": bdi_of.get(nid, "?"), "attr": attr,
                    "stored_conf": kp.get("retrieval_confidence"),
                })

    model = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"))
    Q = np.asarray(model.encode([it["attr"] for it in items], normalize_embeddings=True,
                                 batch_size=128, show_progress_bar=False), dtype=np.float64)
    sims = Q @ node_mat.T  # (n_items, n_nodes), global pool per production's Invoke-RetrievalConfidencePass

    strata = {}
    sanity_checked, sanity_matched = 0, 0
    for i, it in enumerate(items):
        j = node_idx[it["node"]]
        s = sims[i]
        rank = int((s > s[j]).sum()) + 1
        band = band_for(rank)
        key = (it["pov"], it["bdi"], band)
        strata.setdefault(key, []).append((it["doc"], it["node"]))
        if it["stored_conf"] is not None:
            sanity_checked += 1
            if abs(float(it["stored_conf"]) - float(s[j])) < 0.01:
                sanity_matched += 1

    out = {
        "n_items": len(items),
        "skipped": skipped,
        "sanity_check": {"n_with_stored_confidence": sanity_checked,
                          "n_matching_within_0.01": sanity_matched},
        "rank_bands": [b[2] for b in RANK_BANDS],
        "strata_population": {f"{p}|{bdi}|{band}": len(v) for (p, bdi, band), v in sorted(strata.items())},
    }
    out_path = Path(__file__).parent / "population.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in out.items() if k != "strata_population"}, indent=2))
    print(f"{len(strata)} non-empty strata cells; wrote {out_path.name}")


if __name__ == "__main__":
    main()
