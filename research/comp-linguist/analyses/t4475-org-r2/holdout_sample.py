"""t/4545 held-out sampler for the org endorsement gate (rules in HOLDOUT-PREREG.md). Read-only on data.

Draws the held-out proposals from `organization_edges.json` and writes a BLIND label sheet: the org, the
node's core proposition and the proposal's supporting claims. It never shows the gate's tag, its reason,
the cosine or the edge type.

Eligible = a `proposed` edge whose (org, node) is not one of the 29 development proposals, and whose every
supporting claim (the org's claims from the edge's source documents) was extracted after the development
cutoff. Prints the counts and exits 2 when nothing is eligible (the current corpus: blocked on new claims).

Usage (from the repo root):
  python research/comp-linguist/analyses/t4475-org-r2/holdout_sample.py [--data <ai-triad-data>] [--out <dir>]
"""
import argparse, json, os, random, re, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DEV_CUTOFF = "2026-07-12"        # last write of the 81 development claims
SEED, SAMPLE_N = 4545, 40
BANDS = [(0.60, 0.65), (0.65, 0.70), (0.70, 9.0)]
COS = re.compile(r"best_cosine=([0-9.]+)")


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def core_prop(node):
    """Label plus the Core description, Encompasses/Excludes stripped (the gate's node_prop construction)."""
    desc = re.split(r"\b(?:Encompasses|Excludes)\b", node.get("description", ""))[0].strip()
    return f"{node.get('label', '')}: {desc}".strip(": ")


def band_of(cos):
    for lo, hi in BANDS:
        if lo <= cos < hi:
            return f"[{lo:.2f},{hi:.2f})" if hi < 9 else f">={lo:.2f}"
    return "below-threshold"


def eligible_proposals(edges, claims, dev_pairs):
    out, reasons = [], defaultdict(int)
    for e in edges:
        if e.get("status") != "proposed":
            continue
        pair = (e.get("source"), e.get("target"))
        if pair in dev_pairs:
            reasons["development (one of the 29)"] += 1; continue
        docs = set(e.get("source_refs") or [])
        support = [c for c in claims if c.get("org_id") == pair[0] and c.get("source_id") in docs]
        if not support:
            reasons["no supporting claims found"] += 1; continue
        if any(str(c.get("extracted_at", ""))[:10] <= DEV_CUTOFF for c in support):
            reasons["rests on a development-era claim"] += 1; continue
        m = COS.search(e.get("rationale", ""))
        out.append({"org": pair[0], "node": pair[1], "cos": float(m.group(1)) if m else None, "support": support})
    return out, dict(reasons)


def stratified(items, n, seed):
    if len(items) <= n:
        return list(items)
    rng = random.Random(seed)
    strata = defaultdict(list)
    for it in items:
        strata[(it["org"], band_of(it["cos"] or 0))].append(it)
    picks = []
    for key in sorted(strata):  # minimum 1 per non-empty stratum, then proportional
        rng.shuffle(strata[key]); picks.append(strata[key].pop())
    rest = [it for key in sorted(strata) for it in strata[key]]
    rng.shuffle(rest)
    return picks + rest[: max(0, n - len(picks))]


def default_data_root():
    """$AI_TRIAD_DATA_ROOT, else the nearest ancestor's sibling `ai-triad-data` (works from a worktree too)."""
    env = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env:
        return env
    d = HERE
    while True:
        cand = os.path.join(os.path.dirname(d), "ai-triad-data")
        if os.path.isdir(os.path.join(cand, "taxonomy")):
            return cand
        if os.path.dirname(d) == d:
            return cand
        d = os.path.dirname(d)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=default_data_root())
    ap.add_argument("--out", default=HERE)
    a = ap.parse_args()
    t = os.path.join(a.data, "taxonomy", "Origin")
    edges = load(os.path.join(t, "organization_edges.json"))
    edges = edges.get("edges", edges) if isinstance(edges, dict) else edges
    claims = load(os.path.join(t, "organization_stance_claims.json"))["claims"]
    dev_pairs = {(p["source"], p["target"]) for p in load(os.path.join(HERE, "proposals.json"))}
    nodes = {}
    for f in ("accelerationist.json", "safetyist.json", "skeptic.json"):
        for n in load(os.path.join(t, f))["nodes"]:
            nodes[n["id"]] = n

    items, skipped = eligible_proposals(edges, claims, dev_pairs)
    print(f"proposed edges: {sum(1 for e in edges if e.get('status') == 'proposed')}; eligible: {len(items)}; "
          f"excluded: {skipped or 'none'}")
    if not items:
        print("BLOCKED: no eligible held-out proposals. New org claims are needed (HOLDOUT-PREREG.md).")
        return 2

    sample = stratified(items, SAMPLE_N, SEED)
    sheet = []
    for i, it in enumerate(sorted(sample, key=lambda x: (x["org"], x["node"])), 1):
        node = nodes.get(it["node"], {})
        sheet.append({
            "id": f"H{i:02d}", "org": it["org"], "node": it["node"],
            "node_prop": core_prop(node),
            "claims": [c.get("canonical_proposition") or c.get("text") for c in it["support"]],
            "label": None,  # Y | P | N, per the labels.json rubric; filled in BEFORE the gate runs
        })
    path = os.path.join(a.out, "holdout_sheet.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"_rubric": load(os.path.join(HERE, "labels.json"))["_rubric"],
                   "_note": "Blind label sheet (t/4545). Commit the filled labels before running the gate.",
                   "items": sheet}, fh, indent=1, ensure_ascii=False)
    print(f"wrote {len(sheet)} items to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
