#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Tests for the shared HF model pins (t/62).

scripts/embed_model_pins.json is the one source of truth for the model revisions.
embed_taxonomy.py (prod) and .github/ci/fetch_embed_models.py (CI cache, t/55)
must both read it, so CI and prod can't drift. No model download needed.
Runnable under pytest or standalone: `python test_embed_model_pins.py`.
"""

import importlib.util
import json
import re
import sys
import tempfile
import types
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
_PINS = _SCRIPTS / "embed_model_pins.json"
_CI_FETCH = _SCRIPTS.parent / ".github" / "ci" / "fetch_embed_models.py"

_SPEC = importlib.util.spec_from_file_location("embed_taxonomy", _SCRIPTS / "embed_taxonomy.py")
embed_taxonomy = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(embed_taxonomy)

_SHA = re.compile(r"[0-9a-f]{40}")


def _pins():
    return json.loads(_PINS.read_text(encoding="utf-8"))["models"]


def test_pins_cover_both_models_with_commit_shas():
    pins = _pins()
    # t/110: + the live -CrossEncoderRerank reranker (TL p/37#19)
    assert set(pins) == {embed_taxonomy.MODEL_REPO, embed_taxonomy.NLI_MODEL_NAME, "cross-encoder/ms-marco-MiniLM-L-6-v2"}
    for repo_id, revision in pins.items():
        assert _SHA.fullmatch(revision), f"{repo_id} is pinned to {revision!r}, not a commit sha"


def test_embed_taxonomy_reads_the_shared_pins_file():
    assert embed_taxonomy.MODEL_PINS_FILE.resolve() == _PINS
    for repo_id, revision in _pins().items():
        assert embed_taxonomy._model_revision(repo_id) == revision


def test_ci_fetch_reads_the_same_pins_file_and_hardcodes_none():
    """The t/62 contract: one source. CI may not keep its own copy of a revision."""
    src = _CI_FETCH.read_text(encoding="utf-8")
    assert "embed_model_pins.json" in src, "fetch_embed_models.py must read scripts/embed_model_pins.json"
    assert not re.search(r"[0-9a-f]{40}", src), "fetch_embed_models.py hardcodes a revision; read the pins file"


def _fake_sentence_transformers(calls):
    class _Model:
        def __init__(self, name, **kwargs):
            calls.append((name, kwargs.get("revision")))
            self.config = types.SimpleNamespace(id2label={0: "contradiction", 1: "entailment", 2: "neutral"})

    mod = types.ModuleType("sentence_transformers")
    mod.SentenceTransformer = _Model
    mod.CrossEncoder = _Model
    return mod


def test_loaders_pass_the_pinned_revisions():
    calls = []
    saved = sys.modules.get("sentence_transformers")
    sys.modules["sentence_transformers"] = _fake_sentence_transformers(calls)
    try:
        embed_taxonomy._load_model()
        embed_taxonomy._load_nli_model()
    finally:
        if saved is None:
            sys.modules.pop("sentence_transformers", None)
        else:
            sys.modules["sentence_transformers"] = saved
    pins = _pins()
    assert calls == [
        (embed_taxonomy.MODEL_REPO, pins[embed_taxonomy.MODEL_REPO]),
        (embed_taxonomy.NLI_MODEL_NAME, pins[embed_taxonomy.NLI_MODEL_NAME]),
    ]


def _expect_pin_error(content, fragment):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "pins.json"
        if content is not None:
            path.write_text(content, encoding="utf-8")
        try:
            embed_taxonomy._model_revision(embed_taxonomy.MODEL_REPO, pins_file=path)
        except ValueError as exc:
            assert fragment in str(exc) and "Next Steps:" in str(exc)
            return
    raise AssertionError(f"expected a pin error mentioning {fragment!r}")


def test_missing_or_bad_pins_fail_loudly_never_fall_back_to_main():
    _expect_pin_error(None, "no usable pin")                                   # file missing
    _expect_pin_error("{not json", "no usable pin")                            # corrupt
    _expect_pin_error('{"models": {}}', "no usable pin")                       # model absent
    _expect_pin_error(json.dumps({"models": {embed_taxonomy.MODEL_REPO: "main"}}), "not a 40-hex")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
