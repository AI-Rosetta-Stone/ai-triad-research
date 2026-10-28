"""t/4604: apply the frozen WEO-canonical URL correction to ai-triad-sources.

Same script as research/comp-linguist/analyses/t4495-metadata-fixes/apply_metadata_fixes.py
(t/4495's SO-reviewed, hash-enforced applier), pointed at this directory's own
frozen_metadata_fixes.json. Reads ONLY that file (never re-derives targets). Dry-run
is the default; --apply writes. Per target it refuses (exit 2, nothing written) unless:
  - the file's sha256 equals the frozen pre_sha256;
  - the live file round-trips byte-exactly through the serializer;
  - every field's current value equals the frozen `old` value;
  - after the change, the key set and key order are unchanged and every
    non-target field is deep-equal (structural 0-collateral);
  - the textual diff touches only lines belonging to target fields;
  - when the frozen file carries a post_sha256, the result hashes to it.
All targets are checked before any file is written.

--apply additionally REQUIRES --approved-sha256 <hash>, matched against the
frozen file's own sha256 before anything else runs (same C1 discipline as t/4495).
A dry run doesn't need it, since nothing is written either way.

Usage:
    python apply_metadata_fixes.py <sources_root> [--apply --approved-sha256 <hash>] [--emit-post-hashes]
"""
import difflib
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FROZEN = os.path.join(HERE, "frozen_metadata_fixes.json")


def ser(obj):
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def fail(msg):
    print(f"REFUSE: {msg}")
    sys.exit(2)


def field_line_ranges(text_lines, fields):
    """Indices of lines that belong to top-level target fields (2-space indented keys)."""
    owned, current = set(), None
    for i, line in enumerate(text_lines):
        if line.startswith('  "') and not line.startswith('   '):
            key = line.split('"')[1]
            current = key if key in fields else None
        elif line.startswith("}"):
            current = None
        if current is not None:
            owned.add(i)
    return owned


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    root, apply_, emit = args[0], "--apply" in args, "--emit-post-hashes" in args
    frozen_bytes = open(FROZEN, "rb").read()
    frozen = json.loads(frozen_bytes)
    frozen_hash = sha(frozen_bytes)
    print(f"frozen list sha256 {frozen_hash}  targets={len(frozen['targets'])}  mode={'APPLY' if apply_ else 'dry-run'}")

    if apply_:
        if "--approved-sha256" not in args:
            fail("--apply requires --approved-sha256 <hash> (C1 discipline, t/4495)")
        approved = args[args.index("--approved-sha256") + 1]
        if approved != frozen_hash:
            fail(f"--approved-sha256 {approved} does not match the frozen list's own sha256 {frozen_hash}")

    planned = []
    for t in frozen["targets"]:
        path = os.path.join(root, t["path"])
        raw = open(path, "rb").read()
        if sha(raw) != t["pre_sha256"]:
            fail(f"{t['doc_id']}: pre_sha256 mismatch (have {sha(raw)})")
        live = json.loads(raw.decode("utf-8"))
        if ser(live) != raw:
            fail(f"{t['doc_id']}: live file does not round-trip byte-exactly")
        names = [f["field"] for f in t["fields"]]
        new = json.loads(raw.decode("utf-8"))
        for f in t["fields"]:
            if f["field"] not in live:
                fail(f"{t['doc_id']}: field {f['field']} absent (values-only list may not add keys)")
            if live[f["field"]] != f["old"]:
                fail(f"{t['doc_id']}: {f['field']} current value {live[f['field']]!r} != frozen old {f['old']!r}")
            new[f["field"]] = f["new"]
        if list(new.keys()) != list(live.keys()):
            fail(f"{t['doc_id']}: key set/order changed")
        for k in live:
            if k not in names and new[k] != live[k]:
                fail(f"{t['doc_id']}: non-target field {k} changed")
        out = ser(new)
        old_lines, new_lines = raw.decode("utf-8").splitlines(), out.decode("utf-8").splitlines()
        owned_old, owned_new = field_line_ranges(old_lines, names), field_line_ranges(new_lines, names)
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False).get_opcodes():
            if tag == "equal":
                continue
            if any(i not in owned_old for i in range(i1, i2)) or any(j not in owned_new for j in range(j1, j2)):
                fail(f"{t['doc_id']}: textual diff touches a non-target line ({tag} {i1}:{i2} -> {j1}:{j2})")
        post = sha(out)
        if t.get("post_sha256") and t["post_sha256"] != post:
            fail(f"{t['doc_id']}: post_sha256 mismatch (would produce {post})")
        changed = sum(1 for f in t["fields"])
        diff_lines = sum(1 for l in difflib.unified_diff(old_lines, new_lines, lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---"))
        print(f"  OK {t['doc_id']}: {changed} field(s), {diff_lines} diff line(s), keys {len(live)} unchanged, post_sha256 {post}")
        planned.append((path, out, t["doc_id"], post))

    if emit:
        print(json.dumps({d: p for _, _, d, p in planned}, indent=2))
    if not apply_:
        print(f"dry-run: {len(planned)}/{len(frozen['targets'])} targets pass all checks; nothing written")
        return
    for path, out, doc_id, _ in planned:
        with open(path, "wb") as fh:
            fh.write(out)
        print(f"  wrote {doc_id}")
    print(f"applied {len(planned)} file(s)")


if __name__ == "__main__":
    main()
