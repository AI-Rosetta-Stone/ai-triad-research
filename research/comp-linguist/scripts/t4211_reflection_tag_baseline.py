"""t/4211 baseline: classify Skeptic post-debate reflection edits by the target node's CURRENT pov_tags.

Read-only. Reports, for every Skeptic reflection edit that names an existing node, which tag class the
target falls in today (critical-only, institutional-only, both, untagged), split by edit type. It also
counts debates whose seats were tagged (`seat_tags`), which is the population the t/4211 rule mainly
protects.

Usage:
    python research/comp-linguist/scripts/t4211_reflection_tag_baseline.py [--data <ai-triad-data root>]

The data root defaults to $AI_TRIAD_DATA_ROOT, then ../ai-triad-data next to this repo.
"""
import argparse
import collections
import glob
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def data_root(arg):
    if arg:
        return arg
    env = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env:
        return env
    return os.path.join(os.path.dirname(REPO), "ai-triad-data")


def tag_class(tags):
    if not tags:
        return "untagged"
    if len(tags) > 1:
        return "both"
    return f"{tags[0]}-only"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", help="ai-triad-data root")
    root = data_root(ap.parse_args().data)

    skp_path = os.path.join(root, "taxonomy", "Origin", "skeptic.json")
    if not os.path.exists(skp_path):
        print(f"ERROR: {skp_path} not found. Pass --data or set AI_TRIAD_DATA_ROOT.", file=sys.stderr)
        return 2
    with open(skp_path, encoding="utf-8") as fh:
        skp = json.load(fh)
    nodes = skp["nodes"] if isinstance(skp, dict) else skp
    tags = {n["id"]: tuple(sorted(n.get("pov_tags") or [])) for n in nodes}

    node_dist = collections.Counter(tag_class(t) for t in tags.values())
    by_class = collections.Counter()
    by_type = collections.defaultdict(collections.Counter)
    missing = unreadable = debates_with_edits = tagged_debates = 0

    for f in glob.glob(os.path.join(root, "debates", "debate-*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            unreadable += 1
            continue
        if d.get("seat_tags"):
            tagged_debates += 1
        hit = False
        for entry in d.get("transcript", []):
            if entry.get("type") != "reflection":
                continue
            for result in (entry.get("metadata") or {}).get("reflection_results") or []:
                if result.get("pover") != "skeptic":
                    continue
                for edit in result.get("edits") or []:
                    nid = edit.get("node_id")
                    if not nid:
                        continue
                    if nid not in tags:
                        missing += 1
                        continue
                    hit = True
                    c = tag_class(tags[nid])
                    by_class[c] += 1
                    by_type[(edit.get("edit_type") or "").lower()][c] += 1
        debates_with_edits += hit

    n = sum(by_class.values())
    print(f"Skeptic nodes by tag class (n={len(tags)}): {dict(node_dist)}")
    print(f"Debates with seat_tags: {tagged_debates}")
    print(f"Debates with Skeptic edits to existing nodes: {debates_with_edits}")
    print(f"Skeptic edits by target class (n={n}; {missing} name a node no longer present; "
          f"{unreadable} unreadable files):")
    for c, k in sorted(by_class.items(), key=lambda kv: -kv[1]):
        print(f"  {c:20s} {k:4d}  {k / n:.0%}")
    for t, counter in sorted(by_type.items()):
        print(f"  edit_type={t}: {dict(counter)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
