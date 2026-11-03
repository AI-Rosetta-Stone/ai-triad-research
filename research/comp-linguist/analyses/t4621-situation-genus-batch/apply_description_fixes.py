"""t/4620: apply the sit-493/sit-484 description fixes to ai-triad-data's situations.json.

Reads ONLY frozen_description_fixes.json (never re-derives targets). Dry-run is the
default; --apply writes. Per target it refuses (exit 2, nothing written) unless:
  - the file's sha256 equals the frozen pre_sha256;
  - every line_replacement's `old` text occurs EXACTLY ONCE in the file;
  - after all replacements, the file parses as valid JSON with the same node id order
    as before, every node's non-description fields deep-equal their prior value, and
    only the two targeted nodes' `description` changed;
  - when the frozen file carries a post_sha256, the result hashes to it.

--apply additionally REQUIRES --approved-sha256 <hash>, matched against the frozen
file's own sha256 before anything else runs (same C1 discipline as t/4495/t/4604/t/4614).
The frozen list's hash is computed LF-normalised (SO condition C2, e/395#2), so the
approval binds to the file's content, not to a checkout's line-ending setting.

Each line_replacement MUST declare its mode (t/4622, SO tightening e/396#4):
  - a pure prefix swap carries `old_prefix`/`new_prefix`. old_desc/new_desc are then
    DERIVED by parsing the actual `old`/`new` lines (never trusted from declared
    fields), and the script asserts new_desc[len(new_prefix):] == old_desc[len(old_prefix):]
    -- the differentia is machine-verified verbatim, not asserted in prose.
  - a freeform content rewrite (the differentia itself changes, e.g. a normative
    claim restructured into a neutral one) carries `freeform: true` instead, which
    explicitly opts out of the verbatim-differentia check.
  - a line_replacement with neither key is refused: silently skipping the check
    for an under-specified entry is exactly the gap the SO flagged.

Usage:
    python apply_description_fixes.py <data_root> [--apply --approved-sha256 <hash>]
"""
import hashlib
import json
import sys


def sha(b):
    return hashlib.sha256(b).hexdigest()


def fail(msg):
    print(f"REFUSE: {msg}")
    sys.exit(2)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    data_root, apply_ = args[0], "--apply" in args
    here = __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0]
    frozen_path = f"{here}/frozen_description_fixes.json"
    frozen_bytes = open(frozen_path, "rb").read()
    frozen = json.loads(frozen_bytes)
    frozen_hash = sha(frozen_bytes.replace(b"\r\n", b"\n"))
    print(f"frozen list sha256 (LF-normalised) {frozen_hash}  mode={'APPLY' if apply_ else 'dry-run'}")

    if apply_:
        if "--approved-sha256" not in args:
            fail("--apply requires --approved-sha256 <hash> (t/4495 C1 discipline)")
        approved = args[args.index("--approved-sha256") + 1]
        if approved != frozen_hash:
            fail(f"--approved-sha256 {approved} does not match the frozen list's own sha256 {frozen_hash}")

    for t in frozen["targets"]:
        path = f"{data_root}/{t['path']}"
        raw = open(path, "rb").read()
        if sha(raw) != t["pre_sha256"]:
            fail(f"{t['path']}: pre_sha256 mismatch (have {sha(raw)})")
        text = raw.decode("utf-8")
        before = json.loads(text)

        changed_nodes = set()
        new_text = text
        for rep in t["line_replacements"]:
            old, new = rep["old"], rep["new"]
            c = new_text.count(old)
            if c != 1:
                fail(f"{t['path']}: {rep['node']} old text occurs {c} times, need exactly 1")
            has_prefix = "old_prefix" in rep and "new_prefix" in rep
            is_freeform = rep.get("freeform") is True
            if not has_prefix and not is_freeform:
                fail(f"{t['path']}: {rep['node']} must declare either old_prefix/new_prefix "
                     f"(mechanical verbatim-differentia check) or freeform: true (explicit "
                     f"opt-out for content rewording) -- SO C1 tightening (e/396#4, t/4622)")
            if has_prefix:
                old_prefix, new_prefix = rep["old_prefix"], rep["new_prefix"]
                # Derive old_desc/new_desc by parsing the ACTUAL old/new lines -- never
                # trust separately-declared fields (SO e/396#4: "tie them to the old/new
                # lines it actually writes").
                old_desc = json.loads("{" + old.strip().rstrip(",") + "}")["description"]
                new_desc = json.loads("{" + new.strip().rstrip(",") + "}")["description"]
                if not (old_desc.startswith(old_prefix) and new_desc.startswith(new_prefix)):
                    fail(f"{t['path']}: {rep['node']} declared prefix doesn't match its own old/new line")
                if new_desc[len(new_prefix):] != old_desc[len(old_prefix):]:
                    fail(f"{t['path']}: {rep['node']} differentia not verbatim "
                         f"(new minus new_prefix != old minus old_prefix) -- SO C1 check (e/396#2)")
            new_text = new_text.replace(old, new, 1)
            changed_nodes.add(rep["node"])

        new_raw = new_text.encode("utf-8")
        after = json.loads(new_text)

        before_ids = [n["id"] for n in before["nodes"]]
        after_ids = [n["id"] for n in after["nodes"]]
        if before_ids != after_ids:
            fail(f"{t['path']}: node id order changed")
        for b, a in zip(before["nodes"], after["nodes"]):
            if b["id"] in changed_nodes:
                bb, aa = dict(b), dict(a)
                bb.pop("description", None); aa.pop("description", None)
                if bb != aa:
                    fail(f"{t['path']}: non-description field changed on {b['id']}")
            else:
                if b != a:
                    fail(f"{t['path']}: unexpected change on {b['id']}")

        post = sha(new_raw)
        if t.get("post_sha256") and t["post_sha256"] != post:
            fail(f"{t['path']}: post_sha256 mismatch (would produce {post})")

        print(f"  OK {t['path']}: {len(t['line_replacements'])} description(s) replaced, "
              f"{len(before['nodes'])} nodes unchanged in order/other-fields, post_sha256 {post}")

        if apply_:
            with open(path, "wb") as fh:
                fh.write(new_raw)
            print(f"  wrote {t['path']}")

    if not apply_:
        print("dry-run: all targets pass all checks; nothing written")
    else:
        print("applied.")


if __name__ == "__main__":
    main()
