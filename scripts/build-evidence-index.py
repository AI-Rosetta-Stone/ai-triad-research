#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Builds source_evidence_index.json from the summaries (t/231).

The index has never had a builder in this repo; the committed copy was last regenerated in
May 2026 and last touched by the 2026-07-04 id migration. This rebuilds it from the reader's
contract (lib/debate/evidenceFromSummaries.ts) and docs/specs/source-identity.md:

  - section 6.3: every citation is attributed to resolve(id), so a marked copy's evidence lands
    on its canonical and the copy is never a separate document;
  - section 7: a group's evidence is the de-duplicated union of its members' links, and a link
    kept from a marked copy carries `via: <copy id>`. Entity extraction skips those (7.6).

Shape: { node_id: { "facts": [...], "keyPoints": [...] } }. A fact is
{claim, label, doc_id, specificity, temporal_bound[, via]}; a key point is
{stance, pov, point (first 250 chars), verbatim (first 200), doc_id[, via]}.

Read-only against the data and sources roots. It writes only to --out, which must not be inside
the data root: replacing the committed index is a data change and goes through /data-mutation.
Output is deterministic: sorted keys, nodes in sorted order, links in spec 7.4 order, and groups
on a node in ordinal order of their canonical id.

    python scripts/build-evidence-index.py --out C:/tmp/sei.json [--data-root ..] [--sources-root ..]
