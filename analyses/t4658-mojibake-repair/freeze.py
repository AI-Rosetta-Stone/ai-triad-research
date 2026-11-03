"""t/4658 Repair 1: consolidate scan.py's raw hits into an apply-ready frozen list.

Addresses SO gaps G1-G3 (e/407#4):
  G1: pre_sha256 must come from the COMMITTED blob (`git show <base_commit>:<path>`), not a
      working-copy read, which can silently diverge on CRLF/LF without `git status` noticing
      (the exact failure class t/4495#4 hit).
  G2: post_sha256 per doc, computed by applying ALL of that doc's fixes (several docs have more
      than one) through the doc's own serializer -- same shape as t/4495's frozen list.
  G3: feeds apply_metadata_fixes.py (adapted from t/4495's, extended for a list `index` on
      `authors`), which is the actual apply-time validator/writer.

Reads ONLY raw_scan.json (scan.py's output). Never re-derives from the live corpus. Writes
frozen_metadata_fixes.json. Makes no change to ai-triad-sources.

Usage: python freeze.py <sources_root_git_dir> <base_commit>
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def ser(obj):
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def git_show(git_dir, commit, path):
    return subprocess.run(
        ["git", "-C", git_dir, "show", f"{commit}:{path}"],
        capture_output=True, check=True,
    ).stdout


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    sources_root, base_commit = sys.argv[1], sys.argv[2]

    raw = json.loads((HERE / "raw_scan.json").read_text(encoding="utf-8"))["entries"]

    by_doc = {}
    for e in raw:
        by_doc.setdefault(e["doc_id"], []).append(e)

    targets = []
    for doc_id, hits in sorted(by_doc.items()):
        path = f"{doc_id}/metadata.json"
        blob = git_show(sources_root, base_commit, path)
        pre_sha256 = sha(blob)
        live = json.loads(blob.decode("utf-8"))

        if ser(live) != blob:
            print(f"REFUSE {doc_id}: committed blob does not round-trip byte-exactly through the serializer")
            sys.exit(2)

        new = json.loads(blob.decode("utf-8"))  # deep-ish copy via re-parse
        fields = []
        for h in hits:
            field = h["field"]
            if field == "authors":
                idx = h["index"]
                if live["authors"][idx] != h["old"]:
                    print(f"REFUSE {doc_id}: authors[{idx}] current {live['authors'][idx]!r} != scanned old {h['old']!r}")
                    sys.exit(2)
                new["authors"][idx] = h["new"]
                fields.append({"field": "authors", "index": idx, "old": h["old"], "new": h["new"], "codec": h["codec"]})
            else:
                if live[field] != h["old"]:
                    print(f"REFUSE {doc_id}: {field} current {live[field]!r} != scanned old {h['old']!r}")
                    sys.exit(2)
                new[field] = h["new"]
                fields.append({"field": field, "old": h["old"], "new": h["new"], "codec": h["codec"]})

        post_bytes = ser(new)
        post_sha256 = sha(post_bytes)
        targets.append({
            "doc_id": doc_id,
            "path": path,
            "pre_sha256": pre_sha256,
            "fields": fields,
            "post_sha256": post_sha256,
        })
        print(f"  OK {doc_id}: {len(fields)} field fix(es), pre={pre_sha256[:12]}... post={post_sha256[:12]}...")

    out = {"base_commit": base_commit, "targets": targets}
    out_bytes = (json.dumps(out, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    out_path = HERE / "frozen_metadata_fixes.json"
    out_path.write_bytes(out_bytes)

    list_hash = sha(out_bytes)
    print(f"\n{len(targets)} targets, {sum(len(t['fields']) for t in targets)} field fixes")
    print(f"base_commit: {base_commit}")
    print(f"frozen_metadata_fixes.json sha256: {list_hash}")


if __name__ == "__main__":
    main()
