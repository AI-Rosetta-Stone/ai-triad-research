#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Tests for scripts/build-evidence-index.py (t/231). Synthetic data only; no data repo needed.

The spec 7 functions assert the shared fixture tests/fixtures/evidence-union-cases.json, the
same one the PowerShell and TypeScript implementations assert. Runnable under pytest or standalone.
"""

import contextlib
import importlib.util
import io
import json
import tempfile
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("build_evidence_index", _SCRIPTS / "build-evidence-index.py")
bei = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(bei)
_FIXTURE = json.loads((_SCRIPTS.parent / "tests" / "fixtures" / "evidence-union-cases.json").read_text(encoding="utf-8"))


def _summary(kps=(), fcs=(), ucs=()):
    return {"pov_summaries": {"safetyist": {"key_points": list(kps)}}, "factual_claims": list(fcs), "unmapped_concepts": list(ucs)}


def _kp(node, verbatim, point="A point.", stance="aligned"):
    return {"taxonomy_node_id": node, "verbatim": verbatim, "point": point, "stance": stance}


def _fc(nodes, claim, label="L", spec="precise", tb=None):
    return {"claim": claim, "claim_label": label, "linked_taxonomy_nodes": nodes,
            "evidence_criteria": {"specificity": spec}, "temporal_bound": tb}


def _corpus(tmp, summaries, metadata):
    data, src = Path(tmp) / "data", Path(tmp) / "sources"
    (data / "summaries").mkdir(parents=True)
    for doc, s in summaries.items():
        (data / "summaries" / f"{doc}.json").write_text(json.dumps(s), encoding="utf-8")
    for doc, m in metadata.items():
        (src / doc).mkdir(parents=True)
        if m is not None:
            (src / doc / "metadata.json").write_text(json.dumps(m), encoding="utf-8")
    return data, src


def _run(*args):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        rc = bei.main(list(args))
    return rc, err.getvalue()


# ── Shared spec 7 fixture ─────────────────────────────────────────────────────

def test_key_cases_match_the_shared_fixture():
    for c in _FIXTURE["key_cases"]:
        assert bei.evidence_key(c["quote"]) == c["expected_key"], c["name"]


def test_near_cases_match_the_shared_fixture():
    for c in _FIXTURE["near_cases"]:
        assert bei.near_equal(c["a"], c["b"]) is c["expected"], c["name"]


def test_link_cases_match_the_shared_fixture():
    for c in _FIXTURE["link_cases"]:
        got = [{k: l[k] for k in ("node", "field", "quote")} for l in bei.summary_links(c["summary"])]
        assert got == c["expected_links"], c["name"]


def test_union_cases_match_the_shared_fixture():
    for c in _FIXTURE["union_cases"]:
        members = {m["id"]: [dict(l, record=None) for l in m["links"]] for m in c["members"]}
        got = {n: [{k: v for k, v in l.items() if k != "record"} for l in ls]
               for n, ls in bei.union_group(c["canonical"], members).items()}
        assert got == c["expected"], c["name"]


# ── Shared fixture v3: summary-only chunks (t/355) ────────────────────────────

def _v3(docs):
    """Fixture docs -> (marks, has_source). A mark is valid when it names another doc (6.1)."""
    marks = {d: v["mark"] for d, v in docs.items() if v.get("mark") and v["mark"] != d and v["mark"] in docs}
    return marks, {d for d, v in docs.items() if v.get("has_source")}


def _v3_union(case):
    docs, canonical = case["docs"], case["canonical"]
    marks, has_source = _v3(docs)
    order = bei.group_members(canonical, list(docs), marks, has_source)
    for m in order:
        for f in bei.N2_FIELDS:
            if docs[m["id"]].get(f):
                m[f] = docs[m["id"]][f]
    members = {d: bei.summary_links(v["summary"]) for d, v in docs.items() if "summary" in v}
    got = bei.union_group(canonical, members, order)
    return {n: [{k: v for k, v in l.items() if k != "record"} for l in ls] for n, ls in got.items()}


def test_resolve_cases_match_the_shared_fixture():
    assert _FIXTURE["resolve_cases"]
    for c in _FIXTURE["resolve_cases"]:
        marks, has_source = _v3(c["docs"])
        assert bei.resolve_doc(c["id"], marks, has_source) == c["expected"], c["name"]


def test_chunk_union_cases_match_the_shared_fixture():
    assert _FIXTURE["chunk_union_cases"]
    for c in _FIXTURE["chunk_union_cases"]:
        assert _v3_union(c) == c["expected"], c["name"]
        # 7.6 as amended (t/373): extraction reads every kept fact, so the two sets are equal.
        assert _v3_union(c) == c["expected_extracted"], c["name"]


def test_each_chunk_case_is_one_document():
    for c in _FIXTURE["chunk_union_cases"]:
        marks, has_source = _v3(c["docs"])
        assert len({bei.resolve_doc(d, marks, has_source) for d in c["docs"]}) == c["expected_documents"], c["name"]


def test_group_order_is_copies_then_own_chunks_then_copy_chunks_by_n():
    has_source = {"d-2026", "b-2026", "a-2026"}
    marks = {"b-2026": "d-2026", "a-2026": "d-2026"}
    docs = ["b-2026-1", "d-2026-10", "a-2026-2", "d-2026-2", "b-2026", "a-2026", "d-2026", "a-2026-1", "other-2026"]
    got = [(m["id"], m["kind"], m["via"]) for m in bei.group_members("d-2026", docs, marks, has_source)]
    assert got == [("a-2026", "copy", None), ("b-2026", "copy", None),
                   ("d-2026-2", "chunk_D", None), ("d-2026-10", "chunk_D", None),
                   ("a-2026-1", "chunk_copy", "a-2026"), ("a-2026-2", "chunk_copy", "a-2026"),
                   ("b-2026-1", "chunk_copy", "b-2026")]


def test_a_mark_loop_is_refused():
    try:
        bei.resolve_doc("a", {"a": "b", "b": "a"}, set())
    except SystemExit as exc:
        assert "loops back" in str(exc) and "Next Steps:" in str(exc)
        return
    raise AssertionError("expected SystemExit for a mark loop")


def test_cli_folds_a_summary_only_chunk_into_its_base_as_one_document():
    """t/355: before the fold, d-2026-1 was indexed as its own doc_id."""
    canon = _summary(kps=[_kp("n1", "The model refused the request.")])
    chunk = dict(_summary(kps=[_kp("n1", "The model refused the request!"), _kp("n1", "A passage only the chunk cited.")],
                          fcs=[_fc(["n2"], "A fact only the chunk found.")]),
                 generated_at="2026-03-26T10:00:00Z", ai_model="gemini-3.5-flash-lite")
    orphan = _summary(kps=[_kp("n3", "An orphan passage.")])
    with tempfile.TemporaryDirectory() as tmp:
        data, src = _corpus(tmp, {"d-2026": canon, "d-2026-1": chunk, "x-2026-1": orphan}, {"d-2026": {}})
        out = Path(tmp) / "out" / "sei.json"
        rc, err = _run("--data-root", str(data), "--sources-root", str(src), "--out", str(out))
        idx = json.loads(out.read_text(encoding="utf-8"))
    assert rc == 0
    kps = idx["n1"]["keyPoints"]
    assert [k["verbatim"] for k in kps] == ["The model refused the request.", "A passage only the chunk cited."]
    assert {k["doc_id"] for k in kps} == {"d-2026"} and "chunk_of" not in kps[0]
    assert kps[1]["chunk_of"] == "d-2026-1" and "via" not in kps[1]
    assert kps[1]["chunk_generated_at"] == "2026-03-26T10:00:00Z" and kps[1]["chunk_model"] == "gemini-3.5-flash-lite"
    fact = idx["n2"]["facts"][0]
    assert fact["doc_id"] == "d-2026" and fact["chunk_of"] == "d-2026-1"
    # No base with a source dir: the orphan stays its own document and is reported (t/355#9).
    assert idx["n3"]["keyPoints"][0]["doc_id"] == "x-2026-1"
    assert "WARN: source_missing: 1 summaries" in err and "x-2026-1" in err
    assert "1 summary-only chunks folded, 2 chunk_of-tagged entries" in err


# ── Index records ─────────────────────────────────────────────────────────────

def test_records_have_the_reader_contract_shape_and_truncation():
    s = _summary(kps=[_kp("saf-beliefs-001", "v" * 300, point="p" * 300)],
                 fcs=[_fc(["saf-beliefs-001"], "A claim.", tb="2025")])
    idx = bei.build_index({"d-2026": s}, {})
    kp = idx["saf-beliefs-001"]["keyPoints"][0]
    assert kp == {"stance": "aligned", "pov": "safetyist", "point": "p" * 250, "verbatim": "v" * 200, "doc_id": "d-2026"}
    assert idx["saf-beliefs-001"]["facts"][0] == {"claim": "A claim.", "label": "L", "doc_id": "d-2026",
                                                   "specificity": "precise", "temporal_bound": "2025"}


def test_missing_specificity_is_unknown_and_non_string_nodes_are_not_links():
    """The 2026-05 index filed 11 facts under a literal "null" node; a null id isn't a 7.1 link."""
    fc = _fc([None, "acc-beliefs-002"], "C.")
    del fc["evidence_criteria"]
    idx = bei.build_index({"d": _summary(fcs=[fc])}, {})
    assert list(idx) == ["acc-beliefs-002"] and idx["acc-beliefs-002"]["facts"][0]["specificity"] == "unknown"


