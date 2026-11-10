#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/217 (Orca t/4707): apply the frozen provenance-URL re-points to ai-triad-sources.

Reads ONLY frozen-t217-repoints-v2.json; never re-derives the target set (/data-mutation element 1).

  --mode dry-run (default)  For every frozen entry: the file's bytes match pre_sha256, its current
                            url and resolved_url equal `from`, the serializer round-trips it, and
                            the transformed bytes hash to post_sha256. Writes nothing.
  --mode apply              The same checks for all entries first; refuses if ANY fails. Then writes
                            every file and re-reads it against post_sha256. Requires --frozen-sha
                            (the authorized sha256 of the frozen file).

Revert: the write lands as one commit in ai-triad-sources; `git revert` it. Every pre_sha256 is in
the frozen file, so the restored bytes can be checked.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

FROZEN = Path(__file__).resolve().parent / "frozen-t217-repoints-v2.json"
ALLOWED_FIELDS = {"url", "resolved_url", "provenance"}


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: apply_t217_repoints.py\n  Next Steps: {next_steps}")


def serialize(doc, crlf):
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    return (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")


def transform(doc, write):
    out = dict(doc)
    if write["to"]:
        out["url"] = write["to"]
        out["resolved_url"] = write["to"]
        out["provenance"] = list(doc.get("provenance") or []) + [{"scheme": "url", "id": write["to"], "confidence": "verified"}]
    else:
        out["url"] = ""
        out["resolved_url"] = ""
    return out


def plan(sources_root, frozen):
    """Every entry's (path, new bytes), or SystemExit naming every entry that fails a check."""
    out, problems = [], []
    for w in frozen["writes"]:
        path = sources_root / w["doc_id"] / "metadata.json"
        if not path.is_file():
            problems.append(f"{w['doc_id']}: metadata.json missing")
            continue
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != w["pre_sha256"]:
            problems.append(f"{w['doc_id']}: bytes differ from pre_sha256 (changed since the freeze)")
            continue
        crlf = b"\r\n" in raw
        doc = json.loads(raw.decode("utf-8"))
        if serialize(doc, crlf) != raw:
            problems.append(f"{w['doc_id']}: serializer does not round-trip the file")
            continue
        if doc.get("url") != w["from"] or doc.get("resolved_url") != w["from"]:
            problems.append(f"{w['doc_id']}: url/resolved_url no longer equal the frozen `from`")
            continue
        new_doc = transform(doc, w)
        changed = {k for k in set(doc) | set(new_doc) if doc.get(k) != new_doc.get(k)}
        if not changed <= ALLOWED_FIELDS or sorted(changed) != w["fields"]:
            problems.append(f"{w['doc_id']}: would change {sorted(changed)}, frozen {w['fields']}")
            continue
        new_raw = serialize(new_doc, crlf)
        if hashlib.sha256(new_raw).hexdigest() != w["post_sha256"]:
            problems.append(f"{w['doc_id']}: transformed bytes do not hash to post_sha256")
            continue
        out.append((path, new_raw, w))
    if problems:
        _fail("Apply the frozen t/217 re-points with zero collateral",
              f"{len(problems)} of {len(frozen['writes'])} entries failed the pre-write checks:\n    " + "\n    ".join(problems),
              "Nothing was written. Re-freeze against the current tree and get the new hash authorized.")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sources-root", required=True)
    ap.add_argument("--mode", choices=("dry-run", "apply"), default="dry-run")
    ap.add_argument("--frozen-sha", help="authorized sha256 (or a 16+ char prefix) of the frozen file; required for apply")
    a = ap.parse_args(argv)
    frozen_bytes = FROZEN.read_bytes()
    actual = hashlib.sha256(frozen_bytes).hexdigest()
    if a.mode == "apply" and (not a.frozen_sha or len(a.frozen_sha) < 16 or not actual.startswith(a.frozen_sha)):
        _fail("Apply only the authorized frozen list", f"--frozen-sha {a.frozen_sha!r} does not match the frozen file ({actual[:16]}...)",
              "Pass the sha256 the PI authorized on t/217.")
    frozen = json.loads(frozen_bytes)
    steps = plan(Path(a.sources_root), frozen)
    print(f"frozen {actual[:16]}: {len(steps)} of {len(frozen['writes'])} entries pass every check", file=sys.stderr)
    if a.mode == "dry-run":
        for path, _raw, w in steps:
            print(f"  would write {w['doc_id']}: {', '.join(w['fields'])} -> {w['to'] or '(cleared)'}", file=sys.stderr)
        return 0
    for path, new_raw, _w in steps:
        path.write_bytes(new_raw)
    bad = [w["doc_id"] for path, _raw, w in steps if hashlib.sha256(path.read_bytes()).hexdigest() != w["post_sha256"]]
    if bad:
        _fail("Verify the written files", f"post_sha256 mismatch after write: {bad}", "Revert with git checkout -- <files> in ai-triad-sources and investigate.")
    print(f"wrote {len(steps)} files; all match post_sha256", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
