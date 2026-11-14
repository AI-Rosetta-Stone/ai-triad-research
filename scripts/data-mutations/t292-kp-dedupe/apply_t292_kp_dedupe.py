#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/292 (a): drop exact-duplicate key points, per POV, from 2 legacy chunk summaries in ai-triad-data.

summaries/explaining-womens-skepticism-toward-artificial-intelligence-2026-1.json and -2.json repeat
identical key points up to 5x within one POV (61 repeats in all). They also carry about 24 distinct
facts and 55 distinct key points their base summary lacks (SO, p/120#10), so archiving was withdrawn
(TL decision t/292#20). This keeps every distinct key point and every fact: within each POV's
key_points, a key point that is an exact copy (the whole object, every field) of an earlier one is
dropped; the first occurrence and the order are kept. Nothing else changes.

Reads ONLY frozen-t292-kp-dedupe.json (/data-mutation element 1). Hashes are sha256-lf (t/247).
The serializer is json.dumps(indent=2, ensure_ascii=False) followed by the file's own trailing
whitespace, and must reproduce every input byte-for-byte before anything is written.

  --mode dry-run (default)  Every check runs (pre sha, round-trip, the per-POV removal counts equal
                            the frozen ones, zero collateral, post sha); writes nothing.
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

FROZEN = Path(__file__).resolve().parent / "frozen-t292-kp-dedupe.json"


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: apply_t292_kp_dedupe.py\n  Next Steps: {next_steps}")


def split_tail(raw):
    body = raw.rstrip(b" \t\r\n")
    return body, raw[len(body):]


def serialize(doc, tail):
    return json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8") + tail


def dedupe(doc):
    """(new doc, {pov: removed count}). Exact = the whole key point object, compared canonically."""
    out = copy.deepcopy(doc)
    removed = {}
    for pov, block in out.get("pov_summaries", {}).items():
        if not isinstance(block, dict) or not isinstance(block.get("key_points"), list):
            continue
        seen, kept = set(), []
        for kp in block["key_points"]:
            k = json.dumps(kp, sort_keys=True, ensure_ascii=False)
            if k in seen:
                continue
            seen.add(k)
            kept.append(kp)
        removed[pov] = len(block["key_points"]) - len(kept)
        block["key_points"] = kept
    return out, removed


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
        new_doc, removed = dedupe(doc)
        if removed != e["removed_per_pov"]:
            problems.append(f"{e['doc_id']}: would remove {removed}, frozen {e['removed_per_pov']}")
            continue
        # Zero collateral: only pov_summaries.<pov>.key_points may differ, and each new list is the old
        # list with exact repeats removed (so every distinct key point survives, in order).
        probe = copy.deepcopy(new_doc)
        for pov, block in probe.get("pov_summaries", {}).items():
            if isinstance(block, dict) and "key_points" in block:
                block["key_points"] = doc["pov_summaries"][pov]["key_points"]
        distinct_ok = all(
            {json.dumps(k, sort_keys=True, ensure_ascii=False) for k in doc["pov_summaries"][p]["key_points"]}
            == {json.dumps(k, sort_keys=True, ensure_ascii=False) for k in new_doc["pov_summaries"][p]["key_points"]}
            for p in removed)
        if probe != doc or not distinct_ok:
            problems.append(f"{e['doc_id']}: the change is not exactly an exact-repeat removal")
            continue
        new_raw = serialize(new_doc, tail)
        if freeze_sha256(new_raw) != e["post_sha256"]:
            problems.append(f"{e['doc_id']}: transformed bytes do not hash to post_sha256")
            continue
        steps.append((path, new_raw, e))
    if problems:
        _fail("Apply the frozen t/292 key-point de-duplication with zero collateral",
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
            print(f"  would drop {sum(e['removed_per_pov'].values())} exact-repeat key points from {e['doc_id']}: {e['removed_per_pov']}", file=sys.stderr)
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
