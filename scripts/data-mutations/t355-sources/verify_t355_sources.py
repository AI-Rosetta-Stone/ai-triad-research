#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""t/355: freeze and verify the 23 ingested source folders committed to ai-triad-sources.

The folders and the regenerated `_index.json` existed only as uncommitted files in the shared
sources checkout. 18 of them already have summaries committed in ai-triad-data, so a clean export
of the sources repo was missing documents the data repo describes. PI authorization: t/355#34.

This script writes no data. The commit itself is `git add` of exactly the frozen paths, done by
hand under /data-mutation. Reads ONLY frozen-t355-sources.json for what the paths and hashes are.

  --mode freeze    Print the freeze record for the untracked folders and the modified _index.json
                   in a sources checkout (used once, to write frozen-t355-sources.json).
  --mode worktree  Check the files on disk in a sources checkout against the freeze.
  --mode ref       Check the committed tree at --ref against the freeze: every frozen file is in
                   the tree with the frozen hash, each frozen folder holds nothing else, and
                   nothing outside the frozen paths differs from the base commit.

Hashes are sha256-lf (freeze_hash.py): the bytes with CRLF turned into LF, which is what git
stores for text files on a checkout with core.autocrlf=true. PDFs have no such pairs to speak of,
and the same rule is applied on both sides.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freeze_hash import HASH_BASIS, freeze_sha256  # noqa: E402

FROZEN = Path(__file__).resolve().parent / "frozen-t355-sources.json"
INDEX = "_index.json"


def _fail(goal, problem, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: verify_t355_sources.py\n  Next Steps: {next_steps}")


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "core.quotepath=false", *args], capture_output=True, check=True).stdout


def freeze(repo):
    out = _git(repo, "status", "--porcelain", "-uall", "-z").decode("utf-8").split("\0")
    entries = [(line[:2], line[3:]) for line in out if line]
    files = {}
    for status, path in entries:
        top = path.split("/")[0]
        if top.startswith("_") or status != "??":
            continue
        files[path] = freeze_sha256(repo / path)
    index_status = [s for s, p in entries if p == INDEX]
    if index_status != [" M"]:
        _fail("Freeze the sources commit", f"{INDEX} status is {index_status}, expected modified", "Inspect the checkout.")
    return {
        "ticket": "t/355",
        "go": "t/355#34",
        "repo": "ai-triad-sources",
        "base_commit": _git(repo, "rev-parse", "HEAD").decode().strip(),
        "hash_basis": HASH_BASIS,
        "folders": sorted({p.split("/")[0] for p in files}),
        "files": dict(sorted(files.items())),
        "index": {"path": INDEX, "sha256": freeze_sha256(repo / INDEX)},
    }


def check_worktree(repo, frozen):
    problems = []
    for path, want in list(frozen["files"].items()) + [(frozen["index"]["path"], frozen["index"]["sha256"])]:
        f = repo / path
        if not f.is_file():
            problems.append(f"missing: {path}")
        elif freeze_sha256(f) != want:
            problems.append(f"changed since the freeze: {path}")
    for folder in frozen["folders"]:
        on_disk = {p.relative_to(repo).as_posix() for p in (repo / folder).rglob("*") if p.is_file()}
        extra = sorted(on_disk - set(frozen["files"]))
        if extra:
            problems.append(f"files not in the freeze: {extra}")
    return problems


def check_ref(repo, frozen, ref):
    problems = []
    tree = {}
    for line in _git(repo, "ls-tree", "-r", "-z", ref).decode("utf-8").split("\0"):
        if line:
            meta, path = line.split("\t", 1)
            tree[path] = meta.split()[2]
    for path, want in list(frozen["files"].items()) + [(frozen["index"]["path"], frozen["index"]["sha256"])]:
        if path not in tree:
            problems.append(f"not in {ref}: {path}")
        elif freeze_sha256(_git(repo, "cat-file", "blob", tree[path])) != want:
            problems.append(f"hash differs in {ref}: {path}")
    for folder in frozen["folders"]:
        extra = sorted(p for p in tree if p.startswith(folder + "/") and p not in frozen["files"])
        if extra:
            problems.append(f"in {ref} but not in the freeze: {extra}")
    changed = [p for p in _git(repo, "diff", "--name-only", "-z", frozen["base_commit"], ref).decode("utf-8").split("\0") if p]
    allowed = set(frozen["files"]) | {frozen["index"]["path"]}
    outside = sorted(p for p in changed if p not in allowed)
    if outside:
        problems.append(f"paths outside the freeze changed since {frozen['base_commit'][:9]}: {outside}")
    if sorted(changed) != sorted(allowed):
        problems.append(f"{len(changed)} paths changed since the base, the freeze has {len(allowed)}")
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sources-root", required=True)
    ap.add_argument("--mode", choices=("freeze", "worktree", "ref"), required=True)
    ap.add_argument("--ref", default="HEAD")
    a = ap.parse_args(argv)
    repo = Path(a.sources_root).resolve()
    if a.mode == "freeze":
        print(json.dumps(freeze(repo), indent=2, ensure_ascii=False))
        return 0
    frozen = json.loads(FROZEN.read_text(encoding="utf-8"))
    if frozen.get("hash_basis") != HASH_BASIS:
        _fail("Verify the freeze", f"hash_basis {frozen.get('hash_basis')!r}", "Re-freeze with freeze_hash.py.")
    problems = check_worktree(repo, frozen) if a.mode == "worktree" else check_ref(repo, frozen, a.ref)
    if problems:
        _fail("Commit exactly the frozen source folders", "\n    ".join(problems), "Nothing should be committed or pushed until this is clean.")
    where = "on disk" if a.mode == "worktree" else f"at {a.ref}"
    print(f"frozen {freeze_sha256(FROZEN.read_bytes())[:16]}: {len(frozen['folders'])} folders, {len(frozen['files'])} files and {INDEX} match {where}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
