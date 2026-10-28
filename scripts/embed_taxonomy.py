#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
embed_taxonomy.py — Generate and query semantic embeddings for the AI Triad taxonomy.

Subcommands
-----------
  generate       Rebuild taxonomy/embeddings.json from all POV JSON files.
  query          Find taxonomy nodes most similar to a text query.
  find-overlaps  Find node pairs with high embedding similarity.
  encode         Encode a single text to an embedding vector.
  batch-encode   Encode multiple texts from stdin JSON.
  nli-classify       Classify text pairs as entailment/neutral/contradiction.
  similarity-matrix  Compute full pairwise similarity matrix (NumPy-accelerated).

Uses the local all-MiniLM-L6-v2 model for embeddings and
cross-encoder/nli-deberta-v3-small for NLI classification (both via
sentence-transformers, no API required).

All informational/warning messages go to stderr; only machine-readable
JSON output goes to stdout.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import numpy as np

_SCRIPT_DIR = Path(__file__).resolve().parent
_FALLBACK_TAXONOMY_DIR = _SCRIPT_DIR.parent / "taxonomy" / "Origin"
MODEL_NAME = "all-MiniLM-L6-v2"
NLI_MODEL_NAME = "cross-encoder/nli-deberta-v3-small"
# t/4572 (SO C1, t/4572#1): a hardcoded column order here is exactly the class of bug that
# shipped -- NLI_LABELS used to assume [entailment, neutral, contradiction], but the real
# checkpoint's config.id2label is {0: contradiction, 1: entailment, 2: neutral}. Different
# cross-encoder/nli-* checkpoints use different orders, so the mapping is now READ from the
# loaded model's own config at load time (_nli_label_order below), never assumed. A future
# model swap that doesn't carry the three expected label names fails loudly instead of
# silently mislabeling every verdict.
_NLI_EXPECTED_LABELS = frozenset({"entailment", "neutral", "contradiction"})
# Maximum stdin buffer size (50 MB) — prevents resource exhaustion from piped input
_MAX_STDIN_BYTES = 50 * 1024 * 1024
# Minimum logit margin between the winning label and runner-up.
# If the margin is below this, the classification is downgraded to "neutral".
NLI_CONFIDENCE_MARGIN = 1.0

# Resolved at runtime via --taxonomy-dir or .aitriad.json
TAXONOMY_DIR: Path = _FALLBACK_TAXONOMY_DIR
EMBEDDINGS_FILE: Path = _FALLBACK_TAXONOMY_DIR / "embeddings.json"
# t/3898: the resolved data root (env var / .aitriad.json / fallback), exposed so
# a parity test can compare it directly against Get-DataRoot (PS).
DATA_ROOT: Path = _SCRIPT_DIR.parent


