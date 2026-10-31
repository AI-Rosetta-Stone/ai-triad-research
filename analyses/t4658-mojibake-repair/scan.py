#!/usr/bin/env python3
"""Discovery pass for t/4658 Repair 1 (SO condition C1, e/407#2/#4).

Scans authors/title/one_liner across all ai-triad-sources metadata.json for BOTH
mojibake signatures:
  - UTF-8-as-Latin1:  [ÃÂ][\x80-\xff]   (e.g. "LeÃ³n")
  - UTF-8-as-CP1252:  "â€" sequences    (e.g. "doesnâ€™t", "â€”")

For each hit, computes the candidate fix via both latin-1 and cp1252 re-encode,
and records which one produces a plausible repaired string (no replacement
chars). Writes raw_scan.json: doc_id/field/index/old/new/codec only -- no
sha256, since this script reads the WORKING COPY, which can silently diverge
from the committed blob (t/4495#4's CRLF-drift class, G1 in e/407#4).

freeze.py consumes raw_scan.json and computes the real, apply-ready
frozen_metadata_fixes.json (committed-blob pre_sha256, post_sha256) -- this
script's own output is a discovery intermediate, not the authorization
artifact. Does NOT write to ai-triad-sources.
"""
import json
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

    for field in FIELDS:
        if field not in meta:
            continue
        value = meta[field]
        # authors is a list; title/one_liner are scalars
        entries = value if isinstance(value, list) else [value]
        for idx, entry in enumerate(entries):
            if scan_value(entry):
                fixed, codec = try_fix(entry)
                if fixed is None:
                    print(f"WARN not cleanly reversible, EXCLUDED from raw_scan.json: {d.name} [{field}]: {entry!r}", file=sys.stderr)
                    continue
                results.append({
                    'doc_id': d.name,
                    'field': field,
                    'index': idx if isinstance(value, list) else None,
                    'old': entry,
                    'new': fixed,
                    'codec': codec,
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

print("\n=== authors field detail (human-read column) ===")
for r in [x for x in results if x['field'] == 'authors']:
    print(f"  {r['doc_id']}: {r['old']!r} -> {r['new']!r} (codec={r['codec']})")

print("\n=== title field detail ===")
for r in [x for x in results if x['field'] == 'title']:
    print(f"  {r['doc_id']}: {r['old']!r} -> {r['new']!r} (codec={r['codec']})")

print("\n=== one_liner field detail ===")
for r in [x for x in results if x['field'] == 'one_liner']:
    print(f"  {r['doc_id']}: {r['old']!r} -> {r['new']!r} (codec={r['codec']})")

# Discovery output -- NOT the apply-ready frozen list. freeze.py turns this into
# frozen_metadata_fixes.json with committed-blob sha256es.
out = {
    'scan': 't4658-full-mojibake-scan',
    'total_hits': len(results),
    'entries': results,
}
out_path = Path(__file__).parent / 'raw_scan.json'
out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding='utf-8')
print(f"\nRaw scan written to: {out_path}")
