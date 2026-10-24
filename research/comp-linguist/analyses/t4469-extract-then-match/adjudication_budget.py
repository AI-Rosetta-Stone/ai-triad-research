"""t/4469 -- taxonomy-token budget of a batched adjudication pass.

Extract-then-match's pass 3 shows an LLM [claim + top-k candidates]. Batched per
document, the prompt carries the union of every claim's top-k. This measures that
union's size per document (POV + BDI pools, canonical_proposition query) and
compares it with what the current pipeline already puts in the extraction prompt
(model_info.taxonomy_nodes: 40 for single-call RAG, up to 150 per chunk).

Usage:  python adjudication_budget.py --data <ai-triad-data> [--out budget_results.json]
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
NODE_RE = re.compile(r"^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$")
KS = [5, 15, 30]


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default=os.path.join(here, "budget_results.json"))
    args = ap.parse_args()

    emb = json.load(open(os.path.join(args.data, "taxonomy/Origin/embeddings.json"), encoding="utf-8"))
    ids = [n for n in emb["nodes"] if NODE_RE.match(n)]
    node_mat = np.asarray([emb["nodes"][n]["vector"] for n in ids], dtype=np.float32)
    node_mat /= np.linalg.norm(node_mat, axis=1, keepdims=True)
    pov_of = np.array([n.split("-")[0] for n in ids])
    bdi_of = np.array([n.split("-")[1] for n in ids])

    items, prompt_nodes = [], {}
    for f in sorted(glob.glob(os.path.join(args.data, "summaries/*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        doc = d.get("doc_id")
        mi = d.get("model_info") or {}
        for camp, block in (d.get("pov_summaries") or {}).items():
            if camp not in POV_PREFIX or not isinstance(block, dict):
                continue
            for kp in block.get("key_points") or []:
                cp = (kp.get("canonical_proposition") or "").strip()
                bdi = str(kp.get("category") or "").lower()
                if cp and bdi in ("beliefs", "desires", "intentions"):
                    items.append((doc, POV_PREFIX[camp], bdi, cp))
                    prompt_nodes[doc] = (mi.get("taxonomy_nodes"), mi.get("chunk_count") or 1)

    bi = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"), trust_remote_code=False)
    q = bi.encode([it[3] for it in items], normalize_embeddings=True, batch_size=128,
                  show_progress_bar=False).astype(np.float32)
    sims = q @ node_mat.T

    unions = {k: collections.defaultdict(set) for k in KS}
    claims_per_doc = collections.Counter()
    for i, (doc, pov, bdi, _) in enumerate(items):
        claims_per_doc[doc] += 1
        pool = np.where((pov_of == pov) & (bdi_of == bdi))[0]
        order = pool[np.argsort(-sims[i][pool])]
        for k in KS:
            unions[k][doc].update(ids[j] for j in order[:k])

    def dist(xs):
        xs = np.asarray(sorted(xs))
        return {"n": int(len(xs)), "median": float(np.median(xs)), "p90": float(np.percentile(xs, 90)),
                "mean": round(float(xs.mean()), 1)}

    res = {"n_docs": len(claims_per_doc), "n_claims": len(items),
           "claims_per_doc": dist(list(claims_per_doc.values())),
           "candidate_slots_per_doc_unbatched": {f"k={k}": dist([c * k for c in claims_per_doc.values()]) for k in KS},
           "union_nodes_per_doc": {f"k={k}": dist([len(s) for s in unions[k].values()]) for k in KS},
           "current_prompt_nodes_per_doc": dist([(t or 0) * c for t, c in prompt_nodes.values() if t])}
    json.dump(res, open(args.out, "w", encoding="utf-8"), indent=2)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
