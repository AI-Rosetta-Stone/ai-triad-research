#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/215: correct the type of one proposed org edge, org-002 -> saf-beliefs-109 (O15).

Of the 20 proposals named by Orca t/4703, 19 were artefacts of the t/4572 NLI label-rotation bug
and need no change (17 are stored correctly, 2 are rejected). Under the fixed engine the one real
correction is O15: the directional gate reads the org's claim as opposing the node (t/334#3,
re-run at data 365906e5). PI approval p/6#132, scope on t/215#6. Reads ONLY
frozen-t215-o15-polarity.json (/data-mutation element 1).

  organization_edges.json  the one frozen edge: type ADVOCATES_FOR -> OPPOSES and the rationale
                           gains the NLI basis; status stays "proposed". last_modified := the
                           frozen date. Nothing else changes.

Why not Invoke-OrgClaimMatching -WriteProposals: Import-OrganizationEdge upserts on (source,
target, type), so it would append a second OPPOSES edge beside the ADVOCATES_FOR one (check A).
After this edit a later matcher run finds the OPPOSES key present and re-creates nothing (check B).

  --mode dry-run (default)  Every check (pre sha, exactly one matching edge in the required state,
                            zero collateral, no duplicate key, serializer round-trip, post sha)
                            runs; writes nothing.
  --mode apply              The same checks; refuses if any fails; writes the file and re-reads it
                            against post_sha256. Requires --frozen-sha.

Revert: the write lands as one commit in ai-triad-data; `git revert` it.
"""

import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freeze_hash import HASH_BASIS, freeze_sha256  # noqa: E402

FROZEN = Path(__file__).resolve().parent / "frozen-t215-o15-polarity.json"
EDGES = "taxonomy/Origin/organization_edges.json"


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: apply_t215_o15_polarity.py\n  Next Steps: {next_steps}")


def serialize(doc, crlf):
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    return (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")


def edge_key(e):
    return (e.get("source"), e.get("target"), e.get("type"))


def transform(doc, frozen):
    """Returns (new doc, index of the changed edge, problem)."""
    out = copy.deepcopy(doc)
    spec = frozen["edge"]
    want = tuple(spec["key"])
    hits = [i for i, e in enumerate(out["edges"]) if edge_key(e) == want]
    pair = [i for i, e in enumerate(out["edges"]) if (e.get("source"), e.get("target")) == want[:2]]
    if len(hits) != 1 or len(pair) != 1:
        return None, None, f"expected exactly one edge for {want[:2]}, of type {want[2]}; found {len(hits)} of {len(pair)}"
    e = out["edges"][hits[0]]
    for k, v in spec["require"].items():
        if e.get(k) != v:
            return None, None, f"the edge's {k} is {e.get(k)!r}, the freeze requires {v!r}"
    e.update(spec["set"])
    out["last_modified"] = frozen["last_modified"]
    return out, hits[0], None


def collateral(old, new, index, set_fields):
    """Problems if anything outside the frozen change differs."""
    problems = []
    for k in set(old) | set(new):
        if k not in ("edges", "last_modified") and old.get(k) != new.get(k):
            problems.append(f"top-level {k} changed")
    if len(old["edges"]) != len(new["edges"]):
        return problems + ["edge count changed"]
    for i, (a, b) in enumerate(zip(old["edges"], new["edges"])):
        if i != index:
            if a != b:
                problems.append(f"edges[{i}] changed")
            continue
        if list(a) != list(b):
            problems.append(f"edges[{i}]: keys or key order changed")
        diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        if diff != sorted(set_fields):
            problems.append(f"edges[{i}]: changed fields are {diff}, the freeze sets {sorted(set_fields)}")
    keys = [edge_key(e) for e in new["edges"]]
    if len(keys) != len(set(keys)):
        problems.append("a (source, target, type) key is duplicated after the change")
    return problems


def plan(data_root, frozen):
    if frozen.get("hash_basis") != HASH_BASIS:
        _fail("Verify the freeze", f"hash_basis {frozen.get('hash_basis')!r}, expected {HASH_BASIS!r}", "Re-freeze with freeze_hash.py.")
    spec = frozen["files"][EDGES]
    path = data_root / EDGES
    raw = path.read_bytes()
    problems = []
    if freeze_sha256(raw) != spec["pre_sha256"]:
        _fail("Apply the frozen t/215 change with zero collateral",
              f"{EDGES}: bytes differ from pre_sha256 (changed since the freeze)",
              "Nothing was written. Stop and tell the TL (t/215#6); re-freeze only on a new go.")
    crlf = b"\r\n" in raw
    doc = json.loads(raw.decode("utf-8"))
    if serialize(doc, crlf) != raw:
        problems.append(f"{EDGES}: serializer does not round-trip the file")
    new_doc, index, err = transform(doc, frozen)
    if err:
        _fail("Apply the frozen t/215 change with zero collateral", f"{EDGES}: {err}", "Nothing was written. Re-freeze against the current tree.")
    problems += [f"{EDGES}: {p}" for p in collateral(doc, new_doc, index, frozen["edge"]["set"])]
    new_raw = serialize(new_doc, crlf)
    if serialize(json.loads(new_raw.decode("utf-8")), crlf) != new_raw:
        problems.append(f"{EDGES}: output is not canonical")
    post = freeze_sha256(new_raw)
    if spec["post_sha256"] and post != spec["post_sha256"]:
        problems.append(f"{EDGES}: transformed bytes hash to {post}, not post_sha256")
    if problems:
        _fail("Apply the frozen t/215 change with zero collateral", "\n    ".join(problems),
              "Nothing was written. Re-freeze against the current tree and get the new hash authorized.")
    return path, new_raw, index, post


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-root", required=True)
    ap.add_argument("--mode", choices=("dry-run", "apply"), default="dry-run")
    ap.add_argument("--frozen-sha", help="authorized sha256-lf (or a 16+ char prefix) of the frozen file; required for apply")
    a = ap.parse_args(argv)
    frozen_bytes = FROZEN.read_bytes()
    actual = freeze_sha256(frozen_bytes)
    if a.mode == "apply" and (not a.frozen_sha or len(a.frozen_sha) < 16 or not actual.startswith(a.frozen_sha)):
        _fail("Apply only the authorized frozen change", f"--frozen-sha {a.frozen_sha!r} does not match the frozen file ({actual[:16]}...)",
              "Pass the sha256-lf recorded on t/215.")
    frozen = json.loads(frozen_bytes)
    path, new_raw, index, post = plan(Path(a.data_root), frozen)
    print(f"frozen {actual[:16]}: edges[{index}] passes every check; candidate post sha256-lf {post}", file=sys.stderr)
    if a.mode == "dry-run":
        return 0
    if not frozen["files"][EDGES]["post_sha256"]:
        _fail("Apply only a fully frozen change", "the freeze has no post_sha256", "Record the dry-run post sha in the freeze before applying.")
    path.write_bytes(new_raw)
    if freeze_sha256(path.read_bytes()) != frozen["files"][EDGES]["post_sha256"]:
        _fail("Verify the written file", "post_sha256 mismatch after write", f"Revert with git checkout -- {EDGES} in ai-triad-data and investigate.")
    print(f"wrote {EDGES}; matches post_sha256", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
