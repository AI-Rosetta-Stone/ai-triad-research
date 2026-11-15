#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/293 (t/218 option 1): withdraw the OSTP attribution of a presidential executive order.

The doc `ensuring-national-policy-framework-artificial-intelligence-2026` is a presidential action
(whitehouse.gov/presidential-actions), not an OSTP publication (PI, t/218#6; CL no objection,
p/70#30). Reads ONLY frozen-t293-ostp-eo.json (/data-mutation element 1).

  organization_edges.json         the frozen edges (the PUBLISHED edge and the 2 ADVOCATES_FOR
                                  proposals that claim matching derived from its claims) get
                                  status "rejected" plus reviewed_by / reviewed_at / review_note.
                                  Rejected, not deleted: Invoke-OrgPublishedSeeding skips any
                                  existing edge, so the domain match is never re-proposed, and
                                  Invoke-OrgStanceExtraction reads approved edges only (check B).
  organization_stance_claims.json the frozen claims are removed; claim_count follows.
  Both files                      last_modified := the frozen date.

  --mode dry-run (default)  Every check (pre sha, exact frozen matches, zero collateral, serializer
                            round-trip, post sha) runs; writes nothing.
  --mode apply              The same checks; refuses if any fails; writes both files and re-reads
                            them against post_sha256. Requires --frozen-sha.

Revert: the write lands as one commit in ai-triad-data; `git revert` it.
"""

import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freeze_hash import HASH_BASIS, freeze_sha256  # noqa: E402

FROZEN = Path(__file__).resolve().parent / "frozen-t293-ostp-eo.json"
EDGES = "taxonomy/Origin/organization_edges.json"
CLAIMS = "taxonomy/Origin/organization_stance_claims.json"


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: apply_t293_ostp_eo.py\n  Next Steps: {next_steps}")


def serialize(doc, crlf):
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    return (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")


def edge_key(e):
    return (e.get("source"), e.get("target"), e.get("type"))


def claim_key(c):
    return (c.get("org_id"), c.get("source_id"), c.get("text"))


def transform_edges(doc, frozen):
    out = copy.deepcopy(doc)
    want = {tuple(k) for k in frozen["edges"]["keys"]}
    hits = [e for e in out["edges"] if edge_key(e) in want]
    if len(hits) != len(want) or {edge_key(e) for e in hits} != want:
        return None, f"edges: matched {len(hits)} of {len(want)} frozen keys, or a key is not unique"
    for e in hits:
        e.update(frozen["edges"]["set"])
    out["last_modified"] = frozen["last_modified"]
    return out, None


def transform_claims(doc, frozen):
    out = copy.deepcopy(doc)
    want = [tuple(k) for k in frozen["claims"]["keys"]]
    gone = [c for c in out["claims"] if claim_key(c) in set(want)]
    if len(gone) != len(want) or sorted(claim_key(c) for c in gone) != sorted(want):
        return None, f"claims: matched {len(gone)} of {len(want)} frozen keys, or a key is not unique"
    out["claims"] = [c for c in out["claims"] if claim_key(c) not in set(want)]
    out["claim_count"] = len(out["claims"])
    out["last_modified"] = frozen["last_modified"]
    return out, None


def collateral(old, new, list_key, changed_ok):
    """Problems if anything outside the frozen change differs: top-level keys other than the list,
    last_modified and claim_count, and every list item not named by changed_ok."""
    problems = []
    for k in set(old) | set(new):
        if k in (list_key, "last_modified", "claim_count"):
            continue
        if old.get(k) != new.get(k):
            problems.append(f"top-level {k} changed")
    survivors_old = [x for x in old[list_key] if not changed_ok(x)]
    survivors_new = [x for x in new[list_key] if not changed_ok(x)]
    if survivors_old != survivors_new:
        problems.append(f"{list_key}: an unfrozen item changed, moved or vanished")
    return problems


def plan(data_root, frozen):
    if frozen.get("hash_basis") != HASH_BASIS:
        _fail("Verify the freeze", f"hash_basis {frozen.get('hash_basis')!r}, expected {HASH_BASIS!r}", "Re-freeze with freeze_hash.py.")
    steps, problems = [], []
    edge_keys = {tuple(k) for k in frozen["edges"]["keys"]}
    claim_keys = {tuple(k) for k in frozen["claims"]["keys"]}
    for rel, transform, list_key, is_frozen in (
        (EDGES, transform_edges, "edges", lambda e: edge_key(e) in edge_keys),
        (CLAIMS, transform_claims, "claims", lambda c: claim_key(c) in claim_keys),
    ):
        spec = frozen["files"][rel]
        path = data_root / rel
        raw = path.read_bytes()
        if freeze_sha256(raw) != spec["pre_sha256"]:
            problems.append(f"{rel}: bytes differ from pre_sha256 (changed since the freeze)")
            continue
        crlf = b"\r\n" in raw
        doc = json.loads(raw.decode("utf-8"))
        if serialize(doc, crlf) != raw:
            problems.append(f"{rel}: serializer does not round-trip the file")
            continue
        new_doc, err = transform(doc, frozen)
        if err:
            problems.append(f"{rel}: {err}")
            continue
        problems += [f"{rel}: {p}" for p in collateral(doc, new_doc, list_key, is_frozen)]
        new_raw = serialize(new_doc, crlf)
        if serialize(json.loads(new_raw.decode("utf-8")), crlf) != new_raw:
            problems.append(f"{rel}: output is not canonical")
        if freeze_sha256(new_raw) != spec["post_sha256"]:
            problems.append(f"{rel}: transformed bytes do not hash to post_sha256")
            continue
        steps.append((path, new_raw, rel))
    if problems:
        _fail("Apply the frozen t/293 change with zero collateral", "\n    ".join(problems),
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
              "Pass the sha256-lf the PI authorized on t/293.")
    frozen = json.loads(frozen_bytes)
    steps = plan(Path(a.data_root), frozen)
    print(f"frozen {actual[:16]}: {len(steps)} files pass every check "
          f"({len(frozen['edges']['keys'])} edges rejected, {len(frozen['claims']['keys'])} claims removed)", file=sys.stderr)
    if a.mode == "dry-run":
        return 0
    for path, new_raw, _rel in steps:
        path.write_bytes(new_raw)
    bad = [rel for path, _raw, rel in steps if freeze_sha256(path.read_bytes()) != frozen["files"][rel]["post_sha256"]]
    if bad:
        _fail("Verify the written files", f"post_sha256 mismatch after write: {bad}", "Revert with git checkout -- <files> in ai-triad-data and investigate.")
    print(f"wrote {len(steps)} files; all match post_sha256", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
