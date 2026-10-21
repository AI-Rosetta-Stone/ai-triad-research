# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
"""Generates tests/fixtures/evidence-union-cases.json (docs/specs/source-identity.md section 7).

An independent from-spec implementation in Python, deliberately not shared with the PowerShell
(scripts/AITriad/Private/EvidenceUnion.ps1) or TypeScript implementations: both assert this
fixture, so a reading of the spec that differs between stacks fails a test. Run from the repo root:

    python scripts/new_evidence_union_fixture.py
"""
import json
import os
import unicodedata

SEQ = {"ΓÇÖ": "'", "ΓÇÿ": "'", "ΓÇ£": '"', "ΓÇ¥": '"',
       "ΓÇô": "-", "ΓÇö": "-", "ΓÇª": "..."}
SINGLE = {"Æ": "'", "æ": "'", "ô": '"', "ö": '"', "û": "-", "ù": "-"}
TYPO = {"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-"}


def key(q):
    """Spec 7.2."""
    if not q:
        return ""
    for k, v in SEQ.items():
        q = q.replace(k, v)
    for k, v in SINGLE.items():
        q = q.replace(k, v)
    q = unicodedata.normalize("NFKC", q)
    for k, v in TYPO.items():
        q = q.replace(k, v)
    q = q.lower()
    q = "".join(c if unicodedata.category(c).startswith("L") or unicodedata.category(c) == "Nd" else " " for c in q)
    return " ".join(t for t in q.split(" ") if t)  # step 6: collapse runs of spaces, trim


def utf16(s):
    return s.encode("utf-16-le")


def lev(a, b):
    a = [utf16(a)[i:i + 2] for i in range(0, len(utf16(a)), 2)]
    b = [utf16(b)[i:i + 2] for i in range(0, len(utf16(b)), 2)]
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[len(b)]


def u16len(s):
    return len(utf16(s)) // 2


def near(a, b):
    """Spec 7.3, integer thresholds."""
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    ta, tb = set(a.split(" ")), set(b.split(" "))
    inter = len(ta & tb)
    if 5 * inter >= 4 * len(ta | tb):
        return True
    m = max(u16len(a), u16len(b))
    return 20 * (m - lev(a, b)) >= 17 * m


def links(summary):
    """Spec 7.1."""
    out = []
    def text(o, names):
        for n in names:
            v = o.get(n) if isinstance(o, dict) else None
            if isinstance(v, str) and v.strip():
                return v
        return ""
    is_node = lambda v: isinstance(v, str) and len(v) > 0
    for _pov, block in (summary.get("pov_summaries") or {}).items():
        for kp in (block or {}).get("key_points") or []:
            if isinstance(kp, dict) and is_node(kp.get("taxonomy_node_id")):
                out.append({"node": kp["taxonomy_node_id"], "field": "key_point", "quote": text(kp, ["verbatim", "point"])})
    for fc in summary.get("factual_claims") or []:
        if not isinstance(fc, dict):
            continue
        q = text(fc, ["claim"])
        for f in ("linked_taxonomy_nodes", "potential_taxonomy_nodes"):
            for n in fc.get(f) or []:
                if is_node(n):
                    out.append({"node": n, "field": "factual_claim", "quote": q})
    for uc in summary.get("unmapped_concepts") or []:
        if isinstance(uc, dict) and is_node(uc.get("resolved_node_id")):
            out.append({"node": uc["resolved_node_id"], "field": "unmapped_concept",
                        "quote": text(uc, ["verbatim", "suggested_description", "description", "concept", "suggested_label"])})
    return out


def union(canonical, members):
    """Spec 7.4. members: {id: [links]} in any order."""
    order = [canonical] + sorted((i for i in members if i != canonical), key=utf16_sort)
    out, keys = {}, {}
    for mid in order:
        own = mid == canonical
        for l in members.get(mid, []):
            n, k = l["node"], key(l["quote"])
            out.setdefault(n, []); keys.setdefault(n, [])
            if not own and any(near(k, kk) for kk in keys[n]):
                continue
            e = {"node": n, "field": l["field"], "quote": l["quote"], "doc": canonical}
            if not own:
                e["via"] = mid
            out[n].append(e); keys[n].append(k)
    return out


