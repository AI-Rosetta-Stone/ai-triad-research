#!/usr/bin/env python3
"""Read-only re-scan for t/4658 Repair 1, per SO condition C1 (e/407#2).

Scans authors/title/one_liner across all ai-triad-sources metadata.json for BOTH
mojibake signatures:
  - UTF-8-as-Latin1:  [ÃÂ][\x80-\xff]   (e.g. "LeÃ³n")
  - UTF-8-as-CP1252:  "â€" sequences    (e.g. "doesnâ€™t", "â€”")

For each hit, computes the candidate fix via both latin-1 and cp1252 re-encode,
and records which one produces a plausible repaired string (no replacement
chars, reversible). Produces a frozen old->new list with per-doc metadata.json
sha256 (pre), the field, and the decoding used. Does NOT write anything.
"""
import json
import hashlib
import os
import re
import sys
from pathlib import Path

# Same convention as archive/populate_provenance.py: $env:AI_TRIAD_SOURCES_ROOT override, else the
# sibling-repo default assuming this script sits at <repo-root>/analyses/<dir>/scan.py. From a
# worktree the sibling guess is wrong (worktrees nest under .worktrees/), so pass the env var there.
SOURCES_ROOT = Path(os.environ.get('AI_TRIAD_SOURCES_ROOT') or (Path(__file__).resolve().parents[2] / 'ai-triad-sources'))

LATIN1_SIG = re.compile(r'[ÃÂ][\x80-\xff]')
CP1252_SIG = re.compile(r'â€')

FIELDS = ['authors', 'title', 'one_liner']


def cp1252_lenient_encode(s):
    """cp1252 encode, with a manual fallback for the handful of bytes
    (0x81, 0x8D, 0x8F, 0x90, 0x9D) that Python's cp1252 DECODER lenently maps
    to the same-valued C1 control char, but which its ENCODER then refuses to
    round-trip (an asymmetry in Python's codec, not a real cp1252 ambiguity)."""
    out = bytearray()
    for c in s:
        try:
            out += c.encode('cp1252')
        except UnicodeEncodeError:
            if ord(c) < 256:
                out.append(ord(c))
            else:
                raise
    return bytes(out)


def try_fix(s):
    """Return (fixed_string, codec) for the first codec that round-trips cleanly, or (None, None)."""
    try:
        fixed = s.encode('latin-1').decode('utf-8')
        if '\ufffd' not in fixed:
            return fixed, 'latin-1'
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    try:
        fixed = cp1252_lenient_encode(s).decode('utf-8')
        if '\ufffd' not in fixed:
            return fixed, 'cp1252'
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return None, None


def sha256_of_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scan_value(val):
    """Return True if val (string) matches either mojibake signature."""
    if not isinstance(val, str):
        return False
    return bool(LATIN1_SIG.search(val) or CP1252_SIG.search(val))


results = []
doc_dirs = sorted([d for d in SOURCES_ROOT.iterdir() if d.is_dir() and not d.name.startswith('.')])
print(f"Scanning {len(doc_dirs)} source directories...", file=sys.stderr)

for d in doc_dirs:
    meta_path = d / 'metadata.json'
    if not meta_path.exists():
        continue
    try:
        raw = meta_path.read_text(encoding='utf-8')
        meta = json.loads(raw)
    except Exception as e:
        print(f"  WARN unreadable {d.name}: {e}", file=sys.stderr)
        continue

    pre_sha = sha256_of_file(meta_path)

    for field in FIELDS:
        if field not in meta:
            continue
        value = meta[field]
        # authors is a list; title/one_liner are scalars
        entries = value if isinstance(value, list) else [value]
        for idx, entry in enumerate(entries):
            if scan_value(entry):
                fixed, codec = try_fix(entry)
                results.append({
                    'doc_id': d.name,
                    'field': field,
                    'index': idx if isinstance(value, list) else None,
                    'old': entry,
                    'new': fixed,
                    'codec': codec,
                    'reversible': fixed is not None,
                    'pre_sha256': pre_sha,
                })

print(f"\n=== TOTAL HITS: {len(results)} ===")
by_field = {}
for r in results:
    by_field.setdefault(r['field'], []).append(r)

for field, items in by_field.items():
    codecs = {}
    for it in items:
        codecs[it['codec']] = codecs.get(it['codec'], 0) + 1
    docs = len(set(it['doc_id'] for it in items))
    print(f"\n-- {field}: {len(items)} hits across {docs} docs -- by codec: {codecs}")

not_reversible = [r for r in results if not r['reversible']]
print(f"\nNot cleanly reversible: {len(not_reversible)}")
for r in not_reversible:
    print(f"  {r['doc_id']} [{r['field']}]: {r['old']!r}")

print("\n=== authors field detail (human-read column) ===")
for r in [x for x in results if x['field'] == 'authors']:
    print(f"  {r['doc_id']}: {r['old']!r} -> {r['new']!r} (codec={r['codec']}, pre_sha256={r['pre_sha256'][:12]}...)")

print("\n=== title field detail ===")
for r in [x for x in results if x['field'] == 'title']:
    print(f"  {r['doc_id']}: {r['old']!r} -> {r['new']!r} (codec={r['codec']})")

print("\n=== one_liner field detail ===")
for r in [x for x in results if x['field'] == 'one_liner']:
    print(f"  {r['doc_id']}: {r['old']!r} -> {r['new']!r} (codec={r['codec']})")

# Write the frozen list artifact
out = {
    'scan': 't4658-full-mojibake-scan',
    'total_hits': len(results),
    'entries': results,
}
out_path = Path(__file__).parent / 'frozen_list.json'
out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding='utf-8')
print(f"\nFrozen list written to: {out_path}")
