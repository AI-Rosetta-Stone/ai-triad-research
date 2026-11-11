#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/292 (a): archive 2 legacy chunk summaries whose key points loop, in ai-triad-data.

summaries/explaining-womens-skepticism-toward-artificial-intelligence-2026-1.json and -2.json are
per-chunk files from a pipeline that no longer writes them (today's merges chunks into one summary
per doc). They have no source dir, repeat identical key points up to 5x per POV, and the base doc
has a clean 2026-05-22 summary. TL decision t/292#10: move them to _archive/summaries/, byte for
byte, no re-summarize.

Reads ONLY frozen-t292-archive-chunks.json (/data-mutation element 1). Hashes are sha256-lf (t/247).

  --mode dry-run (default)  Every check runs (each source matches pre_sha256, its source dir is
                            still absent, its base still has a summary, the destination is free);
                            moves nothing.
  --mode apply              The same checks; refuses if any fails; moves each file and re-hashes
                            it at the destination. Requires --frozen-sha.

Revert: the move lands as one commit in ai-triad-data; `git revert` it.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freeze_hash import HASH_BASIS, freeze_sha256  # noqa: E402

FROZEN = Path(__file__).resolve().parent / "frozen-t292-archive-chunks.json"


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: apply_t292_archive_chunks.py\n  Next Steps: {next_steps}")


def plan(data_root, sources_root, frozen):
    if frozen.get("hash_basis") != HASH_BASIS:
        _fail("Verify the freeze", f"hash_basis {frozen.get('hash_basis')!r}, expected {HASH_BASIS!r}", "Re-freeze with freeze_hash.py.")
    steps, problems = [], []
    for m in frozen["moves"]:
        src, dst = data_root / m["from"], data_root / m["to"]
        if not src.is_file():
            problems.append(f"{m['from']}: missing")
            continue
        if freeze_sha256(src) != m["pre_sha256"]:
            problems.append(f"{m['from']}: bytes differ from pre_sha256 (changed since the freeze)")
            continue
        if (sources_root / m["doc_id"] / "metadata.json").exists():
            problems.append(f"{m['doc_id']}: now has a source dir; it is no longer an orphan chunk")
            continue
        if not (data_root / "summaries" / f"{m['base_doc_id']}.json").is_file():
            problems.append(f"{m['doc_id']}: base summary {m['base_doc_id']} is gone")
            continue
        if dst.exists():
            problems.append(f"{m['to']}: destination already exists")
            continue
        steps.append((src, dst, m))
    if problems:
        _fail("Archive the frozen t/292 chunk summaries",
              f"{len(problems)} of {len(frozen['moves'])} entries failed the pre-move checks:\n    " + "\n    ".join(problems),
              "Nothing was moved. Re-freeze against the current tree and get the new hash authorized.")
    return steps


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-root", required=True)
    ap.add_argument("--sources-root", required=True)
    ap.add_argument("--mode", choices=("dry-run", "apply"), default="dry-run")
    ap.add_argument("--frozen-sha", help="authorized sha256-lf (or a 16+ char prefix) of the frozen file; required for apply")
    a = ap.parse_args(argv)
    frozen_bytes = FROZEN.read_bytes()
    actual = freeze_sha256(frozen_bytes)
    if a.mode == "apply" and (not a.frozen_sha or len(a.frozen_sha) < 16 or not actual.startswith(a.frozen_sha)):
        _fail("Apply only the authorized frozen list", f"--frozen-sha {a.frozen_sha!r} does not match the frozen file ({actual[:16]}...)",
              "Pass the sha256-lf authorized on t/292.")
    frozen = json.loads(frozen_bytes)
    steps = plan(Path(a.data_root), Path(a.sources_root), frozen)
    print(f"frozen {actual[:16]}: {len(steps)} of {len(frozen['moves'])} entries pass every check", file=sys.stderr)
    if a.mode == "dry-run":
        for _s, _d, m in steps:
            print(f"  would move {m['from']} -> {m['to']}", file=sys.stderr)
        return 0
    for src, dst, _m in steps:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)
    bad = [m["to"] for _s, dst, m in steps if freeze_sha256(dst) != m["pre_sha256"]]
    if bad:
        _fail("Verify the moved files", f"sha256-lf mismatch at the destination: {bad}", "Move them back with git checkout in ai-triad-data and investigate.")
    print(f"moved {len(steps)} files; all match pre_sha256 at the destination", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