def utf16_sort(s):
    # Ordinal order is UTF-16 code-unit order in .NET (StringComparer.Ordinal) and JavaScript.
    return [int.from_bytes(utf16(s)[i:i + 2], "little") for i in range(0, len(utf16(s)), 2)]


L = lambda node, quote, field="key_point": {"node": node, "field": field, "quote": quote}
A20 = "abcdefghijklmnopqrst"

KEY_INPUTS = [
    ("ascii punctuation", "The U.S. will 'double down' — now!"),
    ("typographic quotes and dashes", "government’s “AI” plan – 2025"),
    ("variant A mojibake (cp1252 read as cp437)", "governmentÆs ôAIö plan û 2025"),
    ("variant B mojibake (UTF-8 read as cp437)", "governmentΓÇÖs ΓÇ£AIΓÇ¥ plan ΓÇô 2025"),
    ("variant B ellipsis is repaired before NFKC turns U+00AA into 'a'", "wait ΓÇª what"),
    ("NFKC: ligature and fullwidth", "ﬁnance ＡＩ"),
    ("NFKC: superscript digit and roman numeral", "x² chapter Ⅻ"),
    ("a real French a-grave is kept; o-circumflex is mapped (key only)", "voilà le côté"),
    ("Greek capital theta is not mapped; it lowercases", "caf Θ"),
    ("digits and decimal separators", "1,234.5 percent"),
    ("Cyrillic letters are kept", "Привет мир"),
    ("underscore is a separator", "snake_case"),
    ("combining acute composes under NFKC", "café"),
    ("whitespace only", "  \t \n "),
    ("empty", ""),
]

NEAR_INPUTS = [
    ("either key empty is never near", "", "anything"),
    ("equal", "the us tech stack", "the us tech stack"),
    ("containment", "double down on exporting", "the us will double down on exporting the stack"),
    ("token Jaccard exactly 0.8 (4 of 5) is near", "alpha beta gamma delta", "delta gamma beta alpha epsilon"),
    ("token Jaccard 4 of 6 is not near", "alpha beta gamma delta zeta", "delta gamma beta alpha epsilon"),
    ("Levenshtein exactly at the bound (m=20, lev=3) is near", A20, "abcXefghiXklmnoXqrst"),
    ("Levenshtein one past the bound (m=20, lev=4) is not near", A20, "abcXefghiXklmnoXqrsX"),
    ("length-difference bound: lev=4 with 3 deletions is not near", A20, "xbcdefghijklmnopq"),
    ("tokens compare as sets (repeats don't count twice)", "risk risk risk policy", "policy risk"),
]

EXTRACT_SUMMARY = {
    "doc_id": "ex-2026",
    "pov_summaries": {
        "skeptic": {"key_points": [
            {"taxonomy_node_id": "skp-beliefs-001", "point": "Point only, no verbatim."},
            {"taxonomy_node_id": "", "verbatim": "an empty node id is not a link"}]},
        "accelerationist": {"key_points": [
            {"taxonomy_node_id": "acc-desires-021", "verbatim": "Verbatim wins.", "point": "Not this."},
            {"taxonomy_node_id": 42, "verbatim": "a non-string node id is not a link"}]},
    },
    "factual_claims": [
        {"claim": "Two nodes and a legacy one.", "linked_taxonomy_nodes": ["acc-beliefs-025", "saf-beliefs-017"],
         "potential_taxonomy_nodes": ["skp-beliefs-041"]},
        {"claim": "No nodes.", "linked_taxonomy_nodes": []},
    ],
    "unmapped_concepts": [
        {"suggested_label": "Label fallback", "resolved_node_id": "saf-intentions-081"},
        {"suggested_label": "Unresolved", "resolved_node_id": None},
    ],
}

