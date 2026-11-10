#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Tests for the genuine-conflict gate in consolidate_conflicts.py (Orca t/3739 / t/3633; t/209).

The gate keys to the committed t/3350 demotion manifest, never to auto-classification:
a candidate matching a manifest claim_id, or (single-instance only) a normalized assertion
signature, is emitted demoted. Runnable under pytest or standalone.
"""

import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
_SPEC = importlib.util.spec_from_file_location("consolidate_conflicts", _SCRIPTS / "consolidate_conflicts.py")
cc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cc)

_IDS = {"conflict-standalone-1"}
_SIGS = {"36 out of 38 gene synthesis providers fulfilled an order"}


def _c(cid, assertions, status="open", **extra):
    return {"claim_id": cid, "claim_label": cid, "status": status,
            "instances": [{"doc_id": f"d{i}", "assertion": a} for i, a in enumerate(assertions)], **extra}


def _gate(items, ids=_IDS, sigs=_SIGS):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        n = cc.apply_demotion_gate(items, ids, sigs, {"ticket": "t/3350", "data_of_record": "0f38b2e7"})
    return n, err.getvalue()


def test_norm_matches_the_manifest_builders_rule():
    assert cc._norm("  36 Out of 38   gene synthesis providers fulfilled an ORDER.  ") == \
        "36 out of 38 gene synthesis providers fulfilled an order"
    assert cc._norm(None) == ""


def test_claim_id_match_is_demoted_with_the_corpus_shape():
    items = [_c("conflict-standalone-1", ["anything at all"])]
    n, _ = _gate(items)
    assert n == 1
    c = items[0]
    assert (c["status"], c["claim_type"], c["demotion"]["reason"]) == ("demoted", "non_conflict", "standalone_fact")
    assert c["demotion"]["reversible"] is True and "t/3350 manifest" in c["demotion"]["source"]


def test_single_instance_signature_match_is_demoted_even_with_a_new_claim_id():
    items = [_c("conflict-remint-xyz", ["36 out of 38 gene synthesis providers fulfilled an order."])]
    n, _ = _gate(items)
    assert n == 1 and items[0]["status"] == "demoted"


def test_multi_instance_conflict_sharing_one_assertion_is_NOT_demoted():
    """AC4: a genuine multi-instance conflict is never dropped just because one assertion matches."""
    items = [_c("conflict-genuine", ["36 out of 38 gene synthesis providers fulfilled an order",
                                    "Most providers screen orders reliably"])]
    n, _ = _gate(items)
    assert n == 0 and items[0]["status"] == "open" and "claim_type" not in items[0]


def test_unmatched_candidates_are_untouched():
    items = [_c("conflict-other", ["unrelated claim"])]
    before = copy.deepcopy(items)
    n, _ = _gate(items)
    assert n == 0 and items == before


def test_an_already_demoted_entry_keeps_its_original_demotion_record():
    original = {"reason": "standalone_fact", "source": "CL classification (t/3339#6)", "ticket": "t/3350", "reversible": True}
    items = [_c("conflict-standalone-1", ["x"], status="demoted", claim_type="non_conflict", demotion=dict(original))]
    n, _ = _gate(items)
    assert n == 1 and items[0]["demotion"] == original


def test_every_demotion_is_logged_with_provenance_and_a_count():
    items = [_c("conflict-standalone-1", ["a"]), _c("conflict-b", ["36 out of 38 gene synthesis providers fulfilled an order"]),
             _c("conflict-c", ["no"])]
    n, log = _gate(items)
    assert n == 2
    assert log.count("WARN: demoted") == 2 and log.count("in t/3350 manifest") >= 2
    assert "2 candidate(s) demoted" in log


def test_the_gate_uses_no_nli_or_auto_classification():
    """AC2: the gate must not consult the NLI model (or any classifier)."""
    saved = cc.embed_taxonomy._load_nli_model
    cc.embed_taxonomy._load_nli_model = lambda *a, **k: (_ for _ in ()).throw(AssertionError("NLI used by the gate"))
    try:
        _gate([_c("conflict-standalone-1", ["a"]), _c("conflict-z", ["b", "c"])])
    finally:
        cc.embed_taxonomy._load_nli_model = saved


def test_missing_manifest_fails_loudly():
    missing = Path(tempfile.mkdtemp()) / "nope.json"
    try:
        cc.load_demotion_manifest(missing)
    except SystemExit as exc:
        assert "Next Steps:" in str(exc) and "432" in str(exc)
        return
    raise AssertionError("expected SystemExit for a missing manifest")


def test_committed_manifest_loads_432_entries():
    ids, sigs, prov = cc.load_demotion_manifest()
    assert len(ids) == 432 and sigs and prov.get("data_of_record") == "0f38b2e7"


def _corpus():
    import os
    root = Path(os.environ["AI_TRIAD_DATA_ROOT"]) if os.environ.get("AI_TRIAD_DATA_ROOT") else cc._resolve_data_root()
    p = root / "conflicts" / "conflicts.json"
    return json.loads(p.read_text(encoding="utf-8"))["conflicts"] if p.exists() else None


def test_real_corpus_gate_reproduces_the_432_and_drops_no_live_conflict():
    """AC1 + AC4 against data of record: the gate demotes exactly the 432 already-demoted facts, and
    no conflict that is live today (multi-instance or not) is demoted."""
    conflicts = _corpus()
    if conflicts is None:
        import pytest
        pytest.skip("ai-triad-data conflicts.json not available here (data-of-record check runs where the data repo is checked out)")
    ids, sigs, prov = cc.load_demotion_manifest()
    before = {c["claim_id"]: c.get("status") for c in conflicts}
    items = copy.deepcopy(conflicts)
    with contextlib.redirect_stderr(io.StringIO()):
        n = cc.apply_demotion_gate(items, ids, sigs, prov)
    demoted_now = {c["claim_id"] for c in items if c.get("status") == "demoted"}
    was_demoted = {cid for cid, s in before.items() if s == "demoted"}
    assert n == 432
    assert demoted_now == was_demoted, "the gate must demote exactly the t/3350 set"
    newly = [c for c in items if c["claim_id"] in demoted_now - was_demoted]
    assert not newly, f"live conflicts wrongly demoted: {[c['claim_id'] for c in newly][:5]}"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