def _resolve_worktree_main_root(path):
    """Port of Get-WorktreeMainRoot (PS, t/3869/t/3899): resolve the true
    main-checkout root for the git worktree containing `path`, via
    `git rev-parse --git-common-dir`. This returns the main checkout's .git
    directory regardless of whether `path` is a nested worktree (.worktrees/x,
    one level too deep for a sibling-relative path like "../ai-triad-data") or a
    sibling worktree or a plain checkout -- same algorithm as the PS cmdlet, so
    the two can't silently diverge.

    Returns a resolved Path, or None if unresolvable (git unavailable, or `path`
    isn't a git checkout at all -- e.g. a PyPI/standalone install). Callers fail
    over to their own existing anchor in that case.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    common_dir = result.stdout.strip()
    if not common_dir:
        return None
    common_path = Path(common_dir)
    if not common_path.is_absolute():
        common_path = (Path(path) / common_path).resolve()
    return common_path.parent


def _resolve_data_root():
    """Resolve the data root: env var > .aitriad.json > script-parent fallback.

    t/3898: mirrors Get-DataRoot (PS)'s priority exactly (root AGENTS.md, Two-Repo
    Split) — `embed_taxonomy.py` previously never read `AI_TRIAD_DATA_ROOT` at all,
    so with the env var set, embeddings silently read a different checkout than
    every other step. Logs which source won (fallback-path logging, root AGENTS.md).

    t/3899: a relative `data_root` in `.aitriad.json` is now anchored at the true
    main-checkout root (via `_resolve_worktree_main_root`), not the immediate
    checkout directory — mirrors Get-DataRoot's t/3869 fix. From a nested worktree
    (.worktrees/<x>), anchoring at the worktree's own dir is one level too deep for
    a sibling-relative path, and silently misses the data repo.

    Returns (resolved_path, cfg_dict_or_None). cfg is returned too so the caller can
    read taxonomy_dir/conflicts_dir without re-reading/re-parsing the file.
    """
    config_path = _SCRIPT_DIR.parent / ".aitriad.json"
    cfg = None
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cfg = None  # fall through to default

    env_root = os.environ.get("AI_TRIAD_DATA_ROOT", "").strip()
    if env_root:
        env_path = Path(env_root)
        resolved = env_path.resolve() if env_path.exists() else env_path
        print(f"embed_taxonomy: data root resolved via env:AI_TRIAD_DATA_ROOT -> {resolved}", file=sys.stderr)
        return resolved, cfg

    if cfg is not None:
        data_root = cfg.get("data_root", ".")
        base_path = Path(data_root)
        if base_path.is_absolute():
            base = base_path
        else:
            main_root = _resolve_worktree_main_root(_SCRIPT_DIR.parent)
            if main_root is None:
                print(
                    "embed_taxonomy: git worktree-main-root resolution failed (not a "
                    f"git checkout, or git unavailable) -- falling back to anchoring "
                    f"relative data_root '{data_root}' at the script-parent dir "
                    f"({_SCRIPT_DIR.parent}); this is WRONG from inside a nested "
                    f"worktree (t/3899)",
                    file=sys.stderr,
                )
                anchor = _SCRIPT_DIR.parent
            else:
                anchor = main_root
            base = anchor / base_path
        resolved = base.resolve()
        print(f"embed_taxonomy: data root resolved via .aitriad.json -> {resolved}", file=sys.stderr)
        return resolved, cfg

    resolved = _SCRIPT_DIR.parent.resolve()
    print(f"embed_taxonomy: data root resolved via default (script-parent fallback) -> {resolved}", file=sys.stderr)
    return resolved, cfg


def _resolve_taxonomy_dir(override=None, conflicts_override=None):
    """Resolve the taxonomy + conflicts directories from override, .aitriad.json, or default.

    t/2877: `.aitriad.json` is consulted for the conflicts dir even when
    `--taxonomy-dir` overrides the taxonomy location. Previously an override left
    CONFLICTS_DIR on the script-parent fallback, which silently dropped conflicts
    when generate ran from an unusual cwd/worktree. Precedence for conflicts:
    explicit `conflicts_override` (--conflicts-dir) > .aitriad.json > fallback.
    """
    global TAXONOMY_DIR, EMBEDDINGS_FILE, CONFLICTS_DIR, DATA_ROOT

    DATA_ROOT, cfg = _resolve_data_root()
    tax_dir = cfg.get("taxonomy_dir", "taxonomy/Origin") if cfg else "taxonomy/Origin"
    conflicts_dir = cfg.get("conflicts_dir", "conflicts") if cfg else "conflicts"

    if not override:
        TAXONOMY_DIR = (DATA_ROOT / tax_dir).resolve()
    else:
        TAXONOMY_DIR = Path(override).resolve()

    EMBEDDINGS_FILE = TAXONOMY_DIR / "embeddings.json"

    if conflicts_override:
        CONFLICTS_DIR = Path(conflicts_override).resolve()
    else:
        CONFLICTS_DIR = (DATA_ROOT / conflicts_dir).resolve()
    return TAXONOMY_DIR


def _load_model():
    """Load the sentence-transformer model (downloads on first run)."""
    from sentence_transformers import SentenceTransformer

    print(f"Loading model '{MODEL_NAME}'...", file=sys.stderr)
    return SentenceTransformer(MODEL_NAME, trust_remote_code=False)


def _nli_label_order_error(problem):
    return ValueError(
        "Goal: Classify an NLI pair with the correct contradiction/entailment/neutral label\n"
        f"Problem: {problem}\n"
        "Location: embed_taxonomy.py _load_nli_model\n"
        f"Next Steps: Check NLI_MODEL_NAME ({NLI_MODEL_NAME}) and the checkpoint's own "
        "config.json id2label. This engine refuses to guess a column order (t/4572)."
    )


def _load_nli_model():
    """Load the NLI cross-encoder model (downloads on first run).

    t/4572 (SO C1): the model's own config.id2label is the ONLY source of the
    column-index -> label mapping. A hardcoded order is exactly the bug class
    that shipped (NLI_LABELS used to assume [entailment, neutral, contradiction]
    when the real checkpoint's order is [contradiction, entailment, neutral]).
    Read once at load time, validated, and cached on the model object so a future
    model swap that changes the order -- or ships without one of the three
    expected labels -- fails loudly here instead of silently mislabeling every
    verdict downstream.
    """
    from sentence_transformers import CrossEncoder

    print(f"Loading NLI model '{NLI_MODEL_NAME}'...", file=sys.stderr)
    model = CrossEncoder(NLI_MODEL_NAME, trust_remote_code=False)

    id2label = getattr(getattr(model, "config", None), "id2label", None)
    if not id2label:
        raise _nli_label_order_error(
            f"the loaded model has no config.id2label to read a column order from."
        )
    try:
        order = [str(id2label[i]).lower() for i in range(len(id2label))]
    except (KeyError, TypeError) as exc:
        raise _nli_label_order_error(
            f"config.id2label is not a dense 0..N-1 mapping: {id2label!r} ({exc})."
        ) from exc
    if len(order) != 3 or set(order) != _NLI_EXPECTED_LABELS:
        raise _nli_label_order_error(
            f"config.id2label gave {order!r}; expected exactly "
            f"{sorted(_NLI_EXPECTED_LABELS)!r} (3 labels, one each)."
        )
    model._nli_label_order = order  # noqa: SLF001 -- intentional: our own cache, our own model instance
    return model


def _classify_pairs_nli(nli_model, pairs):
    """Classify a list of (text_a, text_b) pairs using the NLI cross-encoder.

    Returns a list of dicts with 'label' (entailment|neutral|contradiction)
    and individual scores for each class.  If the winning label's logit does
    not exceed the runner-up by NLI_CONFIDENCE_MARGIN, the label is
    downgraded to 'neutral' to avoid low-confidence misclassifications.
    """
    if not pairs:
        return []

    label_order = getattr(nli_model, "_nli_label_order", None)
    if not label_order:
        raise _nli_label_order_error(
            "nli_model was not produced by _load_nli_model (no _nli_label_order cached)."
        )

    scores = nli_model.predict(pairs)

    # Column order is WHATEVER _load_nli_model derived from the model's own config.id2label
    # (t/4572) -- never assumed positionally here.
    results = []
    for row in scores:
        sorted_idx = np.argsort(row)[::-1]  # descending
        best = float(row[sorted_idx[0]])
        second = float(row[sorted_idx[1]])
        margin = best - second

        if margin >= NLI_CONFIDENCE_MARGIN:
            label = label_order[int(sorted_idx[0])]
        else:
            label = "neutral"

        entry = {"label": label, "margin": round(margin, 4)}
        for idx, name in enumerate(label_order):
            entry[name] = round(float(row[idx]), 4)
        results.append(entry)
    return results


SKIP_FILES = {"embeddings.json", "edges.json", "policy_actions.json", "lineage_categories.json", "_archived_edges.json", "interpretation_embeddings.json", "entity_extraction_log.json"}

# Resolved at runtime from .aitriad.json
CONFLICTS_DIR: Optional[Path] = None  # set in _resolve_taxonomy_dir

# Default weights for multi-field embedding.  Must sum to 1.0.
# Fields: description, assumes, lineage, epistemic_type, rhetorical_strategy
DEFAULT_FIELD_WEIGHTS = (1.0, 0.0, 0.0, 0.0, 0.0)


def _package_version(pkg_name: str) -> str:
    """Return the installed version of a package, or 'unknown' if unresolvable.

    Stamps encoder-stack provenance into the embeddings.json envelope so a
    regenerated corpus records exactly which sentence-transformers / transformers
    produced it (t/1994) — making later reproduction checks decidable from the
    file rather than recovered by experiment.
    """
    from importlib.metadata import version, PackageNotFoundError

    try:
        return version(pkg_name)
    except PackageNotFoundError:
        return "unknown"


def _composition_descriptor(weights) -> str:
    """Human-readable descriptor of the embedding composition recipe (t/1994).

    `weights` is the (description, assumes, lineage, epistemic, rhetorical) tuple
    actually used for this run. Stamped into the envelope so the exact recipe
    (raw encode → weighted sum → single L2, description verbatim incl. Excludes)
    is recorded alongside the model, not inferred after the fact.
    """
    w_str = "/".join(f"{w:g}" for w in weights)
    return (
        f"raw-field-encode (normalize_embeddings=False); weighted sum {w_str} over "
        "description,assumes,lineage,epistemic,rhetorical; single final L2 normalize "
        "(preserves weight ratios, t/268); assumes joined '. '; description verbatim "
        "incl. Excludes, no label prefix; policies/conflicts encoded single-field then L2"
    )


def _build_envelope(model_name, dimension, weights, generated_at, nodes_dict):
    """Assemble the embeddings.json provenance envelope.

    Extracted from cmd_generate so the provenance stamps (encoder versions +
    composition descriptor) are unit-testable without running a full model
    encode (t/1994). `weights` is the normalized
    (description, assumes, lineage, epistemic, rhetorical) tuple.
    """
    w_desc, w_assumes, w_lineage, w_epistemic, w_rhetorical = weights
    return {
        "model": model_name,
        "dimension": int(dimension),
        "field_weights": {
            "description": w_desc,
            "assumes": w_assumes,
            "lineage": w_lineage,
            "epistemic": w_epistemic,
            "rhetorical": w_rhetorical,
        },
        "sentence_transformers_version": _package_version("sentence-transformers"),
        "transformers_version": _package_version("transformers"),
        "composition": _composition_descriptor(weights),
        "generated_at": generated_at,
        "node_count": len(nodes_dict),
        "nodes": nodes_dict,
    }


def _load_lineage_categories():
    """Load the lineage→category mapping from lineage_categories.json.

    Returns a dict mapping lineage value strings to their category labels,
    or an empty dict if the file is missing.
    """
    lc_path = TAXONOMY_DIR / "lineage_categories.json"
    if not lc_path.exists():
        print("Warning: lineage_categories.json not found — lineage field will be empty.", file=sys.stderr)
        return {}

    try:
        data = json.loads(lc_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Warning: could not load lineage_categories.json: {exc}", file=sys.stderr)
        return {}

    # Build id→label lookup
    cat_labels = {c["id"]: c["label"] for c in data.get("categories", [])}
    # Build value→label mapping (supports both old flat strings and new {l1, l2} dicts)
    mapping = {}
    for value, cat_id in data.get("mapping", {}).items():
        if isinstance(cat_id, dict):
            cat_id = cat_id.get("l1", "")
        mapping[value] = cat_labels.get(cat_id, "Other")
    return mapping


_EXCLUDES_RE = re.compile(r"\s*Excludes:.*", re.DOTALL)
_EXCLUDES_EXTRACT_RE = re.compile(r"\bExcludes:\s*(.*?)\.?\s*$", re.DOTALL)


def _strip_excludes(description: str) -> str:
    """Remove the 'Excludes: ...' clause from a node description."""
    return _EXCLUDES_RE.sub("", description).strip()


def _extract_excludes(description: str) -> str:
    """Extract the Excludes clause text from a node description.

    Returns the raw exclusion items text (without 'Excludes:' prefix),
    or empty string if no clause is present.
    """
    m = _EXCLUDES_EXTRACT_RE.search(description)
    return m.group(1).strip() if m else ""


def _compose_field_texts(node, lineage_map):
    """Extract five embedding-ready text fields from a node.

    Returns (description_text, assumes_text, lineage_text,
             epistemic_text, rhetorical_text).

    description_text: the node's `description` verbatim — full text, Excludes
                      clause INCLUDED, no label prefix. This is intentional: the
                      raw description is what reproduces the shipped corpus at
                      cosine 1.0; stripping Excludes drops it to ~0.98 and
                      prefixing the label to ~0.92 (t/1994).
    assumes_text:     assumes statements joined with '. '
    lineage_text:     deduplicated lineage category labels
    epistemic_text:   epistemic_type (underscores → spaces)
    rhetorical_text:  rhetorical_strategy (underscores → spaces)
    """
    ga = node.get("graph_attributes", {}) or {}

    # ── Field 1: Description ─────────────────────────────────────────
    description_text = node.get("description", "")

    # ── Field 2: Assumes ─────────────────────────────────────────────
    assumes = ga.get("assumes", []) or []
    assumes_text = ". ".join(assumes) if assumes else ""

    # ── Field 3: Lineage categories ──────────────────────────────────
    lineage_values = ga.get("intellectual_lineage", []) or []
    # Resolve to category labels and deduplicate while preserving order
    seen = set()
    cat_labels = []
    for val in lineage_values:
        # Handle both bare strings and enriched objects {"name": "...", ...}
        if isinstance(val, dict):
            val = val.get("name", "")
        if not isinstance(val, str) or not val:
            continue
        cat_label = lineage_map.get(val, "Other")
        if cat_label not in seen:
            seen.add(cat_label)
            cat_labels.append(cat_label)
    lineage_text = ", ".join(cat_labels) if cat_labels else ""

    # ── Field 4: Epistemic type ──────────────────────────────────────
    epistemic = ga.get("epistemic_type", "")
    epistemic_text = epistemic.replace("_", " ") if epistemic else ""

    # ── Field 5: Rhetorical strategy ─────────────────────────────────
    rhetorical = ga.get("rhetorical_strategy", "")
    rhetorical_text = rhetorical.replace("_", " ") if rhetorical else ""

    return description_text, assumes_text, lineage_text, epistemic_text, rhetorical_text


def _load_taxonomy_nodes():
    """Read all POV JSON files and return a flat list of (pov, node) tuples."""
    nodes = []
    for path in sorted(TAXONOMY_DIR.glob("*.json")):
        if path.name in SKIP_FILES:
            continue
        # Skip embedding-index artifacts (e.g. embeddings-orgstance-6733.json):
        # their "nodes" field is a dict keyed by node ID, not a list of node
        # dicts, so iterating it yields strings and crashes downstream (t/1652).
        if path.stem.startswith("embeddings-"):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"Warning: skipping {path.name}: {exc}", file=sys.stderr)
            continue

        pov = path.stem.lower()
        # Durable class guard (t/2875, a t/1652-class recurrence): a stray
        # `nodes`-bearing file whose entries aren't POV nodes (e.g. log entries
        # keyed `node_id`, not `id`) must be a logged skip, not a downstream
        # KeyError that takes the whole pipeline down. Validate shape before ingest.
        file_nodes = data.get("nodes", [])
        if file_nodes and not all(isinstance(n, dict) and "id" in n for n in file_nodes):
            print(
                f"Warning: skipping {path.name}: 'nodes' entries lack 'id' (not a POV file)",
                file=sys.stderr,
            )
            continue
        for node in file_nodes:
            nodes.append((pov, node))
    return nodes


def _load_policy_registry():
    """Read policy_actions.json and return list of policy dicts, or empty list."""
    registry_path = TAXONOMY_DIR / "policy_actions.json"
    if not registry_path.exists():
        return []
    try:
        data = json.loads(registry_path.read_text(encoding="utf-8-sig"))
        return data.get("policies", [])
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Warning: could not load policy registry: {exc}", file=sys.stderr)
        return []


def _load_conflict_nodes():
    """Read conflicts from conflicts.json and return a list of conflict dicts.

    Each dict has at minimum: claim_id, claim_label, description.
    Falls back to empty list if conflicts.json is missing.
    """
    if not CONFLICTS_DIR or not CONFLICTS_DIR.exists():
        print(f"Warning: conflicts directory not found at {CONFLICTS_DIR}", file=sys.stderr)
        return []

    conflicts_file = CONFLICTS_DIR / "conflicts.json"
    if not conflicts_file.exists():
        print(f"Warning: {conflicts_file} not found — no conflicts to embed", file=sys.stderr)
        return []

    try:
        wrapper = json.loads(conflicts_file.read_text(encoding="utf-8"))
        entries = wrapper.get("conflicts", [])
        return [
            {
                "claim_id": c.get("claim_id", ""),
                "claim_label": c.get("claim_label", ""),
                "description": c.get("description", ""),
            }
            for c in entries
        ]
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Warning: could not read {conflicts_file}: {exc}", file=sys.stderr)
        return []


def _assert_corpus_complete(node_count, conflict_count, conflicts_dir, allow_missing_conflicts):
    """Fail loud if the regenerated corpus is missing a node class the source contains (t/2877).

    Prevents the silent-degradation class (ADR-001): a path/cwd quirk that drops a whole
    class (e.g. conflicts) while `generate` still exits 0 with a truncated corpus. Raises
    ValueError (→ non-zero exit) with an actionable Goal/Problem/Next-Steps message; returns
    None on success. Pure (no model encode) so it is unit-testable.

    The crux (why not just "corpus conflicts > 0"): the incident's mis-resolution made the
    SOURCE look empty, so a >0 check would not fire. This asserts the conflicts source
    RESOLVED to a real conflicts.json and that the corpus count EXACTLY matches its entries —
    catching total AND partial drops regardless of cause.
    """
    def _err(problem, next_steps):
        return ValueError(
            "Goal: Regenerate a complete embeddings.json (all node classes the source contains)\n"
            f"Problem: {problem}\n"
            "Location: embed_taxonomy.py cmd_generate / _assert_corpus_complete\n"
            f"Next Steps: {next_steps}"
        )

    if node_count == 0:
        raise _err(
            f"0 taxonomy POV nodes loaded — source empty or TAXONOMY_DIR mis-resolved ({TAXONOMY_DIR}).",
            "Check --taxonomy-dir / cwd / .aitriad.json so the POV JSON files are found.",
        )

    conflicts_file = (Path(conflicts_dir) / "conflicts.json") if conflicts_dir else None
    if conflicts_file is None or not conflicts_file.exists():
        if allow_missing_conflicts:
            return
        raise _err(
            f"CONFLICTS_DIR did not resolve to an existing conflicts.json (looked at {conflicts_file}); "
            "conflicts would be silently dropped from the corpus.",
            "Pass --conflicts-dir <dir>, fix cwd/.aitriad.json so conflicts resolve, "
            "or pass --allow-missing-conflicts if this run is intentionally conflict-free.",
        )

    try:
        expected = len(json.loads(conflicts_file.read_text(encoding="utf-8")).get("conflicts", []))
    except (json.JSONDecodeError, OSError) as exc:
        raise _err(
            f"could not read conflicts source {conflicts_file}: {exc}",
            "Verify the conflicts.json file is valid JSON and readable.",
        )

    if conflict_count != expected:
        raise _err(
            f"conflict count mismatch: corpus has {conflict_count} but source {conflicts_file} "
            f"has {expected} — a partial or total conflict drop.",
            "Check CONFLICTS_DIR resolution and the conflict load path; do not ship a truncated corpus.",
        )


def cmd_generate(args):
    """Rebuild embeddings.json from all taxonomy JSON files and policy registry.

    For taxonomy nodes, produces a weighted combination of five field embeddings:
      - description (the node description verbatim — Excludes INCLUDED, no label prefix)
      - assumes (assumption statements joined with ". ")
      - lineage (deduplicated lineage category labels)
      - epistemic_type (e.g. "normative prescription")
      - rhetorical_strategy (e.g. "precautionary framing, moral imperative")

    Each field is encoded raw (normalize_embeddings=False), the fields are
    weighted-summed, then the combined vector is L2-normalized exactly once.
    This raw-sum-then-single-normalize composition is deliberate — normalizing
    per field first would flatten the weight ratios (t/268, see combination site).

    Weights are configurable via --field-weights (DEFAULT_FIELD_WEIGHTS =
    1/0/0/0/0). Policies and conflicts each use a single embedding of their
    action/claim text, normalized individually.
    """
    nodes = _load_taxonomy_nodes()
    policies = _load_policy_registry()
    conflicts = _load_conflict_nodes()

    if not nodes and not policies and not conflicts:
        print("Error: no taxonomy nodes, policies, or conflicts found.", file=sys.stderr)
        sys.exit(1)

    # t/2877 — fail loud BEFORE the expensive encode if a whole node class was silently
    # dropped (e.g. conflicts, via a path/cwd mis-resolution). Never ship a truncated corpus.
    try:
        _assert_corpus_complete(
            len(nodes), len(conflicts), CONFLICTS_DIR,
            getattr(args, "allow_missing_conflicts", False),
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    # Parse weights
    weights = (
        tuple(float(x) for x in args.field_weights.split(","))
        if hasattr(args, "field_weights") and args.field_weights
        else DEFAULT_FIELD_WEIGHTS
    )
    if len(weights) == 3:
        # Backward-compatible: old 3-field format → spread into 5 fields
        weights = (weights[0], weights[1], weights[2], 0.0, 0.0)
    if len(weights) != 5:
        print(f"Error: --field-weights requires 5 values (description,assumes,lineage,epistemic,rhetorical), got {len(weights)}", file=sys.stderr)
        sys.exit(1)
    w_desc, w_assumes, w_lineage, w_epistemic, w_rhetorical = weights
    weight_sum = sum(weights)
    if abs(weight_sum - 1.0) > 0.01:
        print(f"Warning: field weights sum to {weight_sum}, not 1.0. Normalizing.", file=sys.stderr)
        w_desc, w_assumes, w_lineage, w_epistemic, w_rhetorical = (w / weight_sum for w in weights)

    print(
        f"Field weights: description={w_desc:.2f}, assumes={w_assumes:.2f}, "
        f"lineage={w_lineage:.2f}, epistemic={w_epistemic:.2f}, rhetorical={w_rhetorical:.2f}",
        file=sys.stderr,
    )

    lineage_map = _load_lineage_categories()
    model = _load_model()

    # ── Compose field texts for taxonomy nodes ───────────────────────
    desc_texts = []
    assumes_texts = []
    lineage_texts = []
    epistemic_texts = []
    rhetorical_texts = []
    exclusion_texts = []
    for _, node in nodes:
        d, a, l, e, r = _compose_field_texts(node, lineage_map)
        desc_texts.append(d)
        assumes_texts.append(a)
        lineage_texts.append(l)
        epistemic_texts.append(e)
        rhetorical_texts.append(r)
        exclusion_texts.append(_extract_excludes(node.get("description", "") or ""))

    # ── Collect all texts to encode in one batch ─────────────────────
    policy_texts = [p.get("action", "") for p in policies]
    conflict_texts = [
        f"{c['claim_label']}. {c['description']}".strip(". ") for c in conflicts
    ]
    n = len(nodes)

    # Exclusion texts that are non-empty get embedded; empty ones get null vectors
    has_exclusion = [bool(t) for t in exclusion_texts]
    nonempty_exclusion_texts = [t for t in exclusion_texts if t]
    excl_count = len(nonempty_exclusion_texts)

    all_texts = (
        desc_texts + assumes_texts + lineage_texts + epistemic_texts + rhetorical_texts
        + nonempty_exclusion_texts + policy_texts + conflict_texts
    )
    print(
        f"Encoding {n} nodes x 5 fields + {excl_count} exclusion vectors + "
        f"{len(policy_texts)} policies + {len(conflict_texts)} conflicts "
        f"({len(all_texts)} total texts)...",
        file=sys.stderr,
    )
    # Encode without pre-normalization — preserves raw magnitudes for weighted combination
    all_vecs = model.encode(all_texts, normalize_embeddings=False, show_progress_bar=True)

    # Slice into per-field arrays
    desc_vecs = all_vecs[0:n]
    assumes_vecs = all_vecs[n : 2 * n]
    lineage_vecs = all_vecs[2 * n : 3 * n]
    epistemic_vecs = all_vecs[3 * n : 4 * n]
    rhetorical_vecs = all_vecs[4 * n : 5 * n]
    excl_vecs_dense = all_vecs[5 * n : 5 * n + excl_count]
    policy_vecs = all_vecs[5 * n + excl_count : 5 * n + excl_count + len(policy_texts)]
    conflict_vecs = all_vecs[5 * n + excl_count + len(policy_texts) :]

    # Expand dense exclusion vectors back to per-node array (None for nodes without Excludes)
    excl_vecs_per_node: list[Optional[np.ndarray]] = []
    dense_idx = 0
    for i in range(n):
        if has_exclusion[i]:
            excl_vecs_per_node.append(excl_vecs_dense[dense_idx])
            dense_idx += 1
        else:
            excl_vecs_per_node.append(None)

    # Normalize exclusion vectors individually
    for i in range(n):
        if excl_vecs_per_node[i] is not None:
            norm = np.linalg.norm(excl_vecs_per_node[i])
            if norm > 0:
                excl_vecs_per_node[i] = excl_vecs_per_node[i] / norm

    # ── Weighted combination for taxonomy nodes ──────────────────────
    # Raw encoding + weight + single normalize fixes re-normalization distortion (t/268)
    node_vectors = (
        w_desc * desc_vecs
        + w_assumes * assumes_vecs
        + w_lineage * lineage_vecs
        + w_epistemic * epistemic_vecs
        + w_rhetorical * rhetorical_vecs
    )

    # Detect degenerate embeddings (near-zero vectors from empty/stop-word-only text)
    raw_norms = np.linalg.norm(node_vectors, axis=1)
    degenerate_mask = raw_norms < 0.01
    degenerate_count = int(np.sum(degenerate_mask))
    if degenerate_count > 0:
        degenerate_ids = [nodes[i][1]["id"] for i in range(n) if degenerate_mask[i]]
        print(
            f"Warning: {degenerate_count} degenerate embedding(s) (‖v‖ < 0.01), "
            f"excluded from similarity: {', '.join(degenerate_ids[:10])}"
            + (f" ... and {degenerate_count - 10} more" if degenerate_count > 10 else ""),
            file=sys.stderr,
        )

    # Single normalization for node vectors (the ONLY normalization step —
    # no pre-normalization at encode time, so weight ratios are preserved)
    norms = np.linalg.norm(node_vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    node_vectors = node_vectors / norms

    # Policies and conflicts: single-field, normalize individually
    policy_norms = np.linalg.norm(policy_vecs, axis=1, keepdims=True)
    policy_norms[policy_norms == 0] = 1.0
    policy_vecs = policy_vecs / policy_norms

    conflict_norms = np.linalg.norm(conflict_vecs, axis=1, keepdims=True)
    conflict_norms[conflict_norms == 0] = 1.0
    conflict_vecs = conflict_vecs / conflict_norms

    # ── Build output structure ───────────────────────────────────────
    nodes_dict = {}
    for i, (pov, node) in enumerate(nodes):
        entry = {
            "pov": pov,
            "vector": node_vectors[i].tolist(),
            "exclusion_vector": excl_vecs_per_node[i].tolist() if excl_vecs_per_node[i] is not None else None,
        }
        if degenerate_mask[i]:
            entry["degenerate"] = True
        nodes_dict[node["id"]] = entry

    for i, pol in enumerate(policies):
        nodes_dict[pol["id"]] = {
            "pov": "policy",
            "vector": policy_vecs[i].tolist(),
        }

    for i, conflict in enumerate(conflicts):
        nodes_dict[conflict["claim_id"]] = {
            "pov": "conflict",
            "vector": conflict_vecs[i].tolist(),
        }

    output = _build_envelope(
        MODEL_NAME,
        all_vecs.shape[1],
        (w_desc, w_assumes, w_lineage, w_epistemic, w_rhetorical),
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        nodes_dict,
    )

    # --output overrides EMBEDDINGS_FILE — used by non-default field-weights
    # runs (t/1553 Stage 2 needs a 0.67/0.33 variant without clobbering
    # production embeddings.json).
    out_path = Path(args.output).expanduser().resolve() if getattr(args, "output", None) else EMBEDDINGS_FILE
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"Wrote {len(nodes_dict)} embeddings ({n} nodes [{excl_count} with exclusion_vector] + "
        f"{len(policy_texts)} policies + {len(conflict_texts)} conflicts, "
        f"{all_vecs.shape[1]}d) to {out_path}",
        file=sys.stderr,
    )


def cmd_query(args):
    """Find the most similar taxonomy nodes/policies to a text query."""
    # Load embeddings
    if not EMBEDDINGS_FILE.exists():
        print(
            "Error: embeddings.json not found. Run 'generate' first.",
            file=sys.stderr,
        )
        sys.exit(1)

    data = json.loads(EMBEDDINGS_FILE.read_text(encoding="utf-8"))

    # Staleness check
    current_nodes = _load_taxonomy_nodes()
    current_policies = _load_policy_registry()
    current_conflicts = _load_conflict_nodes()
    expected = len(current_nodes) + len(current_policies) + len(current_conflicts)
    if expected != data.get("node_count", 0):
        print(
            f"Warning: taxonomy has {len(current_nodes)} nodes + {len(current_policies)} policies + "
            f"{len(current_conflicts)} conflicts ({expected} total) but embeddings.json has "
            f"{data['node_count']}. Consider running 'generate' to update.",
            file=sys.stderr,
        )

    # Filter by POV and/or type
    pov_filter = args.pov.lower() if args.pov else None
    type_filter = getattr(args, 'type', None)
    node_ids = []
    vectors = []
    for nid, entry in data["nodes"].items():
        if pov_filter and entry["pov"] != pov_filter:
            continue
        if type_filter == "node" and entry["pov"] == "policy":
            continue
        if type_filter == "policy" and entry["pov"] != "policy":
            continue
        if entry.get("degenerate"):
            continue
        node_ids.append(nid)
        vectors.append(entry["vector"])

    if not node_ids:
        json.dump([], sys.stdout)
        return

    vectors = np.array(vectors, dtype=np.float32)

    model = _load_model()
    query_vec = model.encode(
        [args.text], normalize_embeddings=True, show_progress_bar=False
    )

    # Cosine similarity = dot product (vectors are pre-normalized)
    scores = (vectors @ query_vec[0]).tolist()

    # Build results sorted by score descending
    results = []
    for nid, score in zip(node_ids, scores):
        results.append(
            {
                "id": nid,
                "pov": data["nodes"][nid]["pov"],
                "score": round(score, 6),
            }
        )

    results.sort(key=lambda r: r["score"], reverse=True)

    top = args.top
    if top and top > 0:
        results = results[:top]

    json.dump(results, sys.stdout, indent=2)


def cmd_encode(args):
    """Encode a single text and output its embedding vector as JSON.

    Text can be passed as a positional argument or piped via stdin (use '-' or omit).
    """
    text = args.text
    if text == "-":
        text = sys.stdin.read(_MAX_STDIN_BYTES).strip()
    if not text:
        print("Error: no text provided", file=sys.stderr)
        sys.exit(1)
    model = _load_model()
    vec = model.encode(
        [text], normalize_embeddings=True, show_progress_bar=False
    )
    json.dump(vec[0].tolist(), sys.stdout)


def cmd_batch_encode(args):
    """Encode multiple texts from stdin JSON and output {id: vector} map.

    Expects stdin JSON: [{"id": "acc-goal-001", "text": "description..."}]
    Outputs JSON: {"acc-goal-001": [0.1, 0.2, ...], ...}
    """
    raw = sys.stdin.read(_MAX_STDIN_BYTES)
    items = json.loads(raw)
    if not items:
        json.dump({}, sys.stdout)
        return

    model = _load_model()
    texts = [item["text"] for item in items]
    ids = [item["id"] for item in items]

    print(f"Batch-encoding {len(texts)} texts...", file=sys.stderr)
    vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)

    result = {}
    for nid, vec in zip(ids, vectors):
        result[nid] = vec.tolist()

    json.dump(result, sys.stdout)


def cmd_find_overlaps(args):
    """Find node pairs with high embedding similarity (potential merge candidates).

    Unless --no-nli is set, each pair is verified with an NLI cross-encoder to
    classify the relationship as entailment (genuine overlap), neutral, or
    contradiction (opposite statements on the same topic).
    """
    if not EMBEDDINGS_FILE.exists():
        print(
            "Error: embeddings.json not found. Run 'generate' first.",
            file=sys.stderr,
        )
        sys.exit(1)

    data = json.loads(EMBEDDINGS_FILE.read_text(encoding="utf-8"))

    # Load taxonomy node info for NLI (label, description, pov)
    node_info = {}
    for pov, node in _load_taxonomy_nodes():
        label = node.get("label", "")
        desc = node.get("description", "") or label
        node_info[node["id"]] = {"label": label, "description": desc, "pov": pov}
    for pol in _load_policy_registry():
        node_info[pol["id"]] = {
            "label": pol.get("action", ""),
            "description": pol.get("action", ""),
            "pov": pol.get("pov", ""),
        }

    # Build arrays
    node_ids = []
    povs = []
    vecs = []
    pov_filter = args.pov.lower() if args.pov else None

    for nid, entry in data["nodes"].items():
        node_ids.append(nid)
        povs.append(entry["pov"])
        vecs.append(entry["vector"])

    if len(node_ids) < 2:
        json.dump([], sys.stdout)
        return

    vectors = np.array(vecs, dtype=np.float32)

    # Pairwise cosine similarity (vectors are pre-normalized)
    sim_matrix = vectors @ vectors.T

    # Extract upper triangle (no self-pairs, no duplicates)
    n = len(node_ids)
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            score = float(sim_matrix[i, j])
            if score < args.threshold:
                continue
            if pov_filter and povs[i] != pov_filter and povs[j] != pov_filter:
                continue
            if args.cross_pov and povs[i] == povs[j]:
                continue
            pairs.append({
                "node_a": node_ids[i],
                "node_b": node_ids[j],
                "pov_a": povs[i],
                "pov_b": povs[j],
                "similarity": round(score, 6),
            })

    pairs.sort(key=lambda p: p["similarity"], reverse=True)

    if args.top and args.top > 0:
        pairs = pairs[:args.top]

    # NLI verification
    if not args.no_nli and pairs:
        nli_model = _load_nli_model()
        nli_pairs = []
        for p in pairs:
            info_a = node_info.get(p["node_a"])
            info_b = node_info.get(p["node_b"])
            text_a = (
                f"The {info_a['pov']} position is: {info_a['label']} — {info_a['description']}"
                if info_a
                else p["node_a"]
            )
            text_b = (
                f"The {info_b['pov']} position is: {info_b['label']} — {info_b['description']}"
                if info_b
                else p["node_b"]
            )
            nli_pairs.append((text_a, text_b))

        print(f"Running NLI classification on {len(nli_pairs)} pairs...", file=sys.stderr)
        nli_results = _classify_pairs_nli(nli_model, nli_pairs)

        for pair, nli in zip(pairs, nli_results):
            pair["nli_label"] = nli["label"]
            pair["nli_entailment"] = nli["entailment"]
            pair["nli_neutral"] = nli["neutral"]
            pair["nli_contradiction"] = nli["contradiction"]

        contradictions = sum(1 for p in pairs if p["nli_label"] == "contradiction")
        entailments = sum(1 for p in pairs if p["nli_label"] == "entailment")
        neutrals = sum(1 for p in pairs if p["nli_label"] == "neutral")
        print(
            f"NLI results: {entailments} entailment, {neutrals} neutral, "
            f"{contradictions} contradiction",
            file=sys.stderr,
        )

    # Auto-label same-POV near-identical pairs as duplicates regardless of NLI
    DUPLICATE_SIM_THRESHOLD = 0.99
    duplicates = 0
    for p in pairs:
        if p["pov_a"] == p["pov_b"] and p["similarity"] >= DUPLICATE_SIM_THRESHOLD:
            p["nli_label"] = "duplicate"
            duplicates += 1
    if duplicates:
        print(f"Auto-labeled {duplicates} same-POV near-identical pairs as duplicate", file=sys.stderr)

    print(f"Found {len(pairs)} pairs above threshold {args.threshold}", file=sys.stderr)
    json.dump(pairs, sys.stdout, indent=2)


def cmd_similarity_matrix(args):
    """Compute pairwise cosine similarity matrix and output top-K per node.

    Uses NumPy vectorized matrix multiply for sub-second computation on 942+ nodes.
    Output is JSON suitable for similarity-cache.json.
    """
    import hashlib
    import time

    emb_path = TAXONOMY_DIR / "embeddings.json"
    if not emb_path.exists():
        print("Error: embeddings.json not found", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    raw = emb_path.read_text(encoding="utf-8-sig")
    data = json.loads(raw)

    # Compute file hash for cache invalidation
    emb_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    # Collect node vectors (exclude policies if requested)
    node_ids = []
    vectors = []
    for nid, entry in data["nodes"].items():
        if nid.startswith("pol-") and not args.include_policies:
            continue
        if entry.get("degenerate"):
            continue
        vec = entry.get("vector")
        if not vec:
            continue
        node_ids.append(nid)
        vectors.append(vec)

    n = len(node_ids)
    if n == 0:
        json.dump({"error": "no vectors found"}, sys.stdout)
        return

    # Vectorized similarity: V @ V.T (vectors are L2-normalized)
    V = np.array(vectors, dtype=np.float32)
    sim_matrix = V @ V.T  # n x n

    top_k = args.top_k
    threshold = args.threshold

    # Extract top-K per node
    entries = {}
    for i in range(n):
        row = sim_matrix[i]
        # Get indices sorted by similarity descending, skip self (i)
        indices = np.argsort(row)[::-1]
        top = []
        for j in indices:
            if j == i:
                continue
            sim = float(row[j])
            if sim < threshold:
                break  # sorted descending, so all remaining are below threshold
            top.append({"id": node_ids[j], "sim": round(sim, 4)})
            if len(top) >= top_k:
                break
        entries[node_ids[i]] = top

    elapsed = time.time() - t0

    result = {
        "embeddings_hash": emb_hash,
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "top_k": top_k,
        "node_count": n,
        "compute_seconds": round(elapsed, 3),
        "threshold": threshold,
        "entries": entries,
    }

    if args.output:
        out_path = Path(args.output)
        out_path.write_text(json.dumps(result), encoding="utf-8")
        print(
            f"Similarity cache: {n} nodes × top-{top_k} in {elapsed:.2f}s → {out_path}",
            file=sys.stderr,
        )
    else:
        json.dump(result, sys.stdout)
        print(f"\nComputed {n} nodes × top-{top_k} in {elapsed:.2f}s", file=sys.stderr)


def cmd_nli_classify(args):
    """Classify text pairs as entailment, neutral, or contradiction.

    Reads JSON from stdin: [{"text_a": "...", "text_b": "...", ...}]
    Extra fields are preserved and passed through to the output.
    Outputs JSON: [{"text_a": "...", "text_b": "...", "nli_label": "...", ...}]
    """
    raw = sys.stdin.read(_MAX_STDIN_BYTES)
    items = json.loads(raw)
    if not items:
        json.dump([], sys.stdout)
        return

    nli_model = _load_nli_model()
    nli_pairs = [(item["text_a"], item["text_b"]) for item in items]

    print(f"Classifying {len(nli_pairs)} pairs...", file=sys.stderr)
    results = _classify_pairs_nli(nli_model, nli_pairs)

    # Merge NLI results back into input items (preserving extra fields)
    for item, nli in zip(items, results):
        item["nli_label"] = nli["label"]
        item["nli_entailment"] = nli["entailment"]
        item["nli_neutral"] = nli["neutral"]
        item["nli_contradiction"] = nli["contradiction"]

    json.dump(items, sys.stdout, indent=2)


def main():
    parser = argparse.ArgumentParser(
        description="Semantic embedding tools for the AI Triad taxonomy."
    )
    parser.add_argument(
        "--taxonomy-dir",
        default=None,
        help="Override taxonomy directory (default: resolved from .aitriad.json)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # generate
    gen = sub.add_parser("generate", help="Rebuild taxonomy/embeddings.json")
    gen.add_argument(
        "--field-weights",
        default=None,
        help=(
            "Comma-separated weights for description,assumes,lineage,epistemic,rhetorical fields "
            "(3-value format also accepted for backward compat) "
            f"(default: {','.join(str(w) for w in DEFAULT_FIELD_WEIGHTS)}). Must sum to ~1.0."
        ),
    )
    gen.add_argument(
        "--output",
        default=None,
        help=(
            "Optional output file path (default: <taxonomy-dir>/embeddings.json). "
            "Use this to write a non-default field-weights variant without overwriting "
            "production embeddings (t/1553 Stage 2 needs a 0.67/0.33 variant per t/524)."
        ),
    )
    gen.add_argument(
        "--conflicts-dir",
        default=None,
        help=(
            "Override the conflicts directory (default: resolved from .aitriad.json). "
            "Use when running from an unusual cwd/worktree where the relative data_root "
            "does not resolve, so conflicts are not silently dropped (t/2877)."
        ),
    )
    gen.add_argument(
        "--allow-missing-conflicts",
        action="store_true",
        help=(
            "Permit a run whose conflicts source does not resolve (intentionally "
            "conflict-free data). Without this, generate aborts rather than silently "
            "shipping a corpus with no conflicts (t/2877)."
        ),
    )

    # query
    q = sub.add_parser("query", help="Semantic search over taxonomy nodes")
    q.add_argument("text", help="The search text to find similar nodes for")
    q.add_argument(
        "--top",
        type=int,
        default=0,
        help="Return only the top N results (0 = all)",
    )
    q.add_argument(
        "--pov",
        default=None,
        help="Filter to a specific POV (e.g. safetyist)",
    )
    q.add_argument(
        "--type",
        choices=["node", "policy"],
        default=None,
        help="Filter to nodes only or policies only",
    )

    # find-overlaps
    o = sub.add_parser(
        "find-overlaps",
        help="Find node pairs with high embedding similarity (with NLI verification)",
    )
    o.add_argument(
        "--threshold",
        type=float,
        default=0.80,
        help="Minimum cosine similarity to report (default 0.80)",
    )
    o.add_argument(
        "--pov",
        default=None,
        help="Filter to pairs where at least one node is from this POV",
    )
    o.add_argument(
        "--cross-pov",
        action="store_true",
        help="Only report pairs where nodes are from different POVs",
    )
    o.add_argument(
        "--top",
        type=int,
        default=0,
        help="Limit output to top N pairs (0 = all)",
    )
    o.add_argument(
        "--no-nli",
        action="store_true",
        help="Skip NLI cross-encoder verification (faster, but no contradiction detection)",
    )

    # encode — output raw vector for a single text
    e = sub.add_parser("encode", help="Encode a single text to an embedding vector (JSON)")
    e.add_argument("text", nargs="?", default="-", help="The text to encode (use '-' or omit to read from stdin)")

    # batch-encode — encode multiple texts from stdin
    sub.add_parser("batch-encode", help="Encode multiple texts from stdin JSON [{id, text}] -> {id: vector}")

    # nli-classify — classify text pairs via NLI cross-encoder
    sub.add_parser(
        "nli-classify",
        help="Classify text pairs from stdin JSON [{text_a, text_b}] as entailment/neutral/contradiction",
    )

    # similarity-matrix — compute full pairwise similarity and output top-K cache
    sm = sub.add_parser(
        "similarity-matrix",
        help="Compute pairwise cosine similarity matrix and output top-K per node (NumPy-accelerated)",
    )
    sm.add_argument("--top-k", type=int, default=30, help="Top K similar nodes per node (default 30)")
    sm.add_argument("--threshold", type=float, default=0.10, help="Minimum similarity to include (default 0.10)")
    sm.add_argument("--output", "-o", default=None, help="Output file path (default: stdout)")
    sm.add_argument("--include-policies", action="store_true", help="Include pol-* nodes in matrix")

    args = parser.parse_args()
    _resolve_taxonomy_dir(args.taxonomy_dir, getattr(args, "conflicts_dir", None))

    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "query":
        cmd_query(args)
    elif args.command == "find-overlaps":
        cmd_find_overlaps(args)
    elif args.command == "encode":
        cmd_encode(args)
    elif args.command == "batch-encode":
        cmd_batch_encode(args)
    elif args.command == "nli-classify":
        cmd_nli_classify(args)
    elif args.command == "similarity-matrix":
        cmd_similarity_matrix(args)


if __name__ == "__main__":
    main()