UNION_INPUTS = [
    ("the canonical's own repeats are all kept", "c-2026",
     {"c-2026": [L("n1", "Same quote."), L("n1", "Same quote.")]}),
    ("a near-equal copy link is dropped; a distinct one is kept with via", "c-2026",
     {"c-2026": [L("n1", "The US will double down on exporting its tech stack.")],
      "c-2026-1": [L("n1", "the US will double-down on exporting its tech stack"), L("n1", "Countries think they must control AI before it controls them.")]}),
    ("the canonical wins a containment tie", "c-2026",
     {"c-2026": [L("n1", "AI plan 2025 (draft)")], "c-2026-1": [L("n1", "AI plan 2025")]}),
    ("a node only a copy links keeps its group attribution", "c-2026",
     {"c-2026": [L("n1", "Canonical point.")], "c-2026-1": [L("n9", "Only the copy saw this.", "factual_claim")]}),
    ("two copies with the same distinct quote: the ordinal-first copy is kept", "c-2026",
     {"c-2026": [], "c-2026-2": [L("n1", "Shared distinct claim.")], "c-2026-10": [L("n1", "Shared distinct claim.")], "c-2026-1": [L("n1", "Shared distinct claim!")]}),
    ("members are ordered by the function, not the caller (ordinal: -1 < -10 < -2)", "c-2026",
     {"c-2026-2": [L("n1", "Beta claim about policy.")], "c-2026-10": [L("n1", "Alpha claim about compute.")], "c-2026": [], "c-2026-1": [L("n1", "Gamma claim about safety.")]}),
    ("mojibake in a copy is matched to the clean canonical", "c-2026",
     {"c-2026": [L("n1", "The government’s “AI” plan – 2025.")],
      "c-2026-1": [L("n1", "The governmentÆs ôAIö plan û 2025.")],
      "c-2026-2": [L("n1", "The governmentΓÇÖs ΓÇ£AIΓÇ¥ plan ΓÇô 2025.")]}),
    ("de-dup is per node: the same quote on another node is kept", "c-2026",
     {"c-2026": [L("n1", "One claim.")], "c-2026-1": [L("n2", "One claim.")]}),
    ("a copy link is compared with kept copy links too (greedy, in order)", "c-2026",
     {"c-2026": [L("n1", "Unrelated canonical text about compute governance.")],
      "c-2026-1": [L("n1", "Export controls on advanced chips will tighten in 2026.")],
      "c-2026-2": [L("n1", "export controls on advanced chips will tighten in 2026")]}),
    ("an empty quote has an empty key, is never near, and is kept", "c-2026",
     {"c-2026": [L("n1", "")], "c-2026-1": [L("n1", "")]}),
    ("the canonical goes first even when a copy's id sorts before it (spec 6: the target, not the smallest id)", "omega-2026",
     {"aaa-mirror-2026": [L("n1", "AI plan 2025")], "omega-2026": [L("n1", "AI plan 2025 (draft)")]}),
]


POV_CODES = [("accelerationist", "acc"), ("safetyist", "saf"), ("skeptic", "skp")]


def containers(summary, doc):
    """Summary mention containers (mentionTypes.ts registry; Get-MentionContainerText kp/fc): key -> NFC text."""
    out = {}
    povs = summary.get("pov_summaries") or {}
    for pov, code in POV_CODES:
        kps = (povs.get(pov) or {}).get("key_points") or []
        for n, kp in enumerate(kps):
            p = kp.get("point") if isinstance(kp, dict) else None
            t = unicodedata.normalize("NFC", p) if isinstance(p, str) and p != "" else ""
            if t:
                out[f"summary:{doc}#{code}-kp-{n}"] = t
    for i, fc in enumerate(summary.get("factual_claims") or []):
        c = fc.get("claim") if isinstance(fc, dict) else None
        t = unicodedata.normalize("NFC", c) if isinstance(c, str) and c != "" else ""
        if t:
            out[f"summary:{doc}#fc-{i}"] = t
    return out


