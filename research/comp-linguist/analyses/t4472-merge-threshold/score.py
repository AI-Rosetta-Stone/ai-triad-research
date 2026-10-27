"""t/4472: precision / recall / F1 of the semantic-dedup merge threshold, per pair type.

Joins labels.json (blind) to label_key.json (cosine, band) and population.json (pair counts per band).
Two estimates per threshold:
  sample    raw counts on the labelled pairs (n stated)
  weighted  each labelled pair weighted by (band population / band sample size), so P/R reflect the
            corpus mix rather than the flat stratified draw. Recall is relative to the >= 0.60 universe:
            pairs below 0.60 were not sampled.
Two truth definitions:
  strict    SAME only (merging loses no assertion; the t/4472 rubric)
  lenient   SAME + SUB (one side entails the other)

Usage: python score.py <dir>
"""
import json
import os
import sys
from collections import Counter

D = sys.argv[1] if len(sys.argv) > 1 else "."
labels = json.load(open(os.path.join(D, "labels.json"), encoding="utf-8"))["labels"]
key = json.load(open(os.path.join(D, "label_key.json"), encoding="utf-8"))
pop = json.load(open(os.path.join(D, "population.json"), encoding="utf-8"))
THRESHOLDS = [0.60, 0.70, 0.75, 0.80, 0.85, 0.88, 0.90, 0.92, 0.95]
TRUTH = {"strict": {"SAME"}, "lenient": {"SAME", "SUB"}}

out = {}
for kind in ("key_point", "factual_claim"):
    rows = [dict(id=i, cos=k["cos"], band=k["band"], label=labels[i]) for i, k in key.items() if k["kind"] == kind]
    per_band = Counter(r["band"] for r in rows)
    w = {b: pop[kind]["by_band"][b] / n for b, n in per_band.items()}
    band_tab = {}
    for b in sorted(per_band):
        c = Counter(r["label"] for r in rows if r["band"] == b)
        band_tab[b] = dict(n=per_band[b], population=pop[kind]["by_band"][b], **{k: c.get(k, 0) for k in ("SAME", "SUB", "CORE", "DIST")})
    res = {"bands": band_tab, "thresholds": {}}
    for tname, pos in TRUTH.items():
        for t in THRESHOLDS:
            s = Counter()
            wt = Counter()
            for r in rows:
                pred, true = r["cos"] >= t, r["label"] in pos
                cell = ("tp" if true else "fp") if pred else ("fn" if true else "tn")
                s[cell] += 1
                wt[cell] += w[r["band"]]

            def prf(c):
                p = c["tp"] / (c["tp"] + c["fp"]) if c["tp"] + c["fp"] else None
                rcl = c["tp"] / (c["tp"] + c["fn"]) if c["tp"] + c["fn"] else None
                f = 2 * p * rcl / (p + rcl) if p and rcl else 0.0
                return p, rcl, f

            sp, sr, sf = prf(s)
            wp, wr, wf = prf(wt)
            res["thresholds"][f"{tname}@{t:.2f}"] = dict(
                n=len(rows), predicted_merge=s["tp"] + s["fp"], positives=s["tp"] + s["fn"],
                tp=s["tp"], fp=s["fp"], fn=s["fn"],
                sample_P=None if sp is None else round(sp, 3), sample_R=None if sr is None else round(sr, 3), sample_F1=round(sf, 3),
                weighted_P=None if wp is None else round(wp, 3), weighted_R=None if wr is None else round(wr, 3), weighted_F1=round(wf, 3))
    out[kind] = res

json.dump(out, open(os.path.join(D, "results.json"), "w", encoding="utf-8"), indent=1)
for kind, res in out.items():
    print(f"\n== {kind}")
    for b, v in res["bands"].items():
        print(f"  {b}: {v}")
    for k, v in res["thresholds"].items():
        print(f"  {k:14s} tp={v['tp']:2d} fp={v['fp']:2d} fn={v['fn']:2d}  P={v['sample_P']} R={v['sample_R']} F1={v['sample_F1']}"
              f"  | wP={v['weighted_P']} wR={v['weighted_R']} wF1={v['weighted_F1']}")