def test_unmapped_concepts_dedupe_but_are_not_emitted():
    s = _summary(ucs=[{"resolved_node_id": "n1", "verbatim": "Only an unmapped concept."}])
    assert bei.build_index({"d": s}, {}) == {}


# ── Spec 6.3 / 7: marked copies ───────────────────────────────────────────────

def test_a_marked_copy_folds_into_its_canonical_with_via_and_near_duplicates_dropped():
    canon = _summary(kps=[_kp("n1", "The model refused the request.")])
    copy = _summary(kps=[_kp("n1", "The model refused the request!"), _kp("n1", "A passage only the copy cited.")],
                    fcs=[_fc(["n2"], "A fact only the copy found.")])
    idx = bei.build_index({"c-2026": canon, "c-2026-1": copy}, {"c-2026-1": "c-2026"})
    kps = idx["n1"]["keyPoints"]
    assert [k["verbatim"] for k in kps] == ["The model refused the request.", "A passage only the copy cited."]
    assert "via" not in kps[0] and kps[1]["via"] == "c-2026-1" and kps[1]["doc_id"] == "c-2026"
    assert idx["n2"]["facts"][0]["doc_id"] == "c-2026" and idx["n2"]["facts"][0]["via"] == "c-2026-1"


def test_invalid_marks_are_logged_and_treated_as_absent():
    with tempfile.TemporaryDirectory() as tmp:
        _, src = _corpus(tmp, {}, {"a": {"duplicate_of": "a"}, "b": {"duplicate_of": "nope"},
                                   "c": {"duplicate_of": "d"}, "d": {"duplicate_of": "e"}, "e": {}, "f": None})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            marks, _ids, errors = bei.load_marks(src)
    assert marks == {"d": "e"}
    assert [(x, k) for x, _t, k in errors] == [("a", "self"), ("b", "missing_target"), ("c", "chain")]
    assert err.getvalue().count("WARN: duplicate_of_error") == 3 and "check 4 (conflict) not evaluated" in err.getvalue()