def mention_union(canonical, summaries):
    """Spec 7.7: the union containers a group adds, keyed summary:<canonical>#via-<copy>-<item>."""
    keys = [key(t) for t in containers(summaries.get(canonical, {}), canonical).values()]
    out = {}
    for copy in sorted((i for i in summaries if i != canonical), key=utf16_sort):
        for cid, text in containers(summaries[copy], "x").items():
            k = key(text)
            if any(near(k, kk) for kk in keys):
                continue
            keys.append(k)
            out[f"summary:{canonical}#via-{copy}-{cid[len('summary:x#'):]}"] = text
    return out


def S(kps=(), fcs=(), pov="safetyist"):
    return {"pov_summaries": {pov: {"key_points": [{"point": p} for p in kps]}}, "factual_claims": [{"claim": c} for c in fcs]}


MENTION_INPUTS = [
    ("a distinct key point and claim get via keys with the copy's own indices; a near-duplicate gets none", "c-2026",
     {"c-2026": S(["The plan exports the US stack."], ["Claim one."]),
      "c-2026-1": S(["The plan exports the US stack", "Countries want sovereign AI."], ["Claim one", "A claim only the copy found."])}),
    ("two copies with the same distinct item: only the ordinal-first copy's (-1 < -10 < -2)", "c-2026",
     {"c-2026": S(["Canonical point."]), "c-2026-2": S(["Shared distinct point."]), "c-2026-10": S(["Shared distinct point."]), "c-2026-1": S(["Shared distinct point!"])}),
    ("an empty item makes no container but still advances its index", "c-2026",
     {"c-2026": S(["Canonical point."]), "c-2026-1": S(["", "Second point is new."], pov="skeptic")}),
    ("a group whose canonical has no summary: copy items still land under the canonical's namespace", "c-2026",
     {"c-2026-1": S([], ["Only claim."])}),
]

DERIVED_KEY_CASES = [
    ("summary:a-2026#fc-0", False), ("summary:a-2026#saf-kp-2", False),
    ("summary:a-2026#via-a-2026-1-fc-0", True), ("summary:a-2026#via-b-2026-10-acc-kp-3", True),
    ("sei:acc-beliefs-001", False), ("node:saf-beliefs-001", False), ("debate-1#entry-2", False),
    # 'via-' outside the derived position is not a derived key.
    ("summary:via-report-2026#fc-0", False), ("node:via-x-2026", False), ("summary:a-2026#acc-kp-0-via-b", False),
]