"""

import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent

POINT_MAX = 250
VERBATIM_MAX = 200


def _log(msg):
    print(msg, file=sys.stderr)


def _fail(goal, problem, location, next_steps):
    raise SystemExit(f"ERROR\n  Goal: {goal}\n  Problem: {problem}\n  Location: {location}\n  Next Steps: {next_steps}")


def _config():
    p = _PROJECT_ROOT / ".aitriad.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            _log(f"WARN: {p} unreadable ({exc}); falling back to the monorepo layout")
    return {}


def resolve_roots(data_root=None, sources_root=None):
    """The env var beats .aitriad.json, which beats the monorepo fallback (AGENTS.md)."""
    cfg = _config()

    def pick(explicit, env, key, fallback):
        if explicit:
            return Path(explicit).resolve()
        if os.environ.get(env):
            return Path(os.environ[env]).resolve()
        v = cfg.get(key)
        if v:
            return (Path(v) if Path(v).is_absolute() else _PROJECT_ROOT / v).resolve()
        return (_PROJECT_ROOT.parent / fallback).resolve()

    return (pick(data_root, "AI_TRIAD_DATA_ROOT", "data_root", "ai-triad-data"),
            pick(sources_root, "AI_TRIAD_SOURCES_ROOT", "sources_root", "ai-triad-sources"))


# ── Spec 7.2 / 7.3: de-duplication key and near-equal ────────────────────────
# An implementation separate from scripts/new_evidence_union_fixture.py, so the shared fixture
# (tests/fixtures/evidence-union-cases.json) is a real cross-check, as for the PS and TS stacks.

_SEQ = (("\u0393\u00c7\u00d6", "'"), ("\u0393\u00c7\u00ff", "'"), ("\u0393\u00c7\u00a3", '"'),
        ("\u0393\u00c7\u00a5", '"'), ("\u0393\u00c7\u00f4", "-"), ("\u0393\u00c7\u00f6", "-"),
        ("\u0393\u00c7\u00aa", "..."))
_SINGLE = (("\u00c6", "'"), ("\u00e6", "'"), ("\u00f4", '"'), ("\u00f6", '"'), ("\u00fb", "-"), ("\u00f9", "-"))
_TYPO = (("\u2018", "'"), ("\u2019", "'"), ("\u201c", '"'), ("\u201d", '"'), ("\u2013", "-"), ("\u2014", "-"))


def evidence_key(quote):
    if not quote:
        return ""
    s = quote
    for a, b in _SEQ + _SINGLE:
        s = s.replace(a, b)
    s = unicodedata.normalize("NFKC", s)
    for a, b in _TYPO:
        s = s.replace(a, b)
    s = s.lower()
    s = "".join(c if (unicodedata.category(c)[0] == "L" or unicodedata.category(c) == "Nd") else " " for c in s)
    return " ".join(t for t in s.split(" ") if t)


def _units(s):
    b = s.encode("utf-16-le")
    return [b[i:i + 2] for i in range(0, len(b), 2)]


def _levenshtein(a, b):
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def near_equal(a, b):
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    ta, tb = set(a.split(" ")), set(b.split(" "))
    inter = len(ta & tb)
    if 5 * inter >= 4 * (len(ta) + len(tb) - inter):
        return True
    ua, ub = _units(a), _units(b)
    m = max(len(ua), len(ub))
    if 20 * (m - abs(len(ua) - len(ub))) < 17 * m:  # lev >= |len diff|: the bound alone fails
        return False
    return 20 * (m - _levenshtein(ua, ub)) >= 17 * m


def ordinal_key(s):
    """Ordinal order = UTF-16 code-unit order (.NET StringComparer.Ordinal, JavaScript)."""
    return [int.from_bytes(u, "little") for u in _units(s)]


# ── Spec 7.1: links, each carrying the index record it would produce ─────────

def _text(o, names):
    for n in names:
        v = o.get(n)
        if isinstance(v, str) and v.strip():
            return v
    return ""


def _is_node(v):
    return isinstance(v, str) and len(v) > 0


def summary_links(summary):
    """Spec 7.1 links in file order: {node, field, quote, record}. `record` is the index entry
    (without doc_id) for key points and factual claims; None for unmapped concepts, which take
    part in de-duplication but have no slot in the index."""
    out = []
    povs = summary.get("pov_summaries")
    if isinstance(povs, dict):
        for pov, block in povs.items():
            for kp in (block or {}).get("key_points") or [] if isinstance(block, dict) else []:
                if not isinstance(kp, dict) or not _is_node(kp.get("taxonomy_node_id")):
                    continue
                rec = {"stance": kp.get("stance"), "pov": pov,
                       "point": (kp.get("point") or "")[:POINT_MAX],
                       "verbatim": (kp.get("verbatim") or "")[:VERBATIM_MAX]}
                out.append({"node": kp["taxonomy_node_id"], "field": "key_point",
                            "quote": _text(kp, ["verbatim", "point"]), "record": rec})
    for fc in summary.get("factual_claims") or []:
        if not isinstance(fc, dict):
            continue
        ec = fc.get("evidence_criteria")
        spec = ec.get("specificity") if isinstance(ec, dict) else None
        rec = {"claim": fc.get("claim"), "label": fc.get("claim_label"),
               "specificity": spec if isinstance(spec, str) and spec else "unknown",
               "temporal_bound": fc.get("temporal_bound")}
        for f in ("linked_taxonomy_nodes", "potential_taxonomy_nodes"):
            nodes = fc.get(f)
            for n in nodes if isinstance(nodes, list) else []:
                if _is_node(n):
                    out.append({"node": n, "field": "factual_claim", "quote": _text(fc, ["claim"]), "record": dict(rec)})
    for uc in summary.get("unmapped_concepts") or []:
        if isinstance(uc, dict) and _is_node(uc.get("resolved_node_id")):
            out.append({"node": uc["resolved_node_id"], "field": "unmapped_concept",
                        "quote": _text(uc, ["verbatim", "suggested_description", "description", "concept", "suggested_label"]),
                        "record": None})
    return out


# ── Spec 7.4: the union of one group ─────────────────────────────────────────

def union_group(canonical, members):
    """members: {exact id: [links]}. Returns {node: [kept links]}; each kept link has doc = the
    canonical and, when it came from a marked member, via = that member's exact id."""
    order = [canonical] + sorted((m for m in members if m != canonical), key=ordinal_key)
    out, keys = {}, {}
    for mid in order:
        own = mid == canonical
        for link in members.get(mid, []):
            n, k = link["node"], evidence_key(link["quote"])
            kept, kk = out.setdefault(n, []), keys.setdefault(n, [])
            if not own and any(near_equal(k, x) for x in kk):
                continue
            e = dict(link, doc=canonical)
            if not own:
                e["via"] = mid
            kept.append(e)
            kk.append(k)
    return out


# ── Spec 6.1: valid marks ─────────────────────────────────────────────────────

