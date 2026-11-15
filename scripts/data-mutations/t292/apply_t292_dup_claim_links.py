#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/292 data fix 1: drop the repeated node id from 8 summary claims in ai-triad-data.

The one-off t/3595 repoint (data 9241c64b) left a node listed twice in 8 claims'
linked_taxonomy_nodes. Spec source-identity 7.4 keeps a document's repeated links, so each repeat
is a duplicate fact in source_evidence_index.json; per TL (t/292#3) the data is fixed, not the
builder. Each entry keeps the FIRST occurrence and drops the rest; nothing else changes.

Reads ONLY frozen-t292-dup-claim-links.json (/data-mutation element 1). Hashes are sha256-lf (t/247).
The serializer is json.dumps(indent=2, ensure_ascii=False) followed by the file's own trailing
whitespace, and must reproduce every input byte-for-byte before anything is written.

  --mode dry-run (default)  Every check runs (pre sha, round-trip, the claim still repeats exactly
                            the frozen node, zero collateral, post sha); writes nothing.
  --mode apply              The same checks; refuses if any fails; writes and re-reads every file.
                            Requires --frozen-sha.

Revert: the write lands as one commit in ai-triad-data; `git revert` it.
"""

import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freeze_hash import HASH_BASIS, freeze_sha256  # noqa: E402

FROZEN = Path(__file__).resolve().parent / "frozen-t292-dup-claim-links.json"


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: apply_t292_dup_claim_links.py\n  Next Steps: {next_steps}")


def split_tail(raw):
    """(json text bytes, trailing whitespace bytes)."""
    body = raw.rstrip(b" \t\r\n")
    return body, raw[len(body):]


def serialize(doc, tail):
    return json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8") + tail


def transform(doc, entry):
    out = copy.deepcopy(doc)
    claim = out["factual_claims"][entry["claim_index"]]
    seen, kept = False, []
    for n in claim["linked_taxonomy_nodes"]:
        if n == entry["node"]:
            if seen:
                continue
            seen = True
        kept.append(n)
    claim["linked_taxonomy_nodes"] = kept
    return out


def plan(data_root, frozen):
    if frozen.get("hash_basis") != HASH_BASIS:
        _fail("Verify the freeze", f"hash_basis {frozen.get('hash_basis')!r}, expected {HASH_BASIS!r}", "Re-freeze with freeze_hash.py.")
    steps, problems = [], []
    for e in frozen["writes"]:
        path = data_root / "summaries" / f"{e['doc_id']}.json"
        if not path.is_file():
            problems.append(f"{e['doc_id']}: summary missing")
            continue
        raw = path.read_bytes()
        if freeze_sha256(raw) != e["pre_sha256"]:
            problems.append(f"{e['doc_id']}: bytes differ from pre_sha256 (changed since the freeze)")
            continue
        _body, tail = split_tail(raw)
        doc = json.loads(raw.decode("utf-8"))
        if serialize(doc, tail) != raw:
            problems.append(f"{e['doc_id']}: serializer does not round-trip the file")
            continue
        claims = doc.get("factual_claims") or []
        if e["claim_index"] >= len(claims):
            problems.append(f"{e['doc_id']}: claim {e['claim_index']} is out of range")
            continue
        linked = claims[e["claim_index"]].get("linked_taxonomy_nodes") or []
        if linked.count(e["node"]) != e["count_before"]:
            problems.append(f"{e['doc_id']}: claim {e['claim_index']} lists {e['node']} {linked.count(e['node'])}x, frozen {e['count_before']}x")
            continue
        new_doc = transform(doc, e)
        # Zero collateral: the documents differ only in that one list.
        probe = copy.deepcopy(new_doc)
        probe["factual_claims"][e["claim_index"]]["linked_taxonomy_nodes"] = linked
        if probe != doc or new_doc["factual_claims"][e["claim_index"]]["linked_taxonomy_nodes"] != e["linked_after"]:
            problems.append(f"{e['doc_id']}: the change is not exactly the frozen list edit")
            continue
        new_raw = serialize(new_doc, tail)
        if freeze_sha256(new_raw) != e["post_sha256"]:
            problems.append(f"{e['doc_id']}: transformed bytes do not hash to post_sha256")
            continue
        steps.append((path, new_raw, e))
    if problems:
        _fail("Apply the frozen t/292 claim-link de-duplication with zero collateral",
              f"{len(problems)} of {len(frozen['writes'])} entries failed the pre-write checks:\n    " + "\n    ".join(problems),
              "Nothing was written. Re-freeze against the current tree and get the new hash authorized.")
    return steps


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-root", required=True)
    ap.add_argument("--mode", choices=("dry-run", "apply"), default="dry-run")
    ap.add_argument("--frozen-sha", help="authorized sha256-lf (or a 16+ char prefix) of the frozen file; required for apply")
    a = ap.parse_args(argv)
    frozen_bytes = FROZEN.read_bytes()
    actual = freeze_sha256(frozen_bytes)
    if a.mode == "apply" and (not a.frozen_sha or len(a.frozen_sha) < 16 or not actual.startswith(a.frozen_sha)):
        _fail("Apply only the authorized frozen list", f"--frozen-sha {a.frozen_sha!r} does not match the frozen file ({actual[:16]}...)",
              "Pass the sha256-lf authorized on t/292.")
    frozen = json.loads(frozen_bytes)
    steps = plan(Path(a.data_root), frozen)
    print(f"frozen {actual[:16]}: {len(steps)} of {len(frozen['writes'])} entries pass every check", file=sys.stderr)
    if a.mode == "dry-run":
        for _p, _r, e in steps:
            print(f"  would drop the repeat of {e['node']} from {e['doc_id']} claim {e['claim_index']}", file=sys.stderr)
        return 0
    for path, new_raw, _e in steps:
        path.write_bytes(new_raw)
    bad = [e["doc_id"] for path, _r, e in steps if freeze_sha256(path.read_bytes()) != e["post_sha256"]]
    if bad:
        _fail("Verify the written files", f"post_sha256 mismatch after write: {bad}", "Revert with git checkout -- <files> in ai-triad-data and investigate.")
    print(f"wrote {len(steps)} files; all match post_sha256", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