def main():
    fixture = {
        "spec": "docs/specs/source-identity.md section 7",
        "version": 2,
        "generator": "scripts/new_evidence_union_fixture.py",
        "key_cases": [{"name": n, "quote": q, "expected_key": key(q)} for n, q in KEY_INPUTS],
        "near_cases": [{"name": n, "a": a, "b": b, "expected": near(a, b)} for n, a, b in NEAR_INPUTS],
        "link_cases": [{"name": "the C9 link fields, in file order", "summary": EXTRACT_SUMMARY, "expected_links": links(EXTRACT_SUMMARY)}],
        "union_cases": [{"name": n, "canonical": c, "members": [{"id": i, "links": ls} for i, ls in m.items()],
                         "expected": union(c, m)} for n, c, m in UNION_INPUTS],
        # v2 (spec 7.7, TL p/360#661): the mention-container form of the union, and the derived-key test.
        "mention_key_cases": [{"name": n, "canonical": c, "summaries": [{"id": i, "summary": s} for i, s in m.items()],
                               "expected_containers": mention_union(c, m)} for n, c, m in MENTION_INPUTS],
        "derived_key_regex": "^summary:[^#]+#via-",
        "derived_key_cases": [{"key": k, "derived": d} for k, d in DERIVED_KEY_CASES],
    }
    # Self-checks on the intended outcome of each boundary case, so a generator bug can't silently
    # bake a wrong expectation into the fixture.
    want = {"either key empty is never near": False, "equal": True, "containment": True,
            "token Jaccard exactly 0.8 (4 of 5) is near": True, "token Jaccard 4 of 6 is not near": False,
            "Levenshtein exactly at the bound (m=20, lev=3) is near": True,
            "Levenshtein one past the bound (m=20, lev=4) is not near": False,
            "length-difference bound: lev=4 with 3 deletions is not near": False,
            "tokens compare as sets (repeats don't count twice)": True}
    for c in fixture["near_cases"]:
        assert c["expected"] == want[c["name"]], c["name"]
    k = {c["name"]: c["expected_key"] for c in fixture["key_cases"]}
    assert k["typographic quotes and dashes"] == k["variant A mojibake (cp1252 read as cp437)"] == k["variant B mojibake (UTF-8 read as cp437)"] == "government s ai plan 2025"
    assert k["variant B ellipsis is repaired before NFKC turns U+00AA into 'a'"] == "wait what"
    u = {c["name"]: c["expected"] for c in fixture["union_cases"]}
    assert len(u["the canonical's own repeats are all kept"]["n1"]) == 2
    assert [e.get("via") for e in u["a near-equal copy link is dropped; a distinct one is kept with via"]["n1"]] == [None, "c-2026-1"]
    assert len(u["the canonical wins a containment tie"]["n1"]) == 1
    assert u["a node only a copy links keeps its group attribution"]["n9"][0]["via"] == "c-2026-1"
    assert [e["via"] for e in u["two copies with the same distinct quote: the ordinal-first copy is kept"]["n1"]] == ["c-2026-1"]
    assert [e["via"] for e in u["members are ordered by the function, not the caller (ordinal: -1 < -10 < -2)"]["n1"]] == ["c-2026-1", "c-2026-10", "c-2026-2"]
    assert len(u["mojibake in a copy is matched to the clean canonical"]["n1"]) == 1
    assert len(u["a copy link is compared with kept copy links too (greedy, in order)"]["n1"]) == 2
    assert len(u["an empty quote has an empty key, is never near, and is kept"]["n1"]) == 2
    first = u["the canonical goes first even when a copy's id sorts before it (spec 6: the target, not the smallest id)"]["n1"]
    assert [(e["quote"], e.get("via")) for e in first] == [("AI plan 2025 (draft)", None)]
    mk = {c["name"]: c["expected_containers"] for c in fixture["mention_key_cases"]}
    assert mk["a distinct key point and claim get via keys with the copy's own indices; a near-duplicate gets none"] == {
        "summary:c-2026#via-c-2026-1-saf-kp-1": "Countries want sovereign AI.", "summary:c-2026#via-c-2026-1-fc-1": "A claim only the copy found."}
    assert list(mk["two copies with the same distinct item: only the ordinal-first copy's (-1 < -10 < -2)"]) == ["summary:c-2026#via-c-2026-1-saf-kp-0"]
    assert list(mk["an empty item makes no container but still advances its index"]) == ["summary:c-2026#via-c-2026-1-skp-kp-1"]
    assert list(mk["a group whose canonical has no summary: copy items still land under the canonical's namespace"]) == ["summary:c-2026#via-c-2026-1-fc-0"]
    import re
    for c in fixture["derived_key_cases"]:
        assert bool(re.match(fixture["derived_key_regex"], c["key"])) == c["derived"], c["key"]

    path = os.path.join("tests", "fixtures", "evidence-union-cases.json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {path}: key={len(fixture['key_cases'])} near={len(fixture['near_cases'])} "
          f"link={len(fixture['link_cases'])} union={len(fixture['union_cases'])}")


if __name__ == "__main__":
    main()
