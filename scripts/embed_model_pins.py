#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Shared loader for the pinned Hugging Face models (t/62, t/110).

scripts/embed_model_pins.json is the one source of truth for the model revisions; CI's
.github/ci/fetch_embed_models.py reads the same file. Every sentence-transformers load in
scripts/ goes through this module, so prod, the batch scripts and CI can't drift apart:

  pinned_revision(repo_id)            the pinned commit, or a loud ValueError (never `main`)
  load_sentence_transformer(name)     SentenceTransformer at the pinned revision
  load_cross_encoder(name)            CrossEncoder at the pinned revision

A loaded model carries ``model.resolved_revision`` (the commit actually loaded), so a tool
can record it in its output.

``allow_unpinned=True`` is ONLY for model-evaluation tools (evaluate_embeddings.py,
generate_corpus.py) that compare arbitrary candidate models (TL p/37#17): a name with no
pin loads its current `main` with a WARN, and resolved_revision is the commit `main`
pointed at when it could be resolved. Never use it on a path whose output production
consumes; those must refuse an unpinned model.
"""

import json
import re
import sys
from pathlib import Path

PINS_FILE = Path(__file__).resolve().parent / "embed_model_pins.json"
_SHA = re.compile(r"[0-9a-f]{40}")
# t/146: upstream renames. The old id only resolves through a Hub redirect we don't control, so
# pins use the canonical id and an old id is mapped to it here (with a WARN), never fetched as-is.
_RENAMED = {
    "cross-encoder/ms-marco-MiniLM-L-6-v2": "cross-encoder/ms-marco-MiniLM-L6-v2",
}


def repo_id(name):
    """Normalise a model name to its canonical Hub repo id: a bare sentence-transformers short
    name (``all-MiniLM-L6-v2``) becomes ``sentence-transformers/all-MiniLM-L6-v2``, as
    sentence-transformers itself resolves it, and a renamed repo's old id becomes its new one."""
    rid = name if "/" in name else f"sentence-transformers/{name}"
    if rid in _RENAMED:
        print(f"WARN: {rid} was renamed upstream; using its canonical id {_RENAMED[rid]} (t/146). "
              "Update the caller.", file=sys.stderr)
        rid = _RENAMED[rid]
    return rid


def _read_pins(pins_file):
    try:
        pins = json.loads(Path(pins_file).read_text(encoding="utf-8"))["models"]
        if not isinstance(pins, dict):
            raise TypeError(f"'models' is a {type(pins).__name__}, not an object")
        return pins
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ValueError(
            "Goal: Load an embedding/NLI model at its pinned revision\n"
            f"Problem: no usable pin in {pins_file} ({type(exc).__name__}: {exc}).\n"
            "Location: embed_model_pins.py\n"
            f"Next Steps: Restore {Path(pins_file).name} from main. Unpinned `main` is never "
            "used as a silent fallback (t/62)."
        ) from exc


def is_pinned(name, pins_file=None):
    """True when the pins file has an entry for this model (by normalised repo id).
    A missing or unreadable pins file raises, as in pinned_revision."""
    return repo_id(name) in _read_pins(pins_file or PINS_FILE)


def pinned_revision(repo, pins_file=None):
    """The pinned commit for a model, from embed_model_pins.json.

    No fallback to the unpinned `main`: a missing file, a missing entry or a value that
    isn't a full commit sha is a ValueError, because loading `main` is exactly the
    silent CI/prod skew the pin prevents (t/62).
    """
    pins_file = Path(pins_file) if pins_file else PINS_FILE
    rid = repo_id(repo)
    pins = _read_pins(pins_file)
    if rid not in pins:
        raise ValueError(
            f"Goal: Load {rid} at its pinned revision\n"
            f"Problem: no usable pin in {pins_file} (KeyError: {rid!r} is not under \"models\").\n"
            "Location: embed_model_pins.py pinned_revision\n"
            f"Next Steps: Add {rid!r} under \"models\" with a full commit sha. Unpinned `main` "
            "is never used (t/62)."
        )
    revision = pins[rid]
    if not isinstance(revision, str) or not _SHA.fullmatch(revision):
        raise ValueError(
            f"Goal: Load {rid} at its pinned revision\n"
            f"Problem: the pin in {pins_file} is {revision!r}, not a 40-hex commit sha.\n"
            "Location: embed_model_pins.py pinned_revision\n"
            "Next Steps: Pin a commit, not a branch or tag (t/62)."
        )
    return revision


def _resolve_unpinned(rid):
    """The commit `main` points at now, for the record; None (with a WARN) when it can't be
    resolved (offline, Hub error)."""
    try:
        from huggingface_hub import HfApi

        return HfApi().model_info(rid, revision="main").sha
    except Exception as exc:  # noqa: BLE001 -- any Hub/network failure just means "unrecorded"
        print(f"WARN: could not resolve the commit behind {rid}@main ({type(exc).__name__}: {exc}); "
              "its revision is recorded as unknown (t/110).", file=sys.stderr)
        return None


def _revision_for(name, allow_unpinned, pins_file):
    rid = repo_id(name)
    if allow_unpinned and not is_pinned(rid, pins_file):
        sha = _resolve_unpinned(rid)
        print(f"WARN: loading {rid} UNPINNED (its current `main`"
              f"{', commit ' + sha[:7] if sha else ''}): it is not in {Path(pins_file or PINS_FILE).name}. "
              "Evaluation/reporting only; results may not reproduce if the repo is re-uploaded (t/110).",
              file=sys.stderr)
        # Load the exact commit we resolved, so what is recorded is what ran.
        return rid, sha, sha or "main"
    revision = pinned_revision(rid, pins_file)
    return rid, revision, revision


def _attach(model, revision):
    try:
        model.resolved_revision = revision
    except AttributeError:  # a model class that forbids new attributes: the caller can't record it
        print(f"WARN: could not record resolved_revision on {type(model).__name__} (t/110).", file=sys.stderr)
    return model


def load_sentence_transformer(name, *, allow_unpinned=False, pins_file=None, **kwargs):
    """A SentenceTransformer for ``name`` at its pinned revision (see module docstring)."""
    from sentence_transformers import SentenceTransformer

    rid, recorded, load_rev = _revision_for(name, allow_unpinned, pins_file)
    kwargs.setdefault("trust_remote_code", False)
    return _attach(SentenceTransformer(rid, revision=load_rev, **kwargs), recorded)


def load_cross_encoder(name, *, allow_unpinned=False, pins_file=None, **kwargs):
    """A CrossEncoder for ``name`` at its pinned revision (see module docstring)."""
    from sentence_transformers import CrossEncoder

    rid, recorded, load_rev = _revision_for(name, allow_unpinned, pins_file)
    kwargs.setdefault("trust_remote_code", False)
    return _attach(CrossEncoder(rid, revision=load_rev, **kwargs), recorded)
