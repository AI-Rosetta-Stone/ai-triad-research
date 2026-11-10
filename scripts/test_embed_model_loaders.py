#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Tests for the shared pinned-model loader, embed_model_pins.py (t/110).

Every sentence-transformers load in scripts/ and .github/ci/ goes through the helper, at the
revision pinned in embed_model_pins.json. Model-evaluation call sites may load an unpinned
candidate, but only with a reasoned marker (TL p/37#17); production paths refuse.
No model download needed. Runnable under pytest or standalone.
"""

import importlib.util
import io
import json
import re
import sys
import tempfile
import types
from contextlib import redirect_stderr
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
_REPO = _SCRIPTS.parent
_SPEC = importlib.util.spec_from_file_location("embed_model_pins", _SCRIPTS / "embed_model_pins.py")
emp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(emp)

_MINI = "sentence-transformers/all-MiniLM-L6-v2"
_NLI = "cross-encoder/nli-deberta-v3-small"
_MARCO = "cross-encoder/ms-marco-MiniLM-L6-v2"
_SHA_A = "a" * 40


def _pins():
    return json.loads(emp.PINS_FILE.read_text(encoding="utf-8"))["models"]


def _tmp_pins(content):
    d = tempfile.mkdtemp()
    p = Path(d) / "pins.json"
    if content is not None:
        p.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return p


def _raises(fn, fragment):
    try:
        fn()
    except ValueError as exc:
        assert fragment in str(exc) and "Next Steps:" in str(exc), str(exc)
        return
    raise AssertionError(f"expected a ValueError mentioning {fragment!r}")


# ── helper semantics ──────────────────────────────────────────────────────────

def test_short_name_normalises_like_sentence_transformers():
    assert emp.repo_id("all-MiniLM-L6-v2") == _MINI
    assert emp.repo_id(_NLI) == _NLI


def test_pinned_revision_reads_the_shared_file_by_short_or_full_name():
    pins = _pins()
    assert emp.pinned_revision("all-MiniLM-L6-v2") == pins[_MINI]
    assert emp.pinned_revision(_MARCO) == pins[_MARCO]


def test_missing_corrupt_unknown_or_non_sha_pins_fail_loudly():
    _raises(lambda: emp.pinned_revision(_MINI, pins_file=_tmp_pins(None)), "no usable pin")
    _raises(lambda: emp.pinned_revision(_MINI, pins_file=_tmp_pins("{nope")), "no usable pin")
    _raises(lambda: emp.pinned_revision(_MINI, pins_file=_tmp_pins({"models": {}})), "is not under")
    _raises(lambda: emp.pinned_revision(_MINI, pins_file=_tmp_pins({"models": {_MINI: "main"}})), "not a 40-hex")


def _fake_st(calls):
    class _Model:
        def __init__(self, name, **kw):
            calls.append((name, kw.get("revision"), kw.get("trust_remote_code")))

    mod = types.ModuleType("sentence_transformers")
    mod.SentenceTransformer = _Model
    mod.CrossEncoder = _Model
    return mod


def _with_fake(fn):
    calls = []
    saved = sys.modules.get("sentence_transformers")
    sys.modules["sentence_transformers"] = _fake_st(calls)
    try:
        result = fn()
    finally:
        if saved is None:
            sys.modules.pop("sentence_transformers", None)
        else:
            sys.modules["sentence_transformers"] = saved
    return result, calls


def test_loaders_pass_the_pinned_revision_and_record_it():
    pins = _pins()
    (m1, m2), calls = _with_fake(lambda: (emp.load_sentence_transformer("all-MiniLM-L6-v2"), emp.load_cross_encoder(_MARCO)))
    assert calls == [(_MINI, pins[_MINI], False), (_MARCO, pins[_MARCO], False)]
    assert m1.resolved_revision == pins[_MINI] and m2.resolved_revision == pins[_MARCO]


def test_unpinned_model_is_refused_by_default_production_path():
    _raises(lambda: _with_fake(lambda: emp.load_cross_encoder("someone/unpinned-reranker")), "is not under")


def test_allow_unpinned_loads_the_resolved_main_commit_with_a_warn():
    saved = emp._resolve_unpinned
    emp._resolve_unpinned = lambda rid: _SHA_A
    err = io.StringIO()
    try:
        with redirect_stderr(err):
            model, calls = _with_fake(lambda: emp.load_sentence_transformer("someone/candidate", allow_unpinned=True))
    finally:
        emp._resolve_unpinned = saved
    assert calls == [("someone/candidate", _SHA_A, False)], "loads the exact commit it records"
    assert model.resolved_revision == _SHA_A
    assert "UNPINNED" in err.getvalue() and "someone/candidate" in err.getvalue()


def test_allow_unpinned_offline_records_unknown_and_loads_main():
    saved = emp._resolve_unpinned
    emp._resolve_unpinned = lambda rid: None
    try:
        with redirect_stderr(io.StringIO()):
            model, calls = _with_fake(lambda: emp.load_sentence_transformer("someone/candidate", allow_unpinned=True))
    finally:
        emp._resolve_unpinned = saved
    assert calls == [("someone/candidate", "main", False)]
    assert model.resolved_revision is None


def test_allow_unpinned_still_uses_the_pin_when_there_is_one():
    pins = _pins()
    _, calls = _with_fake(lambda: emp.load_sentence_transformer("all-MiniLM-L6-v2", allow_unpinned=True))
    assert calls == [(_MINI, pins[_MINI], False)]


# ── t/146: upstream rename + legacy sense-embedding cache key ─────────────────

_OLD_MARCO = "cross-encoder/ms-marco-MiniLM-L-6-v2"


def test_pins_use_the_canonical_reranker_id_not_the_redirected_one():
    pins = _pins()
    assert _MARCO in pins and _OLD_MARCO not in pins


def test_old_reranker_id_maps_to_the_canonical_pin_with_a_warn():
    err = io.StringIO()
    with redirect_stderr(err):
        assert emp.repo_id(_OLD_MARCO) == _MARCO
        assert emp.pinned_revision(_OLD_MARCO) == _pins()[_MARCO]
    assert "renamed upstream" in err.getvalue()
    _, calls = _with_fake(lambda: emp.load_cross_encoder(_OLD_MARCO))
    assert calls[0][0] == _MARCO, "the redirected id is never fetched as-is"


def _sense_module():
    if str(_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS))
    spec = importlib.util.spec_from_file_location("build_sense_embeddings", _SCRIPTS / "build_sense_embeddings.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_legacy_sense_file_maps_to_the_fixed_t62_pin_not_the_current_one():
    bse = _sense_module()
    legacy = {"model": "all-MiniLM-L6-v2", "entries": {"x": {"hash": "h"}}}   # pre-t/110: no model_revision
    with redirect_stderr(io.StringIO()):
        got = bse.cached_model_revision(legacy, "all-MiniLM-L6-v2")
    assert got == "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
    # Arm 1: under today's pin (still the t/62 commit) the legacy cache stays valid.
    assert got == emp.pinned_revision("all-MiniLM-L6-v2")
    # Arm 2: after a future pin bump the same legacy file no longer matches, so it is recomputed.
    assert got != "b" * 40


def test_stamped_sense_file_uses_its_recorded_revision_and_other_models_are_unknown():
    bse = _sense_module()
    assert bse.cached_model_revision({"model": "all-MiniLM-L6-v2", "model_revision": "c" * 40, "entries": {}},
                                     "all-MiniLM-L6-v2") == "c" * 40
    assert bse.cached_model_revision({"model": "other/model", "entries": {}}, "all-MiniLM-L6-v2") is None
    with redirect_stderr(io.StringIO()):
        assert bse.cached_model_revision({"model": "other/model", "entries": {"x": {}}}, "other/model") is None


# ── no call site bypasses the helper (acceptance grep) ────────────────────────

_LOAD = re.compile(r"\b(SentenceTransformer|CrossEncoder)\s*\(|\.from_pretrained\s*\(")
_ALLOW = re.compile(r"#\s*model-load:allow-unpinned\s+(\S.*)$")
# Paths whose output production consumes must never allow an unpinned model (TL p/37#17).
_EVAL_ONLY = {"evaluate_embeddings.py"}


def _scanned_files():
    files = [p for p in _SCRIPTS.glob("*.py") if not p.name.startswith("test_") and p.name != "embed_model_pins.py"]
    files += list((_REPO / ".github" / "ci").glob("*.py"))
    return files


def test_no_model_load_bypasses_the_pinned_helper():
    offenders = []
    for path in _scanned_files():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            if _LOAD.search(code):
                offenders.append(f"{path.relative_to(_REPO)}:{n}: {line.strip()}")
    assert not offenders, "load through scripts/embed_model_pins.py instead:\n" + "\n".join(offenders)


def test_unpinned_allowances_are_marked_reasoned_and_evaluation_only():
    problems = []
    for path in _scanned_files():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "allow_unpinned=True" not in line.split("#", 1)[0]:
                continue
            where = f"{path.relative_to(_REPO)}:{n}"
            if path.name not in _EVAL_ONLY:
                problems.append(f"{where}: allow_unpinned outside the evaluation-only tools")
            elif not _ALLOW.search(line):
                problems.append(f"{where}: needs '# model-load:allow-unpinned <reason>'")
    assert not problems, "\n".join(problems)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