def load_marks(sources_root):
    """{id: target} for every document whose duplicate_of passes 6.1 checks 1-3 (self,
    missing_target, chain). Invalid marks are logged and treated as absent."""
    if not sources_root.is_dir():
        _fail("Resolve duplicate marks (spec 6.1) before attributing evidence",
              f"sources root {sources_root} does not exist",
              "build-evidence-index.py load_marks",
              "Check out ai-triad-sources, or pass --sources-root / set AI_TRIAD_SOURCES_ROOT.")
    ids, raw = set(), {}
    for d in sorted(sources_root.iterdir(), key=lambda p: ordinal_key(p.name)):
        if not d.is_dir() or d.name[:1] in "._":
            continue
        ids.add(d.name)
        mp = d / "metadata.json"
        if not mp.exists():
            continue
        try:
            meta = json.loads(mp.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError) as exc:
            _log(f"WARN: {mp} unreadable ({exc}); treating {d.name} as unmarked")
            continue
        t = meta.get("duplicate_of") if isinstance(meta, dict) else None
        if isinstance(t, str) and t:
            raw[d.name] = t
    marks, errors = {}, []
    for x in sorted(raw, key=ordinal_key):
        t = raw[x]
        kind = "self" if t == x else "missing_target" if t not in ids else "chain" if t in raw else None
        if kind:
            errors.append((x, t, kind))
        else:
            marks[x] = t
    for x, t, kind in errors:
        _log(f"WARN: duplicate_of_error {kind}: {x} -> {t}; mark treated as absent (spec 6.1)")
    # Check 4 (`conflict`) needs section 4 grouping, which this script doesn't compute. The corpus
    # write that adds marks is gated on zero grouping errors (6.1), so it holds for committed data.
    _log("WARN: spec 6.1 check 4 (conflict) not evaluated here; relies on the zero-error gate of the mark write")
    return marks, ids, errors


# ── Build ─────────────────────────────────────────────────────────────────────

def load_summaries(summaries_dir):
    docs = {}
    for p in sorted(summaries_dir.glob("*.json"), key=lambda q: ordinal_key(q.name)):
        try:
            s = json.loads(p.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError) as exc:
            _log(f"WARN: {p.name} unreadable ({exc}); skipped")
            continue
        if not isinstance(s, dict):
            _log(f"WARN: {p.name} is not a JSON object; skipped")
            continue
        doc = p.stem
        if s.get("doc_id") and s["doc_id"] != doc:
            _log(f"WARN: {p.name} has doc_id {s['doc_id']!r}; using the file name")
        docs[doc] = s
    return docs


def build_index(summaries, marks):
    """summaries: {doc_id: summary}; marks: {copy id: canonical id} (valid marks only)."""
    groups = {}
    for doc in summaries:
        groups.setdefault(marks.get(doc, doc), []).append(doc)
    index = {}
    for canonical in sorted(groups, key=ordinal_key):
        members = {m: summary_links(summaries[m]) for m in groups[canonical]}
        for node, kept in union_group(canonical, members).items():
            entry = index.setdefault(node, {"facts": [], "keyPoints": []})
            for link in kept:
                if link["record"] is None:
                    continue
                rec = dict(link["record"], doc_id=canonical)
                if "via" in link:
                    rec["via"] = link["via"]
                entry["facts" if link["field"] == "factual_claim" else "keyPoints"].append(rec)
    return {n: e for n, e in index.items() if e["facts"] or e["keyPoints"]}


def serialize(index):
    return json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, help="output path; must be outside the data root")
    ap.add_argument("--data-root")
    ap.add_argument("--sources-root")
    ap.add_argument("--summaries-dir", help="default: <data-root>/summaries")
    a = ap.parse_args(argv)
    data_root, sources_root = resolve_roots(a.data_root, a.sources_root)
    out = Path(a.out).resolve()
    if out == data_root or data_root in out.parents:
        _fail("Write the rebuilt index without touching research data",
              f"--out {out} is inside the data root {data_root}",
              "build-evidence-index.py main",
              "Write to a temp path; replacing the committed index goes through /data-mutation.")
    summaries_dir = Path(a.summaries_dir).resolve() if a.summaries_dir else data_root / "summaries"
    if not summaries_dir.is_dir():
        _fail("Read the summaries to build the index", f"{summaries_dir} does not exist",
              "build-evidence-index.py main", "Pass --data-root or --summaries-dir.")
    summaries = load_summaries(summaries_dir)
    marks, _ids, errors = load_marks(sources_root)
    index = build_index(summaries, marks)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(serialize(index), encoding="utf-8", newline="\n")
    via = sum(1 for e in index.values() for r in e["facts"] + e["keyPoints"] if "via" in r)
    _log(f"wrote {out}: {len(index)} nodes from {len(summaries)} summaries; "
         f"{sum(1 for d in summaries if d in marks)} marked copies folded, {via} via-tagged entries, "
         f"{len(errors)} invalid mark(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
