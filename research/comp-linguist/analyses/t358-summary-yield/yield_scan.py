#!/usr/bin/env python3
"""t/358: summary yield (facts, key points) vs document length, by pipeline path. Read-only, no AI calls.

Pipeline path is inferred from length: Invoke-DocumentSummary chunks only when len(snapshot)/4 > 20000
(scripts/AITriad/Private/Invoke-DocumentSummary.ps1:85), so <= 80k chars is the single-call path.
"""
import argparse
import collections
import glob
import json
import os
import re
import statistics


def kp_count(d):
    total = 0
    for v in (d.get("pov_summaries") or {}).values():
        if isinstance(v, dict):
            total += len(v.get("key_points") or [])
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--sources", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rows = []
    for f in glob.glob(os.path.join(a.data, "summaries", "*.json")):
        doc = os.path.basename(f)[:-5]
        snap = os.path.join(a.sources, doc, "snapshot.md")
        if not os.path.exists(snap):
            continue  # legacy -N chunk summaries have no source dir (t/355)
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        chars = len(re.sub(r"<!--.*?-->", "", open(snap, encoding="utf-8", errors="replace").read(), flags=re.S))
        mi = d.get("model_info") or {}
        rows.append({"doc": doc, "chars": chars, "facts": len(d.get("factual_claims") or []), "kps": kp_count(d),
                     "model": mi.get("model"), "mode": mi.get("extraction_mode"), "max_tokens": mi.get("max_tokens"),
                     "truncated": mi.get("truncated"), "chunked": chars / 4 > 20000,
                     "generated": (d.get("generated_at") or "")[:7]})
    json.dump(rows, open(a.out, "w", encoding="utf-8"), indent=1)

    def stats(rs, key):
        v = [r[key] for r in rs]
        return f"n={len(v):4d} median={statistics.median(v):5.1f} p25={sorted(v)[len(v)//4]:3d} p75={sorted(v)[3*len(v)//4]:3d}" if v else "n=0"

    bins = [(0, 10_000), (10_000, 30_000), (30_000, 80_000), (80_000, 160_000), (160_000, 10**9)]
    print("length bin (chars)        facts                                     key points")
    for lo, hi in bins:
        rs = [r for r in rows if lo <= r["chars"] < hi]
        print(f"{lo:>7}-{hi if hi < 10**9 else 'inf':>7}  {stats(rs, 'facts')}   {stats(rs, 'kps')}")
    print("\nby extraction_mode:", dict(collections.Counter(r["mode"] for r in rows)))
    print("by model:", dict(collections.Counter(r["model"] for r in rows).most_common(6)))
    print("truncated:", sum(1 for r in rows if r["truncated"]), "of", len(rows))
    big = [r for r in rows if r["chars"] >= 30_000]
    if big:
        dens = [(r["facts"] / (r["chars"] / 10_000), r) for r in big]
        print("facts per 10k chars, docs >= 30k: median %.2f" % statistics.median(d for d, _ in dens))
    for path in (False, True):
        rs = [r for r in rows if r["chunked"] == path and r["chars"] >= 30_000]
        print(f"{'chunked' if path else 'single-call'} (>=30k chars): facts {stats(rs, 'facts')} | kps {stats(rs, 'kps')}")


if __name__ == "__main__":
    main()
