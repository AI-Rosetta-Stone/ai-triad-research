"""t/4469 -- retrieval-ceiling study for extract-then-match.

Question: if taxonomy mapping moved AFTER extraction (embed each extracted claim,
retrieve top-k nodes, let an LLM adjudicate among only those k), how often would
the node the current pipeline assigns even be inside the k shown to the adjudicator?

Reference = the LLM-assigned taxonomy_node_id in the existing corpus. This is NOT
gold: t/2341 adjudication (n=30 random, safetyist) judged ~67% correct, ~20%
borderline, ~13% clear misfire. Treat Hit@k here as recall of a mostly-correct
reference, and read it alongside that error band.

Deterministic (bi-encoder ranking), so the replication gate does not apply
(same reasoning as t/2306). Sample = every key_point that carries all four
query fields (point, verbatim, attribution_text, canonical_proposition) and an
assigned node present in embeddings.json -- a paired comparison across fields.

Usage:  python retrieval_ceiling.py [--data ../../../../ai-triad-data] [--out results.json]
"""
import argparse
import collections
import glob
import json
import os
import re

import numpy as np
from sentence_transformers import SentenceTransformer

POV_PREFIX = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp"}
FIELDS = ["canonical_proposition", "attribution_text", "verbatim", "point"]
KS = [1, 3, 5, 10, 15, 30, 50]
NODE_RE = re.compile(r"^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$")


def as_text(v):
    if isinstance(v, list):
        return " ".join(str(x) for x in v if x)
    return str(v or "").strip()


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--data", default=os.path.normpath(os.path.join(here, "../../../../ai-triad-data")))
    ap.add_argument("--out", default=os.path.join(here, "results.json"))
    args = ap.parse_args()

    emb = json.load(open(os.path.join(args.data, "taxonomy/Origin/embeddings.json"), encoding="utf-8"))
    ids, vecs = [], []
    for nid, rec in emb["nodes"].items():
        if NODE_RE.match(nid):
            ids.append(nid)
            vecs.append(rec["vector"])
    node_mat = np.asarray(vecs, dtype=np.float32)
    node_mat /= np.linalg.norm(node_mat, axis=1, keepdims=True)
    node_idx = {n: i for i, n in enumerate(ids)}
    node_pov = np.array([n.split("-")[0] for n in ids])
    node_bdi = np.array([n.split("-")[1] for n in ids])

    items = []
    skipped = collections.Counter()
    for f in sorted(glob.glob(os.path.join(args.data, "summaries/*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        for camp, block in (d.get("pov_summaries") or {}).items():
            if camp not in POV_PREFIX or not isinstance(block, dict):
                continue
            for kp in block.get("key_points") or []:
                nid = kp.get("taxonomy_node_id")
                if not nid:
                    skipped["no_node"] += 1
                    continue
                if nid not in node_idx:
                    skipped["node_not_in_embeddings"] += 1
                    continue
                texts = {fl: as_text(kp.get(fl)) for fl in FIELDS}
                if not all(texts.values()):
                    skipped["missing_field"] += 1
                    continue
                items.append({
                    "doc": d.get("doc_id"), "pov": POV_PREFIX[camp], "node": nid,
                    "kp_bdi": str(kp.get("category") or "").lower(), "texts": texts,
                })

    model = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"), trust_remote_code=False)
    qv = {}
    for fl in FIELDS:
        qv[fl] = model.encode([it["texts"][fl] for it in items], normalize_embeddings=True,
                              batch_size=128, show_progress_bar=False).astype(np.float32)

    def ranks(field, pool):
        out = []
        sims = qv[field] @ node_mat.T
        for i, it in enumerate(items):
            mask = node_pov == it["pov"]
            if pool == "pov+bdi":
                mask = mask & (node_bdi == it["kp_bdi"])
            j = node_idx[it["node"]]
            if not mask[j]:
                out.append(None)  # unreachable: pool excludes the assigned node
                continue
            s = sims[i]
            out.append(int((s[mask] > s[j]).sum()) + 1)
        return out

    def summarize(rs):
        n = len(rs)
        reach = [r for r in rs if r is not None]
        res = {"n": n, "unreachable": n - len(reach),
               "mrr": round(sum(1.0 / r for r in reach) / n, 4),
               "median_rank": float(np.median(reach)) if reach else None}
        for k in KS:
            res[f"hit@{k}"] = round(sum(1 for r in reach if r <= k) / n, 4)
        return res

    pool_sizes = collections.Counter()
    for p in POV_PREFIX.values():
        pool_sizes[p] = int((node_pov == p).sum())

    results = {"n_items": len(items), "n_docs": len({it["doc"] for it in items}),
               "skipped": dict(skipped), "pool_sizes": dict(pool_sizes),
               "bdi_agreement": round(sum(1 for it in items if it["node"].split("-")[1] == it["kp_bdi"]) / len(items), 4),
               "by_field": {}, "by_pov_canonical": {}}
    for fl in FIELDS:
        results["by_field"][fl] = {pool: summarize(ranks(fl, pool)) for pool in ("pov", "pov+bdi")}
    for p in POV_PREFIX.values():
        sel = [i for i, it in enumerate(items) if it["pov"] == p]
        rs = ranks("canonical_proposition", "pov+bdi")
        results["by_pov_canonical"][p] = summarize([rs[i] for i in sel])

    json.dump(results, open(args.out, "w", encoding="utf-8"), indent=2)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
