#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Unit tests for nli_classify.py — the shared directional-agreement engine (t/2751).

Exercises the engine's OWN logic (framing plumbing, label->direction mapping, the
tau_contra floor, and the fail-safe) WITHOUT the deberta model by monkeypatching
the classifier embed_taxonomy exposes. `test_richness_guard_real_model` adds the
GV richness arm on the actual model (skips offline): node-proposition richness —
NOT framing — is what catches an inversion (CL 2x2, t/2744#7). Together they guard
mapping/fail-safe/richness so the gate can never regress unnoticed.

Runnable under pytest or standalone: `python test_nli_classify.py`.
"""

import importlib.util
import sys
from pathlib import Path

_DIR = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, _DIR / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Register embed_taxonomy in sys.modules BEFORE loading nli_classify, so the
# deferred `from embed_taxonomy import ...` inside judge_direction resolves to
# THIS instance — the one the tests monkeypatch — not a fresh real import.
embed_taxonomy = _load("embed_taxonomy")
sys.modules["embed_taxonomy"] = embed_taxonomy
nli_classify = _load("nli_classify")

# Real deberta driver, saved before any monkeypatch — the richness guard restores
# these to run against the actual model (it skips if the model can't load).
_REAL_LOAD = embed_taxonomy._load_nli_model
_REAL_CLASSIFY = embed_taxonomy._classify_pairs_nli


def _stub_classifier(result_for):
    """Install a fake deberta driver keyed by a marker in the hypothesis text."""
    embed_taxonomy._load_nli_model = lambda: object()

    def fake(model, pairs):
        out = []
        for (_a, b) in pairs:
            out.append(result_for(b))
        return out

    embed_taxonomy._classify_pairs_nli = fake


def _res(label, margin):
    return {"label": label, "entailment": 0.0, "neutral": 0.0,
            "contradiction": 0.0, "margin": margin}


def test_framing_is_applied_and_single_sourced():
    _stub_classifier(lambda b: _res("contradiction", 1.3))
    out = nli_classify.judge_direction(
        [{"id": "p", "claim_prop": "ordinary law applies",
          "claim_pov": "accelerationist", "node_prop": "AI needs new laws",
          "node_pov": "accelerationist"}])
    assert out[0]["framed_a"] == "The accelerationist position is: ordinary law applies"
    assert out[0]["framed_b"] == "The accelerationist position is: AI needs new laws"
    assert out[0]["direction"] == "opposes"


def test_label_to_direction_mapping():
    cases = [("contradiction", 1.3, "opposes"),
             ("entailment", 5.0, "agrees"),
             ("neutral", 4.0, "unrelated")]
    for label, margin, expected in cases:
        _stub_classifier(lambda b, _l=label, _m=margin: _res(_l, _m))
        out = nli_classify.judge_direction(
            [{"claim_prop": "a", "node_prop": "b"}])
        assert out[0]["direction"] == expected, (label, out[0]["direction"])


def test_tau_contra_floor_downgrades_weak_contradiction_to_unresolved():
    # A contradiction below tau_contra must NOT emit a (false) opposes.
    _stub_classifier(lambda b: _res("contradiction", 0.5))
    out = nli_classify.judge_direction(
        [{"claim_prop": "a", "node_prop": "b"}], tau_contra=1.0)
    assert out[0]["direction"] == "unresolved"


def test_failsafe_on_engine_error_is_unresolved_never_opposes():
    def boom():
        raise RuntimeError("model unavailable")
    embed_taxonomy._load_nli_model = boom
    out = nli_classify.judge_direction([{"claim_prop": "a", "node_prop": "b"}])
    assert out[0]["direction"] == "unresolved"
    assert out[0]["method"] == "none"


def test_empty_proposition_is_unresolved_without_calling_model():
    def boom(*_a, **_k):
        raise AssertionError("model must not be called for an empty proposition")
    embed_taxonomy._load_nli_model = boom
    out = nli_classify.judge_direction([{"claim_prop": "a", "node_prop": ""}])
    assert out[0]["direction"] == "unresolved"
    assert out[0]["method"] == "none"


def test_no_framing_passes_raw_text():
    # Plumbing only: --no-framing must feed the raw prop (no "The <pov> position
    # is:" prefix) to the classifier. NOTE: framing is INERT on the verdict
    # (CL t/2744#7 2x2) — the semantic lever is node richness, guarded by
    # test_richness_guard_real_model below. This test just pins the flag's wiring.
    captured = {}

    def fake(model, pairs):
        captured["pairs"] = pairs
        return [_res("entailment", 5.0) for _ in pairs]
    embed_taxonomy._load_nli_model = lambda: object()
    embed_taxonomy._classify_pairs_nli = fake

    out = nli_classify.judge_direction(
        [{"claim_prop": "raw claim", "claim_pov": "accelerationist",
          "node_prop": "raw node"}], no_framing=True)
    assert captured["pairs"][0] == ("raw claim", "raw node")  # no prefix
    assert out[0]["direction"] == "agrees"


def test_ids_and_order_preserved():
    captured = {}

    def fake(model, pairs):
        captured["pairs"] = pairs
        return [_res("neutral", 0.1) for _ in pairs]

    embed_taxonomy._load_nli_model = lambda: object()
    embed_taxonomy._classify_pairs_nli = fake

    out = nli_classify.judge_direction([
        {"id": "p0", "claim_prop": "a", "node_prop": "b"},
        {"id": "p1", "claim_prop": "c", "node_prop": "d"},
    ])
    assert [r["id"] for r in out] == ["p0", "p1"]


def test_label_order_derived_from_config(monkeypatch):
    """t/4572 SO C4/G1: Verify the label-order derivation is read from config.id2label,
    not hardcoded. Monkeypatches CrossEncoder to return a stub with known id2label.
    This test MUST fail if someone reverts to hardcoded NLI_LABELS — proving the fix works.
    """
    import sentence_transformers

    class _Cfg:
        def __init__(self, m):
            self.id2label = m

    class _Stub:
        def __init__(self, *a, m=None, rows=None, **k):
            self.config = _Cfg(m)
            self._rows = rows

        def predict(self, pairs, **k):
            return self._rows

    monkeypatch.setattr(sentence_transformers, "CrossEncoder",
                       lambda *a, **k: _Stub(m={0: "contradiction", 1: "entailment", 2: "neutral"},
                                           rows=[[0.1, 1.8, 0.1]]))
    m = embed_taxonomy._load_nli_model()
    assert m._nli_label_order == ["contradiction", "entailment", "neutral"]
    out = embed_taxonomy._classify_pairs_nli(m, [("a", "b")])
    assert out[0]["label"] == "entailment"  # column 1 maps to entailment by name


def test_bad_id2label_raises(monkeypatch):
    """t/4572 SO G1: Reject invalid id2label configs (missing/extra/wrong labels,
    non-dense maps). Each must raise ValueError with 'Goal:' in the message.
    """
    try:
        import pytest
        import sentence_transformers
    except ImportError:
        # Fallback for standalone runs
        print("SKIP test_bad_id2label_raises — pytest or sentence_transformers not available")
        return

    class _Cfg:
        def __init__(self, m):
            self.id2label = m

    class _Stub:
        def __init__(self, *a, m=None, **k):
            self.config = _Cfg(m)

    bad_maps = [
        {0: "contradiction", 1: "entailment"},           # missing label
        {0: "contradiction", 1: "entailment", 2: "neutral", 3: "x"},  # too many
        {0: "contradiction", 2: "entailment", 3: "neutral"},  # non-dense
        {0: "contradiction", 1: "entailment", 2: "wrong"}  # wrong name
    ]

    for bad in bad_maps:
        monkeypatch.setattr(sentence_transformers, "CrossEncoder",
                           lambda *a, m=bad, **k: _Stub(m=m))
        with pytest.raises(ValueError, match="Goal:"):
            embed_taxonomy._load_nli_model()


def test_known_label_order_real_model():
    """t/4572 SO C4: a known-label regression test run through the REAL model, not
    fixtures — this is the test that would have caught the t/4572 column-swap bug
    (NLI_LABELS assumed [entailment, neutral, contradiction]; the real checkpoint's
    order is [contradiction, entailment, neutral]). Three unambiguous pairs, one
    each of entailment/contradiction/neutral, each asserting its real label.
    Skips when the model can't load (offline CI).
    """
    embed_taxonomy._load_nli_model = _REAL_LOAD
    embed_taxonomy._classify_pairs_nli = _REAL_CLASSIFY
    try:
        model = _REAL_LOAD()
    except Exception as exc:  # noqa: BLE001 — model unavailable => skip, not fail
        print("SKIP test_known_label_order_real_model — model unavailable:", exc)
        return

    cases = [
        ("A man is eating pizza.", "A man eats something.", "entailment"),
        ("A man is eating pizza.", "A man is eating nothing.", "contradiction"),
        ("A man is eating pizza.", "The stock market fell sharply today.", "neutral"),
    ]
    out = embed_taxonomy._classify_pairs_nli(model, [(a, b) for (a, b, _label) in cases])
    for (a, b, expected), result in zip(cases, out):
        assert result["label"] == expected, (
            "({!r}, {!r}) -> {!r}, expected {!r}. If this fails, the model's "
            "config.id2label order changed or the checkpoint changed — "
            "re-verify before touching the mapping.".format(a, b, result, expected)
        )


def test_richness_guard_real_model():
    """The GV richness arm (TL bless t/2744#8, replaces the moot framing arm).

    t/4572: REVERSED under the corrected label mapping. The original ruling (CL
    2x2, t/2744#7) — "node-proposition RICHNESS, not framing, catches an
    inversion" — was established against a label-swapped engine (NLI_LABELS
    assumed [entailment, neutral, contradiction]; the real order is
    [contradiction, entailment, neutral]). Under the corrected mapping, for this
    same pair:
      bare  (label only)     -> opposes    (CATCHES the inversion, confidently)
      rich  (label + Core)   -> unrelated  (MISSES it)
    This is the opposite of the original assertions. See t/4572, t/4572#1 (CL
    confirmation pending) and e/371 for the full reversal writeup and what
    re-examination of tau_contra/tau_entail and the published finding is needed.
    Real deberta; skips when the model can't load (offline CI).
    """
    # Restore the real driver (earlier tests monkeypatched it).
    embed_taxonomy._load_nli_model = _REAL_LOAD
    embed_taxonomy._classify_pairs_nli = _REAL_CLASSIFY
    try:
        _REAL_LOAD()
    except Exception as exc:  # noqa: BLE001 — model unavailable => skip, not fail
        print("SKIP test_richness_guard_real_model — model unavailable:", exc)
        return

    claim = ("rejecting AI exceptionalism ensures existing privacy principles "
             "remain the baseline for technological deployment without requiring "
             "novel regulatory regimes.")
    label = "Argue That AI Requires Entirely New Laws, Not Adapted Old Ones"
    core = ("asserts emerging technologies are so transformative they require "
            "entirely new legal frameworks rather than adapted existing laws.")

    bare_prop = label
    rich_prop = label + " — " + core

    cases = [
        (claim, bare_prop, "opposes"),  # bare node, confident contradiction
        (claim, rich_prop, "unrelated"),  # rich node, neutral
    ]
    out = nli_classify.judge_direction(
        [{"id": "p", "claim_prop": c, "claim_pov": "safetyist",
          "node_prop": n, "node_pov": "safetyist"} for (c, n, _) in cases])
    for (_, _, expected), result in zip(cases, out):
        assert result["direction"] == expected, (
            "bare={!r}, rich={!r}. CL t/2744#7 richness-vs-framing ruling is REVERSED "
            "under corrected labels: the bare (label-only) now catches the inversion "
            "confidently, while the rich (label+Core) reads as unrelated.".format(
                cases[0][2], cases[1][2])
        )


if __name__ == "__main__":
    # Standalone pytest runner
    try:
        import pytest
        pytest.main([__file__, "-v"])
    except ImportError:
        # Fallback: run the non-pytest tests manually
        print("pytest not available; running tests manually...")
        test_framing_is_applied_and_single_sourced()
        print("ok test_framing_is_applied_and_single_sourced")
        test_label_to_direction_mapping()
        print("ok test_label_to_direction_mapping")
        test_tau_contra_floor_downgrades_weak_contradiction_to_unresolved()
        print("ok test_tau_contra_floor_downgrades_weak_contradiction_to_unresolved")
        test_failsafe_on_engine_error_is_unresolved_never_opposes()
        print("ok test_failsafe_on_engine_error_is_unresolved_never_opposes")
        test_empty_proposition_is_unresolved_without_calling_model()
        print("ok test_empty_proposition_is_unresolved_without_calling_model")
        test_no_framing_passes_raw_text()
        print("ok test_no_framing_passes_raw_text")
        test_ids_and_order_preserved()
        print("ok test_ids_and_order_preserved")
        test_known_label_order_real_model()
        print("ok test_known_label_order_real_model")
        test_richness_guard_real_model()
        print("ok test_richness_guard_real_model")
        print("\nAll 9 tests passed.")