# ── CLI: read-only, deterministic ─────────────────────────────────────────────

def test_cli_is_deterministic_and_writes_only_to_out():
    with tempfile.TemporaryDirectory() as tmp:
        data, src = _corpus(tmp, {"z-2026": _summary(kps=[_kp("n2", "Q2")]), "a-2026": _summary(kps=[_kp("n2", "Q1"), _kp("n1", "Q0")])},
                            {"z-2026": {}, "a-2026": {}})
        before = sorted((p.relative_to(tmp).as_posix(), p.read_bytes()) for p in Path(tmp).rglob("*") if p.is_file())
        o1, o2 = Path(tmp) / "out" / "a.json", Path(tmp) / "out" / "b.json"
        assert _run("--data-root", str(data), "--sources-root", str(src), "--out", str(o1))[0] == 0
        assert _run("--data-root", str(data), "--sources-root", str(src), "--out", str(o2))[0] == 0
        after = sorted((p.relative_to(tmp).as_posix(), p.read_bytes()) for p in Path(tmp).rglob("*") if p.is_file() and "out" not in p.parts)
        assert before == after
        assert o1.read_bytes() == o2.read_bytes()
        idx = json.loads(o1.read_text(encoding="utf-8"))
        assert list(idx) == ["n1", "n2"] and [k["doc_id"] for k in idx["n2"]["keyPoints"]] == ["a-2026", "z-2026"]


def test_cli_refuses_an_out_path_inside_the_data_or_sources_root():
    with tempfile.TemporaryDirectory() as tmp:
        data, src = _corpus(tmp, {}, {"d": {}})
        for target in (data / "taxonomy" / "Origin" / "source_evidence_index.json", src / "d" / "sei.json"):
            try:
                _run("--data-root", str(data), "--sources-root", str(src), "--out", str(target))
            except SystemExit as exc:
                assert "data-mutation" in str(exc) and "Next Steps:" in str(exc)
                assert not target.exists()
                continue
            raise AssertionError(f"expected SystemExit for --out {target}")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
