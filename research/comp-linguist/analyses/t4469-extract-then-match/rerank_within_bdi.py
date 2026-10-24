"""t/4469 -- cross-encoder rerank, restricted to the claim's BDI category.

t/2306 ruled ms-marco rerank NO-GO for default-ON because it promotes Beliefs
nodes to rank 1 across a mixed-BDI pool. In an extract-then-match design the
claim's BDI is classified first, so the pool is single-category and that bias
has nothing to act on. This tests whether rerank helps once the bias is removed.

Query = canonical_proposition (the field extract-then-match would match on).
Pool = same POV + same BDI. Bi-encoder top-15, then the cross-encoder
(cross-encoder/ms-marco-MiniLM-L-6-v2) reranks on "label: description".
Reference = the LLM-assigned node (not gold; see retrieval_ceiling.py).
Deterministic, so no replication gate (t/2306 reasoning).

Usage:  python rerank_within_bdi.py --data <ai-triad-data> [--out rerank_results.json]
"""
import argparse
import glob
import json
import os
import re

import numpy as np
from sentence_transformers import CrossEncoder, SentenceTransformer

POV_PREFIX = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp"}
NODE_RE = re.compile(r"^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$")
TOP_N = 15
KS = [1, 3, 5, 10, 15]


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default=os.path.join(here, "rerank_results.json"))
    args = ap.parse_args()

    emb = json.load(open(os.path.join(args.data, "taxonomy/Origin/embeddings.json"), encoding="utf-8"))
    ids = [n for n in emb["nodes"] if NODE_RE.match(n)]
    node_mat = np.asarray([emb["nodes"][n]["vector"] for n in ids], dtype=np.float32)
    node_mat /= np.linalg.norm(node_mat, axis=1, keepdims=True)
    idx = {n: i for i, n in enumerate(ids)}
    pov_of = np.array([n.split("-")[0] for n in ids])
    bdi_of = np.array([n.split("-")[1] for n in ids])

    node_text = {}
    for camp in POV_PREFIX:
        tax = json.load(open(os.path.join(args.data, f"taxonomy/Origin/{camp}.json"), encoding="utf-8"))
        for nd in tax["nodes"]:
            node_text[nd["id"]] = f"{nd.get('label', '')}: {nd.get('description', '')}"

    items = []
    for f in sorted(glob.glob(os.path.join(args.data, "summaries/*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        for camp, block in (d.get("pov_summaries") or {}).items():
            if camp not in POV_PREFIX or not isinstance(block, dict):
                continue
            for kp in block.get("key_points") or []:
                nid, cp = kp.get("taxonomy_node_id"), (kp.get("canonical_proposition") or "").strip()
                if nid in idx and cp and nid in node_text:
                    items.append((POV_PREFIX[camp], str(kp.get("category") or "").lower(), nid, cp))

    bi = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"), trust_remote_code=False)
    q = bi.encode([it[3] for it in items], normalize_embeddings=True, batch_size=128,
                  show_progress_bar=False).astype(np.float32)
    sims = q @ node_mat.T
    ce = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

    bi_rank, ce_rank, in_top = [], [], 0
    pairs, spans = [], []
    tops = []
    for i, (pov, bdi, nid, cp) in enumerate(items):
        pool = np.where((pov_of == pov) & (bdi_of == bdi))[0]
        order = pool[np.argsort(-sims[i][pool])][:TOP_N]
        cand = [ids[j] for j in order]
        tops.append(cand)
        spans.append((len(pairs), len(cand)))
        pairs.extend((cp, node_text[c]) for c in cand)
    scores = ce.predict(pairs, batch_size=256, show_progress_bar=False)

    for i, (pov, bdi, nid, cp) in enumerate(items):
        cand = tops[i]
        if nid not in cand:
            bi_rank.append(None)
            ce_rank.append(None)
            continue
        in_top += 1
        s, n = spans[i]
        reranked = [cand[k] for k in np.argsort(-np.asarray(scores[s:s + n]))]
        bi_rank.append(cand.index(nid) + 1)
        ce_rank.append(reranked.index(nid) + 1)

    def hits(rs):
        n = len(rs)
        return {f"hit@{k}": round(sum(1 for r in rs if r is not None and r <= k) / n, 4) for k in KS} | {
            "mrr@15": round(sum(1.0 / r for r in rs if r) / n, 4)}

    moved = [(b, c) for b, c in zip(bi_rank, ce_rank) if b is not None]
    res = {"n": len(items), "assigned_in_bi_top15": in_top, "top_n": TOP_N,
           "bi_encoder": hits(bi_rank), "cross_encoder": hits(ce_rank),
           "rank1_lost_by_rerank": sum(1 for b, c in moved if b == 1 and c != 1),
           "rank1_gained_by_rerank": sum(1 for b, c in moved if b != 1 and c == 1)}
    json.dump(res, open(args.out, "w", encoding="utf-8"), indent=2)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
