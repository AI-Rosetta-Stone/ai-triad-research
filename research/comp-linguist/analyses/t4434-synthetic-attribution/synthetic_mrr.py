#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/4434 AC2 step 1: synthetic statements vs description vector as a claim-attribution surface.

Pre-registered in RESULTS.md (committed before this ran). Datasets and arm A mirror
analyses/stage0-composition-mrr/stage0_mrr.py (t/2440) so A reproduces its numbers.

Usage:  AI_TRIAD_DATA_ROOT=<data-repo> python synthetic_mrr.py
Writes results.json and qualitative.json next to this file.
"""
import glob
import importlib.util
import json
import os
import random
import sys
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[4]
RESEARCH = _REPO / "research" / "comp-linguist"
SEED = 4434
LEAK_COS = 0.98


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
_POV = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp", "situations": "sit"}


def load_nodes():
    allnodes, by_pov = [], {}
    for p in sorted(glob.glob(str(ORIGIN / "*.json"))):
        b = os.path.basename(p)
        if b in et.SKIP_FILES or b.startswith("embeddings-"):
            continue
        try:
            d = json.loads(Path(p).read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            continue
        pov = _POV.get(b[:-5].lower(), b[:-5].lower())
        for n in d.get("nodes", []):
            if isinstance(n, dict) and isinstance(n.get("id"), str):
                allnodes.append(n)
                by_pov.setdefault(pov, []).append(n["id"])
    return allnodes, by_pov


def load_synthetic(model):
    """Per node: (statement texts, unit vectors). Row alignment rebuilt as generate_corpus.py
    export-embeddings does (non-pruned entries, grouped by sorted node id, entry order), and
    verified against index counts and by re-encoding a sample of rows."""
    syn, meta = {}, {}
    rng = random.Random(SEED)
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
                raise SystemExit(f"alignment mismatch {pov} {nid}: index={ix} rebuilt=({offset},{n})")
            syn[nid] = (by_node[nid], emb[offset:offset + n])
            offset += n
        if offset != emb.shape[0]:
            raise SystemExit(f"alignment mismatch {pov}: rows {emb.shape[0]} vs rebuilt {offset}")
        rows = rng.sample(range(emb.shape[0]), 20)
        flat = [s for nid in sorted(by_node) for s in by_node[nid]]
        re = model.encode([flat[r] for r in rows], normalize_embeddings=True, show_progress_bar=False)
        agree = float(np.min(np.sum(re * emb[rows], axis=1)))
        meta[pov] = {"file_generated_at": corpus.get("generated_at"), "models": corpus.get("models"),
                     "entries": len(corpus["entries"]), "rows": int(emb.shape[0]), "nodes": len(by_node),
                     "spot_check_min_cos_20_rows": round(agree, 5),
                     "entry_timestamp_range": [min(e.get("generation_timestamp", "") for e in corpus["entries"]),
                                               max(e.get("generation_timestamp", "") for e in corpus["entries"])]}
        if agree < 0.999:
            raise SystemExit(f"row alignment spot-check failed for {pov}: min cos {agree}")
    return syn, meta


def main():
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")
    allnodes, by_pov = load_nodes()
    ids = [n["id"] for n in allnodes]
    idx_of = {nid: i for i, nid in enumerate(ids)}

    et.TAXONOMY_DIR = ORIGIN
    try:
        lineage_map = et._load_lineage_categories()
    except Exception:
        lineage_map = {}
    desc_text = [et._compose_field_texts(n, lineage_map)[0] for n in allnodes]
    A = np.asarray(model.encode(desc_text, normalize_embeddings=False, show_progress_bar=False), dtype=np.float64)
    nn = np.linalg.norm(A, axis=1, keepdims=True); nn[nn == 0] = 1.0
    A /= nn

    syn, syn_meta = load_synthetic(model)

    gs = {(c.get("debate_id"), c["claim_id"]): c
          for c in json.loads((RESEARCH / "_golden_test_set.json").read_text(encoding="utf-8"))["claims"]}
    gv = json.loads((RESEARCH / "_golden_validation_results.json").read_text(encoding="utf-8"))["results"]
    primary = []
    for r in gv:
        v = r["verdict"]; key = (r.get("debate_id"), r["claim_id"])
        gold = r.get("original_node") if v == "correct" else (r.get("corrected_node") if v == "incorrect" else None)
        if gold and gold in idx_of and key in gs:
            primary.append((gs[key]["claim_text"], gs[key]["pov"], gold))
    secondary = [(c["claim_text"], c["pov"], c["attributed_node"]) for c in gs.values()
                 if c.get("attributed_node") in idx_of]

    # Leakage: any statement with cos >= LEAK_COS to any golden claim (either set).
    all_claims = sorted({d[0] for d in primary + secondary})
    CQ = np.asarray(model.encode(all_claims, normalize_embeddings=True, show_progress_bar=False), dtype=np.float64)
    leaked = {}
    for nid, (texts, V) in syn.items():
        hit = np.where((V @ CQ.T).max(axis=1) >= LEAK_COS)[0]
        if len(hit):
            leaked[nid] = set(int(h) for h in hit)

    def scores_for(qv, cand, drop_leaked):
        a = A[[idx_of[c] for c in cand]] @ qv
        b, c3 = a.copy(), a.copy()
        for j, nid in enumerate(cand):
            s = syn.get(nid)
            if not s:
                continue
            V = s[1]
            if drop_leaked and nid in leaked:
                keep = [k for k in range(len(V)) if k not in leaked[nid]]
                if not keep:
                    continue
                V = V[keep]
            sims = V @ qv
            b[j] = sims.max()
            c3[j] = np.sort(sims)[-3:].mean()
        return {"A": a, "B": b, "C": c3, "D": np.maximum(a, b)}

    def ranks(dataset, scope, drop_leaked=False):
        Q = np.asarray(model.encode([d[0] for d in dataset], normalize_embeddings=True, show_progress_bar=False), dtype=np.float64)
        out = {k: [] for k in "ABCD"}; cov = []
        for i, (_, pov, gold) in enumerate(dataset):
            cand = by_pov.get(pov, []) if scope == "same-pov" else ids
            if gold not in cand:
                continue
            cov.append(sum(1 for c in cand if c in syn) / len(cand))
            for k, s in scores_for(Q[i], cand, drop_leaked).items():
                g = s[cand.index(gold)]
                out[k].append(int((s > g).sum()) + 1)
        return out, (float(np.mean(cov)) if cov else 0.0)

    def summarize(rk):
        r = np.asarray(rk, dtype=float)
        return {"n": len(r), "MRR": round(float(np.mean(1 / r)), 4), "Hit@1": round(float(np.mean(r <= 1)), 3),
                "Hit@5": round(float(np.mean(r <= 5)), 3), "Hit@10": round(float(np.mean(r <= 10)), 3)}

    def boot(ra, rb):
        a, b = 1 / np.asarray(ra, float), 1 / np.asarray(rb, float)
        rng = np.random.default_rng(SEED); n = len(a)
        idx = rng.integers(0, n, size=(10000, n))
        d = (b[idx] - a[idx]).mean(axis=1)
        return [round(float(np.percentile(d, 2.5)), 4), round(float(np.percentile(d, 97.5)), 4)]

    results = {"synthetic_meta": syn_meta, "leakage": {"threshold": LEAK_COS, "nodes": len(leaked),
               "statements": sum(len(v) for v in leaked.values())}, "views": {}}
    views = [("PRIMARY same-POV (registered)", primary, "same-pov"),
             ("PRIMARY all-node (sensitivity)", primary, "all"),
             ("SECONDARY same-POV (confounded toward A)", secondary, "same-pov")]
    for drop in ([False, True] if leaked else [False]):
        for label, ds, scope in views:
            rk, cov = ranks(ds, scope, drop)
            key = label + (" | leaked statements removed" if drop else "")
            v = {"synthetic_coverage_of_pool": round(cov, 3), "arms": {k: summarize(rk[k]) for k in "ABCD"}}
            for k in "BCD":
                v["arms"][k]["dMRR_vs_A"] = round(v["arms"][k]["MRR"] - v["arms"]["A"]["MRR"], 4)
                v["arms"][k]["dMRR_CI95"] = boot(rk["A"], rk[k])
            results["views"][key] = v

    # Qualitative: 20 SECONDARY claims, gold node's best statement vs arm-B top-1.
    rng = random.Random(SEED)
    qual = []
    for (claim, pov, gold) in rng.sample(secondary, 20):
        qv = model.encode([claim], normalize_embeddings=True, show_progress_bar=False)[0].astype(np.float64)
        cand = by_pov.get(pov, [])
        best = None
        for nid in cand:
            s = syn.get(nid)
            if not s:
                continue
            sims = s[1] @ qv; j = int(np.argmax(sims))
            if best is None or sims[j] > best[0]:
                best = (float(sims[j]), nid, s[0][j])
        g = syn.get(gold)
        gb = None
        if g:
            sims = g[1] @ qv; j = int(np.argmax(sims)); gb = {"cos": round(float(sims[j]), 3), "statement": g[0][j]}
        qual.append({"claim": claim, "gold": gold, "gold_best_statement": gb,
                     "argB_top1": {"node": best[1], "cos": round(best[0], 3), "statement": best[2]} if best else None,
                     "argB_top1_is_gold": bool(best and best[1] == gold)})

    (_HERE.parent / "results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    (_HERE.parent / "qualitative.json").write_text(json.dumps(qual, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
