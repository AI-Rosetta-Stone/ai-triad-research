#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/4551: decontextualization sample + claim->node MRR on the t/4507 debate batch.

The t/4507 50-debate pre-registered re-run (research/comp-linguist/analyses/t4507-tag-pilot-rerun/)
is the first debate-eval batch of 3+ debates run after the decontextualization prompt change
(t/4483, #3799) landed. This script:
  1. Pools every argument_network node's `text` (the debate's canonical_proposition) across the
     50 successful debates, blind-samples 20 (seed 4551), for hand labeling against the baseline
     classes in decontextualization-rule-spec.md.
  2. Computes claim->node MRR for every node with a populated `claim_taxonomy_attribution.primary_ref`,
     ranking the assigned node's cosine similarity against the same-POV candidate pool
     (all-MiniLM-L6-v2 space, same method as stage0_mrr.py / t/4434's SECONDARY arm). This is
     pipeline-assigned, not human-gold -- confounded toward self-consistency, direction only.

decontextualization-rule-spec.md section 3 (line 114) states this metric "needs re-run debates,
so it is reported from that batch, and not claimed before" -- there is no genuine pre-#3799 value
for this specific debate-MRR reading to compare against. This run establishes the first one.

Usage:  python build_sample_and_mrr.py
Writes sample.json, labels.json (template only -- hand-labeled afterward), mrr_results.json.
"""
import glob
import json
import random
import re

import numpy as np

SEED = 4551
DEBATES_DIR = r"C:/Users/jsnov/repos/ai-triad-data/debates/t4507-tag-pilot-rerun"
EMB_PATH = r"C:/Users/jsnov/repos/ai-triad-data/taxonomy/Origin/embeddings.json"
LEDGER_PATH = "../t4507-tag-pilot-rerun/ledger.json"
NODE_RE = re.compile(r"^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$")
POV_MAP = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp"}


def load_slugs():
    ledger = json.load(open(LEDGER_PATH, encoding="utf-8"))
    return sorted({x["slug"] for x in ledger["debates"] if x.get("status") == "ok"})


def load_pool(slugs):
    pool = []
    for slug in slugs:
        d = json.load(open(f"{DEBATES_DIR}/{slug}-debate.json", encoding="utf-8"))
        for n in d["argument_network"]["nodes"]:
            pool.append({"debate": slug, "node_id": n["id"], "text": n["text"], "speaker": n.get("speaker")})
    return pool


def main():
    slugs = load_slugs()
    pool = load_pool(slugs)
    print(f"pooled {len(pool)} AN nodes from {len(slugs)} debates")

    rng = random.Random(SEED)
    sample = rng.sample(pool, 20)
    json.dump(sample, open("sample.json", "w"), indent=2)

    emb = json.load(open(EMB_PATH, encoding="utf-8"))
    ids, vecs, povs = [], [], []
    for nid, rec in emb["nodes"].items():
        if NODE_RE.match(nid):
            ids.append(nid); vecs.append(rec["vector"]); povs.append(nid.split("-")[0])
    node_mat = np.asarray(vecs, dtype=np.float64)
    node_mat /= np.linalg.norm(node_mat, axis=1, keepdims=True)
    node_idx = {n: i for i, n in enumerate(ids)}
    povs = np.array(povs)

    items = []
    for slug in slugs:
        d = json.load(open(f"{DEBATES_DIR}/{slug}-debate.json", encoding="utf-8"))
        for n in d["argument_network"]["nodes"]:
            cta = n.get("claim_taxonomy_attribution") or {}
            ref = cta.get("primary_ref")
            if ref and ref in node_idx:
                v = n.get("attribution_embedding") or n.get("embedding")
                if v:
                    items.append({"slug": slug, "node_id": n["id"], "ref": ref, "speaker": n.get("speaker"), "vec": v})

    ranks = []
    for it in items:
        pov = POV_MAP.get(it["speaker"])
        if not pov:
            continue
        mask = povs == pov
        j = node_idx[it["ref"]]
        if not mask[j]:
            continue
        qv = np.asarray(it["vec"], dtype=np.float64)
        qv /= np.linalg.norm(qv)
        sims = node_mat @ qv
        rank = int((sims[mask] > sims[j]).sum()) + 1
        ranks.append(rank)

    ranks = np.asarray(ranks)
    n = len(ranks)
    out = {
        "n_attributed_total": len(items),
        "n_scored": n,
        "n_excluded_cross_pov_or_no_embedding": len(items) - n,
        "mrr": round(float(np.mean(1.0 / ranks)), 4),
        "hit1": round(float(np.mean(ranks <= 1)), 4),
        "hit5": round(float(np.mean(ranks <= 5)), 4),
        "median_rank": float(np.median(ranks)),
        "ranks": ranks.tolist(),
    }
    json.dump(out, open("mrr_results.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != "ranks"}, indent=2))


if __name__ == "__main__":
    main()
