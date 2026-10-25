"""t/4471 baseline: referent-heuristic rate and length of canonical_propositions and factual claims.

Draws the fixed 50+50 annotation sample (seed 4471) into sample.json. The CL's hand labels
for that sample are in labels.json.

Usage:  python scan.py --data <ai-triad-data>
"""
import argparse
import glob
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DEIX = re.compile(
    r"\b(this|these|that|those)\s+(policy|policies|approach|framework|proposal|paper|study|report|document|article|"
    r"bill|law|rule|regulation|model|system|technology|claim|argument|work|book|essay|author|authors|research|"
    r"analysis|effort|plan|act|measure|strategy|shift|trend|change|risk|issue|problem)\b"
    r"|\b(the|its)\s+(authors?|paper|study|report|document|article|essay|book|piece|writer|researchers)\b"
    r"|^(it|they|this|these|he|she|such)\b|\b(they|them|their)\b",
    re.I,
)


def stats(name, texts):
    hits = sum(1 for t in texts if DEIX.search(t))
    wc = sorted(len(t.split()) for t in texts)
    n = len(texts)
    print(name, "n=", n, "heuristic-hit", hits, round(hits / n, 3), "words median", wc[n // 2],
          "p90", wc[int(0.9 * n)], ">25:", round(sum(w > 25 for w in wc) / n, 3),
          ">30:", round(sum(w > 30 for w in wc) / n, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    args = ap.parse_args()
    kp, fc = [], []
    for f in sorted(glob.glob(os.path.join(args.data, "summaries", "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        for camp, b in (d.get("pov_summaries") or {}).items():
            if isinstance(b, dict):
                for k in b.get("key_points") or []:
                    c = (k.get("canonical_proposition") or "").strip()
                    if c:
                        kp.append((d["doc_id"], camp, k.get("category"), k.get("taxonomy_node_id"), c))
        for c in d.get("factual_claims") or []:
            t = (c.get("claim") or "").strip()
            if t:
                fc.append((d["doc_id"], c.get("claim_label"), t))
    stats("canonical_proposition", [x[4] for x in kp])
    stats("factual_claim.claim", [x[2] for x in fc])
    random.seed(4471)
    sample = {"kp": random.sample(kp, 50), "fc": random.sample(fc, 50)}
    json.dump(sample, open(os.path.join(HERE, "sample.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
