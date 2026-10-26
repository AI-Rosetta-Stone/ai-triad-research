"""t/4471 after-measurement: compare the re-extracted (post-#3802) summaries with the corpus originals
for the same documents.

Reports, old vs new, on the same docs:
  - heuristic outward-reference rate (same DEIX regex as scan.py) for canonical_proposition and factual claims
  - length of canonical_proposition
  - anchors presence and contents (new only)
  - Hit@5 / Hit@30 of each version's own assigned node, canonical_proposition query, POV+BDI pool
And dumps every new canonical_proposition / anchors / factual claim for CL hand annotation.

Usage: python after_measure.py <old_data_root> <new_data_root> <docs.txt> <out_dir>
"""
import json
import os
import re
import sys

import numpy as np
from sentence_transformers import SentenceTransformer

OLD, NEW, DOCS, OUT = sys.argv[1:5]
DEIX = re.compile(
    r"\b(this|these|that|those)\s+(policy|policies|approach|framework|proposal|paper|study|report|document|article|"
    r"bill|law|rule|regulation|model|system|technology|claim|argument|work|book|essay|author|authors|research|"
    r"analysis|effort|plan|act|measure|strategy|shift|trend|change|risk|issue|problem)\b"
    r"|\b(the|its)\s+(authors?|paper|study|report|document|article|essay|book|piece|writer|researchers|organization|company)\b"
    r"|^(it|they|this|these|he|she|such)\b|\b(they|them|their)\b",
    re.I,
)
POV = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp"}
NODE_RE = re.compile(r"^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$")
docs = [d.strip() for d in open(DOCS, encoding="utf-8") if d.strip()]


def load(root):
    kps, fcs = [], []
    for d in docs:
        p = os.path.join(root, "summaries", f"{d}.json")
        if not os.path.exists(p):
            continue
        s = json.load(open(p, encoding="utf-8"))
        for camp, b in (s.get("pov_summaries") or {}).items():
            if camp in POV and isinstance(b, dict):
                for k in b.get("key_points") or []:
                    kps.append(dict(doc=d, pov=POV[camp], bdi=str(k.get("category") or "").lower(),
                                    node=k.get("taxonomy_node_id"), cp=(k.get("canonical_proposition") or "").strip(),
                                    anchors=k.get("anchors")))
        for c in s.get("factual_claims") or []:
            fcs.append(dict(doc=d, claim=(c.get("claim") or "").strip()))
    return kps, fcs


emb = json.load(open(os.path.join(OLD, "taxonomy", "Origin", "embeddings.json"), encoding="utf-8"))
ids = [n for n in emb["nodes"] if NODE_RE.match(n)]
mat = np.asarray([emb["nodes"][n]["vector"] for n in ids], dtype=np.float32)
mat /= np.linalg.norm(mat, axis=1, keepdims=True)
idx = {n: i for i, n in enumerate(ids)}
model = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"), trust_remote_code=False)


def hits(kps):
    ok = [k for k in kps if k["cp"] and k["node"] in idx and k["bdi"] in ("beliefs", "desires", "intentions")]
    if not ok:
        return {"n": 0}
    q = model.encode([k["cp"] for k in ok], normalize_embeddings=True, show_progress_bar=False)
    ranks = []
    for k, v in zip(ok, q):
        pool = [i for i, n in enumerate(ids) if n.startswith(f"{k['pov']}-{k['bdi']}-")]
        s = mat[pool] @ v
        j = pool.index(idx[k["node"]])
        ranks.append(int((s > s[j]).sum()) + 1)
    n = len(ranks)
    return {"n": n, "hit@5": round(sum(r <= 5 for r in ranks) / n, 3), "hit@30": round(sum(r <= 30 for r in ranks) / n, 3)}


def summary(kps, fcs, new):
    cps = [k["cp"] for k in kps if k["cp"]]
    out = {
        "n_kp": len(kps), "n_cp": len(cps), "n_fc": len(fcs),
        "cp_heuristic_outward": round(sum(bool(DEIX.search(c)) for c in cps) / max(1, len(cps)), 3),
        "fc_heuristic_outward": round(sum(bool(DEIX.search(f["claim"])) for f in fcs) / max(1, len(fcs)), 3),
        "cp_words_median": float(np.median([len(c.split()) for c in cps])) if cps else None,
        "retrieval": hits(kps),
    }
    if new:
        with_field = [k for k in kps if isinstance(k["anchors"], list)]
        nonempty = [k for k in with_field if k["anchors"]]
        out["anchors_field_present"] = f"{len(with_field)}/{len(kps)}"
        out["anchors_nonempty"] = len(nonempty)
    return out


ok_, of_ = load(OLD)
nk, nf = load(NEW)
res = {"docs": len(docs), "old": summary(ok_, of_, False), "new": summary(nk, nf, True)}
os.makedirs(OUT, exist_ok=True)
json.dump(res, open(os.path.join(OUT, "after_results.json"), "w", encoding="utf-8"), indent=2)
json.dump({"kp": nk, "fc": nf}, open(os.path.join(OUT, "after_items.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(json.dumps(res, indent=2))
