#!/usr/bin/env python3
"""Build the t/3350 demotion-set manifest — the "must-not-reappear" list the
genuine-conflict gate (t/3633) keys against so a full `consolidate_conflicts.py`
regen can never re-introduce the 432 standalone facts t/3350 surgically demoted.

The revised t/3633 design (t/3633#2) is deliberately conservative: the gate keys
demotions to THIS committed manifest rather than auto-classifying opposition with a
low-precision NLI/numeric detector (t/3339#18 measured that at 0.000-0.065 precision).

The 432 demoted entries are identifiable in the live `conflicts.json` by the markers
t/3350 stamped: `status == "demoted"` + `claim_type == "non_conflict"` +
`demotion.reason == "standalone_fact"` (data-of-record 0f38b2e7). This tool extracts
their stable keys so the manifest is data, not a re-diff, on every regen.

Keys emitted per entry (the gate matches a regen candidate on EITHER):
  - claim_id                         (primary; stable if the id is content-derived)
  - assertion_sig                    (fallback; normalized instance assertion, resilient
                                      to a regen minting a different claim_id)

Run:  python build_demotion_manifest.py            # writes demotion-manifest.json
      python build_demotion_manifest.py --verify    # re-derive + diff vs committed manifest (CI-friendly)
"""
import argparse, json, os, re, sys, hashlib

DATA = os.environ.get("AI_TRIAD_DATA_ROOT", r"C:\Users\jsnov\repos\ai-triad-data")
CONFLICTS = os.path.join(DATA, "conflicts", "conflicts.json")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "demotion-manifest.json")
DEMOTION_REASON = "standalone_fact"
DATA_OF_RECORD = "0f38b2e7"  # t/3350 demotion commit


def _norm(text):
    """Normalized assertion signature: lowercase, collapse whitespace, strip trailing
    punctuation. A stable key resilient to trivial regen variation; NOT a semantic match."""
    t = (text or "").strip().lower()
    t = re.sub(r"\s+", " ", t)
    return t.rstrip(" .,:;!?")


def is_demoted(c):
    return (c.get("status") == "demoted"
            and c.get("claim_type") == "non_conflict"
            and (c.get("demotion") or {}).get("reason") == DEMOTION_REASON)


def build():
    with open(CONFLICTS, encoding="utf-8") as fh:
        conflicts = json.load(fh).get("conflicts", [])
    entries, claim_ids, sigs = [], set(), set()
    for c in conflicts:
        if not is_demoted(c):
            continue
        cid = c.get("claim_id", "")
        # one demoted entry == one standalone fact; key on its (single) instance assertion + label.
        asserts = [(i.get("assertion") or "") for i in (c.get("instances") or [])]
        entry_sigs = sorted({_norm(a) for a in asserts if a.strip()})
        if not entry_sigs and c.get("claim_label"):
            entry_sigs = [_norm(c["claim_label"])]
        entries.append({"claim_id": cid, "claim_label": c.get("claim_label", ""),
                        "assertion_sigs": entry_sigs})
        if cid:
            claim_ids.add(cid)
        sigs.update(entry_sigs)
    entries.sort(key=lambda e: e["claim_id"])
    manifest = {
        "_doc": "t/3350 demotion-set manifest (t/3633). The genuine-conflict gate in "
                "consolidate_conflicts.py keys against this so a regen never re-emits these "
                "432 standalone facts as conflicts. A single-instance candidate matching a "
                "claim_id OR an assertion_sig here is emitted demoted, not as a conflict; a "
                "multi-instance candidate is never demoted (README, AC4). Built by "
                "build_demotion_manifest.py from the live conflicts.json markers.",
        "provenance": {"data_of_record": DATA_OF_RECORD, "ticket": "t/3350", "classification": "t/3339#6",
                       "reason": DEMOTION_REASON, "gate_ticket": "t/3633"},
        "count": len(entries),
        "distinct_claim_ids": len(claim_ids),
        "distinct_assertion_sigs": len(sigs),
        "content_hash": hashlib.sha256(
            json.dumps([e["claim_id"] for e in entries], ensure_ascii=False).encode()).hexdigest()[:16],
        "entries": entries,
    }
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true", help="re-derive and diff vs the committed manifest (non-zero exit on drift)")
    args = ap.parse_args()
    fresh = build()
    if args.verify:
        if not os.path.exists(OUT):
            sys.exit(f"no committed manifest at {OUT}")
        with open(OUT, encoding="utf-8") as fh:
            committed = json.load(fh)
        drift = (committed.get("count") != fresh["count"]
                 or committed.get("content_hash") != fresh["content_hash"])
        print(f"committed: count={committed.get('count')} hash={committed.get('content_hash')}")
        print(f"fresh:     count={fresh['count']} hash={fresh['content_hash']}")
        if drift:
            sys.exit("DRIFT: the live demoted set no longer matches the committed manifest — "
                     "re-run without --verify to refresh, and check why the demoted set changed.")
        print("OK: manifest matches the live demoted set.")
        return
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(fresh, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {OUT}: {fresh['count']} demoted entries "
          f"({fresh['distinct_claim_ids']} claim_ids, {fresh['distinct_assertion_sigs']} assertion sigs)")


if __name__ == "__main__":
    main()
