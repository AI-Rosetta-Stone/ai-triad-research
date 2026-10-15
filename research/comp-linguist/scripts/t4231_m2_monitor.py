"""t/4231 (t/4211 spec §6 M2): monitor live Skeptic reflection edits under the custodian gate.

Read-only. Counts only edits that carry a `tag_check` stamp, so they ran through the live gate (#3307 onward),
and reports, per seat tag (untagged / critical / institutional), each with its n:
  - the relation distribution;
  - the worst-verdict shares: foreign, conflict, tension, unchecked, consistent;
  - decisions (applied / dismissed / overridden / pending) and the cross-tag override rate among decided
    flagged edits;
  - new Skeptic nodes from reflection left untagged (nodes whose debate_refs name a gated debate and that have
    no pov_tags).
It also lists the S31-class sample: every `tension` verdict on a single-wing target, for the CL to re-judge
(m1v2-report.md §5). Below 50 gated edits it prints the counts and says the report is not yet reportable.

Usage:
    python research/comp-linguist/scripts/t4231_m2_monitor.py [--data <ai-triad-data root>] [--min-n 50]
The data root defaults to $AI_TRIAD_DATA_ROOT, then ../ai-triad-data next to this repo.
"""
import argparse
import collections
import glob
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
RANK = {"consistent": 0, "tension": 1, "conflict": 2}


def data_root(arg):
    return arg or os.environ.get("AI_TRIAD_DATA_ROOT") or os.path.join(os.path.dirname(REPO), "ai-triad-data")


def outcome(check):
    """The gate-relevant class of one stamp: foreign, unchecked, conflict, tension or consistent."""
    if check.get("relation") == "foreign":
        return "foreign"
    if check.get("unchecked"):
        return "unchecked"
    if check.get("deprecate_shared_note"):
        return "conflict"
    verdicts = check.get("verdicts") or []
    if not verdicts:
        return "consistent"
    return max(verdicts, key=lambda v: RANK.get(v.get("verdict"), 0)).get("verdict", "consistent")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", help="ai-triad-data root")
    ap.add_argument("--min-n", type=int, default=50, help="gated edits needed before the report is reportable")
    args = ap.parse_args()
    root = data_root(args.data)
    if not os.path.isdir(os.path.join(root, "debates")):
        print(f"ERROR: {root}/debates not found. Pass --data or set AI_TRIAD_DATA_ROOT.", file=sys.stderr)
        return 2

    rows = []  # one per gated Skeptic edit
    gated_debates = set()
    unreadable = 0
    for f in sorted(glob.glob(os.path.join(root, "debates", "debate-*.json"))):
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            unreadable += 1
            continue
        for entry in d.get("transcript", []):
            if entry.get("type") != "reflection":
                continue
            for result in (entry.get("metadata") or {}).get("reflection_results") or []:
                if result.get("pover") != "skeptic":
                    continue
                for edit in result.get("edits") or []:
                    check = edit.get("tag_check")
                    if not check:
                        continue
                    gated_debates.add(d.get("id"))
                    rows.append({"debate": d.get("id"), "edit": edit, "check": check})

    n = len(rows)
    print(f"Gated Skeptic reflection edits: {n} in {len(gated_debates)} debate(s) "
          f"({unreadable} unreadable debate files)")

    by_seat = collections.defaultdict(list)
    for r in rows:
        by_seat[r["check"].get("seat_tag") or "untagged"].append(r)
    for seat in sorted(by_seat):
        group = by_seat[seat]
        k = len(group)
        relations = collections.Counter(r["check"].get("relation") for r in group)
        outcomes = collections.Counter(outcome(r["check"]) for r in group)
        decisions = collections.Counter((r["edit"].get("decision") or {}).get("outcome", "pending") for r in group)
        flagged = [r for r in group if outcome(r["check"]) in ("foreign", "unchecked", "conflict")]
        decided_flagged = [r for r in flagged if r["edit"].get("decision")]
        overridden = [r for r in decided_flagged if "cross_tag" in (r["edit"]["decision"].get("overrides") or [])]
        models = collections.Counter(r["check"].get("model") for r in group if r["check"].get("model"))
        print(f"\nseat {seat} (n={k})")
        print(f"  relations: {dict(relations)}")
        print("  worst outcome: " + ", ".join(f"{o} {c} ({c / k:.0%})" for o, c in outcomes.most_common()))
        print(f"  decisions: {dict(decisions)}")
        rate = f"{len(overridden)}/{len(decided_flagged)}" if decided_flagged else "n/a (no decided flagged edits)"
        print(f"  cross-tag override rate among decided flagged edits: {rate}")
        print(f"  judge models: {dict(models)}")

    # New nodes from gated debates left untagged.
    skp_path = os.path.join(root, "taxonomy", "Origin", "skeptic.json")
    with open(skp_path, encoding="utf-8") as fh:
        skp = json.load(fh)
    nodes = skp["nodes"] if isinstance(skp, dict) else skp
    new_nodes = [x for x in nodes if set(x.get("debate_refs") or []) & gated_debates]
    untagged = [x["id"] for x in new_nodes if not x.get("pov_tags")]
    print(f"\nSkeptic nodes referencing a gated debate: {len(new_nodes)}; untagged: {len(untagged)} {untagged[:10]}")

    # S31-class sample: tension on a single-wing target, for CL re-judgement.
    sample = [r for r in rows if outcome(r["check"]) == "tension" and len(r["check"].get("target_tags") or []) == 1]
    print(f"\nS31-class re-judgement sample (tension on a single-wing target): {len(sample)}")
    for r in sample:
        e, c = r["edit"], r["check"]
        cited = next((v.get("cited") for v in c.get("verdicts") or [] if v.get("verdict") == "tension"), None)
        print(f"  {r['debate']} {e.get('node_id')} {e.get('edit_type')} tags={c.get('target_tags')} "
              f"seat={c.get('seat_tag')} | {(cited or '')[:80]}")

    if n < args.min_n:
        print(f"\nNOT YET REPORTABLE: {n} of {args.min_n} gated edits. Re-run later.")
        return 0
    print(f"\nREPORTABLE: n={n} >= {args.min_n}. Write the M2 report (t/4231) and update register §19.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
