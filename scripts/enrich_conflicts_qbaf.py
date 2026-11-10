#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
enrich_conflicts_qbaf.py — Compute QBAF argumentation strength for conflict files.

For each conflict with 2+ instances, builds a QBAF argument graph from the
competing claims, runs DF-QuAD propagation via qbaf-bridge.mjs, and writes
the QBAF analysis back into the conflict JSON file.

Conflicts with only 1 instance are skipped (no argument graph to compute).

Usage:
  python scripts/enrich_conflicts_qbaf.py                  # dry-run
  python scripts/enrich_conflicts_qbaf.py --write           # enrich in-place
  python scripts/enrich_conflicts_qbaf.py --write --id conflict-some-id  # single conflict
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from data_tree_guard import assert_clean_data_tree  # t/2902

import numpy as np

_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent
_QBAF_BRIDGE = _SCRIPT_DIR / "qbaf-bridge.mjs"


def _resolve_data_root():
    config_path = _PROJECT_ROOT / ".aitriad.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
            data_root = cfg.get("data_root", ".")
            base = Path(data_root) if Path(data_root).is_absolute() else (_PROJECT_ROOT / data_root)
            return base.resolve()
        except (json.JSONDecodeError, OSError):
            pass
    return (_PROJECT_ROOT.parent / "ai-triad-data").resolve()


DATA_ROOT: Optional[Path] = None
CONFLICTS_DIR: Optional[Path] = None
TAXONOMY_DIR: Optional[Path] = None


def _log(msg):
    print(msg, file=sys.stderr)


def _load_taxonomy_nodes():
    """Load taxonomy node metadata for POV classification."""
    meta = {}
    for pov_name in ("accelerationist", "safetyist", "skeptic", "situations"):
        pov_path = TAXONOMY_DIR / f"{pov_name}.json"
        if not pov_path.exists():
            continue
        pov_data = json.loads(pov_path.read_text(encoding="utf-8"))
        for node in pov_data.get("nodes", []):
            meta[node["id"]] = {
                "pov": pov_name,
                "label": node.get("label", ""),
                "category": node.get("category", ""),
            }
    return meta


def _infer_pov(instance, linked_nodes, node_meta):
    """Infer which POV a claim instance belongs to based on linked taxonomy nodes."""
    doc_id = instance.get("doc_id", "")

    # Check linked nodes for POV hints
    pov_votes = {}
    for nid in linked_nodes:
        if nid in node_meta:
            pov = node_meta[nid]["pov"]
            pov_votes[pov] = pov_votes.get(pov, 0) + 1

    if pov_votes:
        # Return the most-linked POV
        return max(pov_votes, key=pov_votes.get)

    # Fallback: infer from node ID prefix in linked nodes
    for nid in linked_nodes:
        if nid.startswith("acc-"):
            return "accelerationist"
        elif nid.startswith("saf-"):
            return "safetyist"
        elif nid.startswith("skp-"):
            return "skeptic"
        elif nid.startswith("sit-"):
            return "situations"

    return "situations"  # default


def _determine_base_strength(instance):
    """Determine base strength for a claim instance.

    If the instance has pre-computed bdi_sub_scores, uses their average.
    Otherwise falls back to stance as a proxy:
    - supports/disputes: 0.6 (active position, moderate confidence)
    - qualifies: 0.4 (hedged position)
    - neutral: 0.3 (weak position)
    """
    bdi = instance.get("bdi_sub_scores")
    if bdi and isinstance(bdi, dict):
        values = [v for v in bdi.values() if isinstance(v, (int, float))]
        if values:
            return sum(values) / len(values)

    stance = instance.get("stance", "neutral")
    if stance in ("supports", "disputes"):
        return 0.6
    elif stance == "qualifies":
        return 0.4
    else:
        return 0.3


def _detect_edges(instances):
    """Detect attack/support edges between instances.

    Rules:
    - supports vs disputes on the same claim = attack (rebut)
    - same stance from different docs = support
    - qualifies vs supports/disputes = weak attack (undercut)
    """
    edges = []
    for i in range(len(instances)):
        for j in range(i + 1, len(instances)):
            a, b = instances[i], instances[j]
            # Skip same-document instances — but not debate-sourced ones.
            # Debate instances are independent agent positions sharing a session ID,
            # not duplicate extractions from one text (t/3214).
            doc_id_a = str(a.get("doc_id") or "")
            if a.get("doc_id") == b.get("doc_id") and not doc_id_a.startswith("debate:"):
                continue

            a_stance = a.get("stance", "neutral")
            b_stance = b.get("stance", "neutral")

            # Opposing stances = attack
            is_conflict = (
                (a_stance == "supports" and b_stance == "disputes") or
                (a_stance == "disputes" and b_stance == "supports")
            )
            # Same active stance = support
            is_support = (
                a_stance == b_stance and
                a_stance in ("supports", "disputes")
            )
            # Qualifies vs active = weak attack (undercut)
            is_undercut = (
                (a_stance == "qualifies" and b_stance in ("supports", "disputes")) or
                (b_stance == "qualifies" and a_stance in ("supports", "disputes"))
            )

            if is_conflict:
                # Use existing attack_type if classified, otherwise default to rebut
                attack_type = a.get("attack_type") or b.get("attack_type") or "rebut"
                edges.append({
                    "source": f"inst-{i}",
                    "target": f"inst-{j}",
                    "type": "attacks",
                    "weight": 0.7,
                    "attack_type": attack_type,
                })
            elif is_support:
                edges.append({
                    "source": f"inst-{i}",
                    "target": f"inst-{j}",
                    "type": "supports",
                    "weight": 0.5,
                })
            elif is_undercut:
                edges.append({
                    "source": f"inst-{i}" if a_stance == "qualifies" else f"inst-{j}",
                    "target": f"inst-{j}" if a_stance == "qualifies" else f"inst-{i}",
                    "type": "attacks",
                    "weight": 0.4,
                    "attack_type": "undercut",
                })

    return edges


# ── Fork-B: deterministic numeric/temporal contradiction detector (t/3302) ────────────────
# TL's mandatory high-precision complement to the LLM classifier (the naive strawman caught 0/6).
# Fires ONLY when two within-conflict assertions share a subject AND cite directly incompatible
# quantities of the SAME kind (percentages, years, or bare numbers). Conservative by design — a miss
# is fine (the LLM classifier / base prior covers it); a false attack CORRUPTS strength. CL scores
# its precision/recall separately on the golden (edges carry detector='numeric').

_CC_STOPWORDS = frozenset(
    "the a an of to in on for and or but with by from as at is are was were be been being this that "
    "these those it its their his her our your not no than then over under about into within will "
    "would could should may might can has have had do does did more most less least very".split()
)
_CC_WORD_RE = re.compile(r"[a-z]{3,}")
_CC_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|percent|percentage points?|pp\b)", re.IGNORECASE)
_CC_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\b")
_CC_NUM_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)")


def _cc_content_words(text):
    return {w for w in _CC_WORD_RE.findall((text or "").lower()) if w not in _CC_STOPWORDS}


def _cc_percents(text):
    return {round(float(m.group(1)), 3) for m in _CC_PCT_RE.finditer(text or "")}


def _cc_years(text):
    return {int(m.group(1)) for m in _CC_YEAR_RE.finditer(text or "")}


def _cc_bare_numbers(text):
    """Numbers that are neither a percentage value nor a 4-digit year."""
    t = text or ""
    pct_spans = [m.span(1) for m in _CC_PCT_RE.finditer(t)]
    years = _cc_years(t)
    out = set()
    for m in _CC_NUM_RE.finditer(t):
        if any(s <= m.start(1) < e for (s, e) in pct_spans):
            continue
        try:
            f = float(m.group(1))
        except ValueError:
            continue
        if f == int(f) and int(f) in years:
            continue
        out.add(round(f, 3))
    return out


_CC_MAG_RE = re.compile(r"\b(billion|million|trillion|thousand|fold)\b", re.IGNORECASE)
_CC_CUR_RE = re.compile(r"[$€£]")


def _mask_numbers(text):
    """Replace numeric values (%, years, currency, magnitudes, bare numbers) with a NUM placeholder so an
    embedding of the result captures the METRIC/subject, not the values (t/3337#5 same-subject gate)."""
    t = text or ""
    t = _CC_PCT_RE.sub(" NUM ", t)                       # percentages / 'percent' / pp
    t = _CC_YEAR_RE.sub(" NUM ", t)                      # years
    t = re.sub(r"(?<![\w.])\d+(?:\.\d+)?", " NUM ", t)   # bare numbers
    t = _CC_CUR_RE.sub(" NUM ", t)                       # currency symbols
    t = _CC_MAG_RE.sub(" NUM ", t)                       # magnitude words
    return re.sub(r"\s+", " ", t).strip()


def _detect_numeric_temporal_conflict(text_a, text_b, embedder=None, subject_threshold=0.93):
    """True iff A and B describe the SAME quantity AND cite directly incompatible values of the same kind.

    Two-stage (t/3337#5, calibrated on the same-doc census — the old ≥3-shared-word subject proxy was
    0/54 precision, firing on different-subject pairs like "17% postings" vs "24% skills"):
      1. candidate: >=3 shared content words + a same-kind numeric set (percentages / years / bare;
         bare needs >=4 shared) non-empty on BOTH sides and disjoint. Same unit-type is enforced by the
         per-kind branches (a percent can't pair with a bare number).
      2. same-subject HARD-GATE: mask the numbers, embed both (MiniLM), and fire ONLY if masked-cosine
         >= subject_threshold (0.93) — i.e. the disjoint numbers describe the same metric, not merely
         co-occur. embedder is injectable for tests (default = local MiniLM).

    Known v1 residual (accepted, CL t/3337#5): same-metric-DIFFERENT-SCOPE ("top 10%" vs "top 20%") and
    rounding (63% vs 65%) pass the subject gate — masked-cosine can't separate them; the LLM arbitrates.
    """
    shared = _cc_content_words(text_a) & _cc_content_words(text_b)
    if len(shared) < 3:
        return False
    candidate = False
    pa, pb = _cc_percents(text_a), _cc_percents(text_b)
    if pa and pb and pa.isdisjoint(pb):
        candidate = True
    if not candidate:
        ya, yb = _cc_years(text_a), _cc_years(text_b)
        if ya and yb and ya.isdisjoint(yb):
            candidate = True
    if not candidate and len(shared) >= 4:
        na, nb = _cc_bare_numbers(text_a), _cc_bare_numbers(text_b)
        if na and nb and na.isdisjoint(nb):
            candidate = True
    if not candidate:
        return False
    # same-subject hard-gate: the numbers must be about the SAME quantity (not just word-overlapping).
    embedder = embedder or _default_embedder
    va, vb = embedder([_mask_numbers(text_a), _mask_numbers(text_b)])
    return _cosine(va, vb) >= subject_threshold


def _qbaf_testedness(qbaf, instances):
    """Observability metric for one resolved QBAF (t/3302).

    Surfaces the "how tested is this resolution" signal so all-prior debates (a
    computed_strength that is purely the unrevised base prior) are visible rather than
    presenting as substantive. Schema confirmed by CL (t/3302#2). Pure read of the
    finalized qbaf + its source instances; no side effects.

    testedness tiers:
      all_prior     — 0 edges: the resolution is unrevised base strengths.
      support_only  — has edges but 0 attacks: agreement only, never adversarially tested.
      adversarial   — >=1 attack edge: at least one node was genuinely challenged.
    """
    graph = qbaf.get("graph") or {}
    edges = graph.get("edges") or []
    nodes = graph.get("nodes") or []
    n_attack = sum(1 for e in edges if e.get("type") == "attacks")
    n_support = sum(1 for e in edges if e.get("type") == "supports")
    attacked = {e.get("target") for e in edges if e.get("type") == "attacks"}
    n_untested = sum(1 for n in nodes if n.get("id") not in attacked)

    stance_hist = {}
    for inst in instances:
        s = str(inst.get("stance", "neutral"))
        stance_hist[s] = stance_hist.get(s, 0) + 1
    has_opposing = ("supports" in stance_hist and "disputes" in stance_hist)

    if not edges:
        tier = "all_prior"
    elif n_attack == 0:
        tier = "support_only"
    else:
        tier = "adversarial"

    return {
        "n_instances": len(instances),
        "n_edges": len(edges),
        "n_support_edges": n_support,
        "n_attack_edges": n_attack,
        "n_untested_nodes": n_untested,
        "testedness": tier,
        "has_opposing_stances": has_opposing,
        "stance_hist": stance_hist,
    }


_AI_KEY_VARS = ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "AI_API_KEY")


def _safe_env(include_ai_keys=False):
    """Build a minimal environment for subprocess calls. By default NO API keys are forwarded (the
    Node qbaf-bridge needs none). include_ai_keys=True additionally forwards the AI backend key vars —
    REQUIRED for the contradiction-classifier subprocess (_run_cc_shim), which authenticates the LLM
    call; without them every pair returns 'unresolved' (t/3336 live-run failure). Keys still never reach
    the bridge call, so this is a scoped forward, not a blanket leak."""
    import os
    allowed = {"PATH", "NODE_PATH", "HOME", "USER", "LANG", "TERM", "SHELL",
               "TMPDIR", "XDG_RUNTIME_DIR", "SYSTEMROOT", "COMSPEC"}
    env = {k: v for k, v in os.environ.items() if k in allowed}
    if include_ai_keys:
        for k in _AI_KEY_VARS:
            if os.environ.get(k):
                env[k] = os.environ[k]
    return env


def _run_qbaf_bridge(nodes, edges):
    """Call qbaf-bridge.mjs via subprocess and return the result."""
    qbaf_input = {
        "nodes": nodes,
        "edges": [
            {k: v for k, v in e.items() if k != "attack_type"}
            for e in edges
        ],
    }

    # On Windows, use npx.cmd; on Unix, use npx
    npx_cmd = "npx.cmd" if sys.platform == "win32" else "npx"

    result = subprocess.run(
        [npx_cmd, "tsx", str(_QBAF_BRIDGE)],
        input=json.dumps(qbaf_input),
        capture_output=True,
        text=True,
        timeout=30,
        cwd=str(_PROJECT_ROOT),
        env=_safe_env(),
    )

    if result.returncode != 0:
        raise RuntimeError(f"qbaf-bridge error: {result.stderr.strip()}")

    return json.loads(result.stdout)


def _run_qbaf_bridge_batch(batch):
    """Call qbaf-bridge.mjs once for a batch of QBAF graphs.

    Input:  list of {"nodes": [...], "edges": [...]} dicts
    Output: list of result dicts (same order), or raises on failure
    """
    batch_input = {"batch": batch}

    npx_cmd = "npx.cmd" if sys.platform == "win32" else "npx"

    result = subprocess.run(
        [npx_cmd, "tsx", str(_QBAF_BRIDGE)],
        input=json.dumps(batch_input),
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(_PROJECT_ROOT),
        env=_safe_env(),
    )

    if result.returncode != 0:
        raise RuntimeError(f"qbaf-bridge batch error: {result.stderr.strip()}")

    parsed = json.loads(result.stdout)
    if isinstance(parsed, list):
        return parsed
    # Fallback: single-item bridge returns a single object
    return [parsed]


def enrich_conflict(conflict, node_meta, extra_edges=None):
    """Compute QBAF analysis for a single conflict and return the qbaf object.

    extra_edges (fork-B semantic-opposition edges, t/3302) are merged after the stance-based edges,
    deduped on (source, target). Returns None if the conflict has <2 instances.
    """
    instances = conflict.get("instances") or []
    if len(instances) < 2:
        return None

    linked_nodes = conflict.get("linked_taxonomy_nodes") or []

    # Build QBAF nodes from instances
    qbaf_nodes_input = []
    qbaf_nodes_output = []

    for i, inst in enumerate(instances):
        node_id = f"inst-{i}"
        base_strength = _determine_base_strength(inst)
        pov = _infer_pov(inst, linked_nodes, node_meta)

        qbaf_nodes_input.append({
            "id": node_id,
            "base_strength": base_strength,
        })

        # Map POV names to schema enum
        pov_map = {
            "accelerationist": "accelerationist",
            "safetyist": "safetyist",
            "skeptic": "skeptic",
            "situations": "situations",
        }

        node_out: dict = {
            "id": node_id,
            "text": inst.get("assertion", "")[:200],
            "source_pov": pov_map.get(pov, "situations"),
            "base_strength": base_strength,
            "computed_strength": base_strength,  # placeholder, updated below
        }
        if inst.get("bdi_category"):
            node_out["bdi_category"] = inst["bdi_category"]
        if inst.get("bdi_sub_scores"):
            node_out["bdi_sub_scores"] = inst["bdi_sub_scores"]
        qbaf_nodes_output.append(node_out)

    # Detect edges (stance-based) + merge fork-B semantic edges (t/3302), deduped on (source,target).
    edges = _detect_edges(instances)
    if extra_edges:
        seen = set()
        for e in edges:
            seen.add((e["source"], e["target"]))
            seen.add((e["target"], e["source"]))
        for e in extra_edges:
            key = (e["source"], e["target"])
            if key not in seen:
                edges.append(e)
                seen.add(key)
                seen.add((e["target"], e["source"]))

    if not edges:
        # No relationships detected — still useful to record base strengths
        # but no propagation needed
        return {
            "graph": {
                "nodes": qbaf_nodes_output,
                "edges": [],
            },
            "computed_at": datetime.now().isoformat(),
            "algorithm": "df-quad",
            "iterations": 0,
        }

    # Return pre-bridge data for batch processing. Provenance fields (detector/edge_origin/confidence)
    # are persisted in edge_output for audit but stripped from the bridge input (whitelist in main).
    edge_output = []
    for e in edges:
        out = {
            "source": e["source"],
            "target": e["target"],
            "type": e["type"],
            "weight": e["weight"],
        }
        if e.get("attack_type"):
            out["attack_type"] = e["attack_type"]
        for prov in ("detector", "edge_origin", "confidence"):
            if e.get(prov) is not None:
                out[prov] = e[prov]
        edge_output.append(out)

    return {
        "_needs_bridge": True,
        "qbaf_nodes_input": qbaf_nodes_input,
        "qbaf_nodes_output": qbaf_nodes_output,
        "edges": edges,
        "edge_output": edge_output,
    }


# ── Fork-B: semantic-opposition edge detection (t/3302, TL-approved seam t/3302#16) ───────
# Within-conflict pairs with NO stance edge (the recall gap: 97% never attacked) are classified:
# the deterministic numeric/temporal detector first (high precision), then the LLM contradiction
# classifier for the rest via the file-based pwsh bridge. contradict->attack, entail->support.
# Opt-in (--semantic-edges); owner runs the paid classification (--write). CL scores the golden.

_CC_SHIM = _SCRIPT_DIR / "invoke-contradiction-classifier.ps1"
# Classifier provenance handle (TL GV cond 1, t/3302#24): the ai-usages.json UsageID is the stable
# id/version for the LLM contradiction classifier (the concrete model resolves from ai-models.json).
_CC_USAGE_ID = "enrichment.contradiction-classify"


def _collect_semantic_candidates(conflict, include_same_doc=False):
    """Within-conflict pairs that have NO stance-based edge. Returns [{i,j,a,b,same_doc}].

    By default same-doc pairs are skipped (duplicate extractions) except debate: (independent agent
    positions, t/3214). With include_same_doc=True (fork-B expansion, t/3336) same-doc non-debate pairs
    are RETAINED and tagged same_doc=True; the caller applies the cosine dedup gate (_apply_samedoc_dedup)
    to drop near-identical duplicate extractions before classification. Cross-doc pairs are same_doc=False."""
    instances = conflict.get("instances") or []
    if len(instances) < 2:
        return []
    existing = set()
    for e in _detect_edges(instances):
        existing.add((e["source"], e["target"]))
        existing.add((e["target"], e["source"]))
    cands = []
    for i in range(len(instances)):
        for j in range(i + 1, len(instances)):
            if (f"inst-{i}", f"inst-{j}") in existing:
                continue
            a, b = instances[i], instances[j]
            doc_a = str(a.get("doc_id") or "")
            is_same_doc = (a.get("doc_id") == b.get("doc_id")) and not doc_a.startswith("debate:")
            if is_same_doc and not include_same_doc:
                continue
            ta = str(a.get("assertion") or "").strip()
            tb = str(b.get("assertion") or "").strip()
            if ta and tb:
                cands.append({"i": i, "j": j, "a": ta, "b": tb, "same_doc": is_same_doc})
    return cands


def _cosine(u, v):
    """Cosine similarity of two vectors; 0.0 if either is degenerate."""
    u = np.asarray(u, dtype=float)
    v = np.asarray(v, dtype=float)
    nu = float(np.linalg.norm(u))
    nv = float(np.linalg.norm(v))
    if nu == 0.0 or nv == 0.0:
        return 0.0
    return float(np.dot(u, v) / (nu * nv))


_ST_MODEL = None


def _default_embedder(texts):
    """Encode texts with the local all-MiniLM-L6-v2 model (matches the corpus encoder). Lazy-loaded so
    the dependency + model load only happen when the same-doc gate is actually used."""
    global _ST_MODEL
    if _ST_MODEL is None:
        import embed_model_pins  # lazy: heavy import, opt-in path only. t/110: pinned revision
        _ST_MODEL = embed_model_pins.load_sentence_transformer("all-MiniLM-L6-v2")
    return _ST_MODEL.encode(list(texts), normalize_embeddings=False)


def _apply_samedoc_dedup(cands, threshold=0.93, embedder=None):
    """Drop same-doc candidate pairs whose two assertions are near-identical (cosine >= threshold) —
    duplicate extractions, not genuine opposition (CL gate t/3336#7; blocks the '54% vs 45%-typo' false
    attack). Cross-doc pairs (same_doc=False) pass through untouched. embedder(list[str])->list[vec] is
    injectable for tests (default = local MiniLM). Batch-embeds once."""
    sd_idx = [k for k, c in enumerate(cands) if c.get("same_doc")]
    if not sd_idx:
        return list(cands)
    embedder = embedder or _default_embedder
    texts = []
    for k in sd_idx:
        texts.append(cands[k]["a"])
        texts.append(cands[k]["b"])
    vecs = embedder(texts)
    drop = set()
    for m, k in enumerate(sd_idx):
        if _cosine(vecs[2 * m], vecs[2 * m + 1]) >= threshold:
            drop.add(k)
    if drop:
        _log(f"  Fork-B same-doc dedup: dropped {len(drop)}/{len(sd_idx)} same-doc pair(s) at cosine>={threshold} "
             f"(near-identical duplicate extractions, t/3336).")
    return [c for k, c in enumerate(cands) if k not in drop]


def _mk_semantic_edge(i, j, detector, edge_type="attacks", confidence=None, classifier=None, tau=None):
    edge = {
        "source": f"inst-{i}",
        "target": f"inst-{j}",
        "type": edge_type,
        "weight": 0.6,
        "detector": detector,      # 'numeric' | 'llm' — provenance for CL scoring + audit
        "edge_origin": "semantic",
    }
    if edge_type == "attacks":
        edge["attack_type"] = "rebut"
    if confidence is not None:
        edge["confidence"] = round(float(confidence), 4)
    # Provenance (TL GV cond 1, t/3302#24): classifier id/version + operating threshold τ, so a written
    # edge is auditable + regenerable. Numeric edges carry no classifier (deterministic detector).
    if classifier is not None:
        edge["classifier"] = classifier
    if tau is not None:
        edge["tau"] = round(float(tau), 4)
    return edge


def _mk_attack_edges(i, j, detector, confidence=None, classifier=None, tau=None):
    """A contradiction is SYMMETRIC — it tests BOTH claims (TL ruling t/3336#4): emit attack edges in
    both directions (i->j and j->i) so each endpoint gains an incoming attack (adversarial tier).
    Entailment stays directional (single support edge) — it is not symmetric."""
    return [
        _mk_semantic_edge(i, j, detector, "attacks", confidence, classifier, tau),
        _mk_semantic_edge(j, i, detector, "attacks", confidence, classifier, tau),
    ]


def _run_cc_shim(batch_conflicts, mode="per-conflict", temperature=0.0):
    """FILE-BASED bridge to invoke-contradiction-classifier.ps1 (pair texts via a temp-file PATH, NOT
    inline — quotes/newlines shell-corruption hazard, TL t/3302#16). Returns {id: {label,confidence}}.
    Fallback: any failure -> {} (no LLM edges) + WARN; never fabricates edges."""
    import os
    import tempfile
    if not batch_conflicts:
        return {}
    tmp = None
    out_tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".json", prefix="cc-batch-")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"conflicts": batch_conflicts}, fh, ensure_ascii=False)
        # Results come back via a FILE (-OutPath), not stdout: the shim's Write-Warning fallback notices
        # render onto stdout ahead of the JSON and break json.loads (t/3302 live-run failure).
        out_fd, out_tmp = tempfile.mkstemp(suffix=".json", prefix="cc-out-")
        os.close(out_fd)
        result = subprocess.run(
            ["pwsh", "-NoProfile", "-NonInteractive", "-File", str(_CC_SHIM),
             "-InputPath", tmp, "-Mode", mode, "-Temperature", str(temperature), "-OutPath", out_tmp],
            capture_output=True, text=True, timeout=600, cwd=str(_PROJECT_ROOT),
            env=_safe_env(include_ai_keys=True),  # classifier authenticates the LLM call (t/3336)
        )
        if result.returncode != 0:
            _log(f"  WARN: contradiction-classifier exited {result.returncode} "
                 f"({result.stderr.strip()[:200]}) — 0 semantic LLM edges (fallback, t/3302).")
            return {}
        with open(out_tmp, "r", encoding="utf-8") as fh:
            parsed = json.loads(fh.read())
        out = {}
        for r in parsed.get("results", []):
            out[str(r.get("id"))] = {"label": r.get("label"), "confidence": r.get("confidence", 0.0),
                                     "method": r.get("method")}
        return out
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as exc:
        _log(f"  WARN: contradiction-classifier failed ({exc}) — 0 semantic LLM edges (fallback, t/3302).")
        return {}
    finally:
        for _p in (tmp, out_tmp):
            if _p and os.path.exists(_p):
                try:
                    os.remove(_p)
                except OSError:
                    pass


def detect_semantic_edges(to_process, min_confidence=0.0, mode="per-conflict", cc_runner=None,
                          predictions_sink=None, include_same_doc=False, dedup_threshold=0.93,
                          embedder=None):
    """Fork-B semantic edges (t/3302). Numeric/temporal detector first (high precision), then the LLM
    classifier for the rest. Contradictions emit SYMMETRIC attack edges (both endpoints tested, TL
    ruling t/3336#4); entailment emits a single directional support edge. Returns {conflict_index:
    [edge,...]}. cc_runner is injectable for tests.

    include_same_doc (t/3336): relax the same-doc skip and run CL's cosine dedup gate — retain same-doc
    non-debate pairs EXCEPT near-identical duplicate extractions (cosine >= dedup_threshold). embedder
    is injectable for tests (default = local MiniLM).

    predictions_sink (t/3336 benefit arm): if a list is passed, EVERY (post-dedup) candidate pair's raw
    disposition is appended as {conflict_id, source, target, predicted, confidence, method} — numeric as
    contradict/1.0/numeric and the rest as the classifier's raw (pre-τ) label. CL applies τ=0.90 and
    recomputes qbaf.testedness for the node-tier Δ. The candidate set == the --write set."""
    cc_runner = cc_runner or _run_cc_shim
    edges_by_ci = {}
    batch_conflicts = []
    llm_pairs = {}  # pair-id -> (ci, i, j)
    ci_to_cid = {}  # ci -> conflict id, for predictions_sink attribution

    for ci, (_path, conflict) in enumerate(to_process):
        cands = _collect_semantic_candidates(conflict, include_same_doc=include_same_doc)
        if include_same_doc:
            cands = _apply_samedoc_dedup(cands, threshold=dedup_threshold, embedder=embedder)
        if not cands:
            continue
        cid = str(conflict.get("claim_id") or ci)
        ci_to_cid[ci] = cid
        conflict_pairs = []
        for c in cands:
            if _detect_numeric_temporal_conflict(c["a"], c["b"], embedder=embedder):
                edges_by_ci.setdefault(ci, []).extend(
                    _mk_attack_edges(c["i"], c["j"], "numeric", 1.0, tau=min_confidence))
                if predictions_sink is not None:
                    predictions_sink.append({
                        "conflict_id": cid, "source": f"inst-{c['i']}", "target": f"inst-{c['j']}",
                        "predicted": "contradict", "confidence": 1.0, "method": "numeric"})
            else:
                pid = f"{ci}:{c['i']}:{c['j']}"
                conflict_pairs.append({"id": pid, "a": c["a"], "b": c["b"]})
                llm_pairs[pid] = (ci, c["i"], c["j"])
        if conflict_pairs:
            batch_conflicts.append({"cid": cid, "pairs": conflict_pairs})

    if batch_conflicts:
        results = cc_runner(batch_conflicts, mode, 0.0)
        for pid, (ci, i, j) in llm_pairs.items():
            r = results.get(pid)
            if predictions_sink is not None:
                # Raw, pre-τ — CL applies the τ=0.90 rule (contradict AND conf>=0.90 -> attack).
                predictions_sink.append({
                    "conflict_id": ci_to_cid.get(ci), "source": f"inst-{i}", "target": f"inst-{j}",
                    "predicted": (r.get("label") if r else "missing"),
                    "confidence": (float(r.get("confidence") or 0.0) if r else 0.0),
                    "method": ((r.get("method") or "llm") if r else "missing")})
            if not r:
                continue
            conf = float(r.get("confidence") or 0.0)
            if conf < min_confidence:
                continue
            label = r.get("label")
            if label == "contradict":
                edges_by_ci.setdefault(ci, []).extend(
                    _mk_attack_edges(i, j, "llm", conf, classifier=_CC_USAGE_ID, tau=min_confidence))
            elif label == "entail":
                edges_by_ci.setdefault(ci, []).append(
                    _mk_semantic_edge(i, j, "llm", "supports", conf, classifier=_CC_USAGE_ID, tau=min_confidence))
            # neutral / unresolved / missing -> no edge
    return edges_by_ci


# Resolution margin floor (t/3151, CL neutrality ruling t/3151#2). computed_strength is DF-QuAD
# in [0, 1]; a top−runner-up gap below this means the two sides are not meaningfully separated, so
# crowning the first-listed instance is noise (Python's stable sort silently made inst-0 win a
# perfect tie with margin 0.0). Below the floor → explicit `undecided` (mirrors the crux layer);
# at/above → `decided`. Stipulated day-one (registered; derivation path is t/3152).
QBAF_MARGIN_FLOOR = 0.05


def _finalize_qbaf(pre, bridge_result):
    """Finalize a QBAF object after bridge results are available."""
    qbaf_nodes_output = pre["qbaf_nodes_output"]
    edge_output = pre["edge_output"]

    strengths = bridge_result.get("strengths", {})
    for node in qbaf_nodes_output:
        if node["id"] in strengths:
            node["computed_strength"] = round(strengths[node["id"]], 4)

    resolution = None
    if len(qbaf_nodes_output) >= 2:
        sorted_nodes = sorted(qbaf_nodes_output, key=lambda n: n["computed_strength"], reverse=True)
        top = sorted_nodes[0]
        runner_up = sorted_nodes[1]
        margin = round(top["computed_strength"] - runner_up["computed_strength"], 4)
        if margin < QBAF_MARGIN_FLOOR:
            # Sides not meaningfully separated — explicit undecided, never a first-listed default.
            resolution = {
                "verdict": "undecided",
                "prevailing_claim": None,
                "prevailing_strength": None,
                "margin": margin,
                "criterion": "qbaf_computed_strength",
                "reason": "margin below floor — sides not meaningfully separated",
            }
        else:
            resolution = {
                "verdict": "decided",
                "prevailing_claim": top["id"],
                "prevailing_strength": top["computed_strength"],
                "margin": margin,
                "criterion": "qbaf_computed_strength",
            }

    qbaf = {
        "graph": {
            "nodes": qbaf_nodes_output,
            "edges": edge_output,
        },
        "computed_at": datetime.now().isoformat(),
        "algorithm": "df-quad",
        "iterations": bridge_result.get("iterations", 0),
    }

    if resolution:
        qbaf["resolution"] = resolution

    return qbaf


def main():
    global DATA_ROOT, CONFLICTS_DIR, TAXONOMY_DIR
    DATA_ROOT = _resolve_data_root()
    CONFLICTS_DIR = DATA_ROOT / "conflicts"
    TAXONOMY_DIR = DATA_ROOT / "taxonomy" / "Origin"

    parser = argparse.ArgumentParser(description="Enrich conflict files with QBAF analysis")
    parser.add_argument("--write", action="store_true",
                        help="Write QBAF results back into conflict files")
    parser.add_argument("--id", type=str, default="",
                        help="Process a single conflict by claim_id")
    parser.add_argument("--force", action="store_true",
                        help="Recompute QBAF even if already present")
    parser.add_argument("--semantic-edges", action="store_true",
                        help="Fork-B (t/3302): add semantic-opposition edges for within-conflict "
                             "pairs with no stance edge (numeric/temporal detector + LLM classifier)")
    parser.add_argument("--semantic-min-confidence", type=float, default=0.0,
                        help="Min LLM confidence to accept a semantic edge (calibrate from CL's P/R curve)")
    parser.add_argument("--classify-mode", choices=["per-conflict", "per-pair"], default="per-conflict",
                        help="LLM classify batching mode (per-conflict batch with per-pair fallback)")
    parser.add_argument("--emit-semantic-predictions", type=str, default="",
                        help="Benefit-arm dry-run (t/3336): classify all --write candidate pairs and write "
                             "raw per-pair predictions {conflict_id,source,target,predicted,confidence,method} "
                             "to this path. No data write. Requires --semantic-edges; ignores --write.")
    parser.add_argument("--semantic-include-samedoc", action="store_true",
                        help="Fork-B expansion (t/3336): also consider same-doc non-debate pairs, gated by a "
                             "cosine dedup (drops near-identical duplicate extractions). Opt-in; off by default.")
    parser.add_argument("--semantic-dedup-threshold", type=float, default=0.93,
                        help="Cosine >= this drops a same-doc pair as a duplicate extraction (CL gate, t/3336#7). "
                             "Only used with --semantic-include-samedoc.")
    args = parser.parse_args()

    _log("=" * 60)
    _log("QBAF Enrichment Pipeline")
    _log("=" * 60)

    # Load taxonomy metadata
    _log("\n[1/3] Loading taxonomy metadata...")
    node_meta = _load_taxonomy_nodes()
    _log(f"  Loaded {len(node_meta)} taxonomy nodes")

    # Load conflicts from conflicts.json
    _log("\n[2/3] Loading conflicts...")
    conflicts_file = CONFLICTS_DIR / "conflicts.json"
    if not conflicts_file.exists():
        _log(f"  ERROR: {conflicts_file} not found")
        return

    try:
        wrapper = json.loads(conflicts_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        _log(f"  ERROR reading {conflicts_file}: {exc}")
        return

    all_entries = wrapper.get("conflicts", [])
    conflicts = []
    for data in all_entries:
        if args.id and data.get("claim_id") != args.id:
            continue
        conflicts.append((conflicts_file, data))

    _log(f"  Loaded {len(conflicts)} conflicts")

    # Filter to eligible (2+ instances)
    eligible = [(p, d) for p, d in conflicts if len(d.get("instances") or []) >= 2]
    already_has_qbaf = sum(1 for _, d in eligible if d.get("qbaf"))

    if not args.force:
        to_process = [(p, d) for p, d in eligible if not d.get("qbaf")]
    else:
        to_process = eligible

    _log(f"  Eligible (2+ instances): {len(eligible)}")
    _log(f"  Already have QBAF: {already_has_qbaf}")
    _log(f"  To process: {len(to_process)}")

    if not to_process:
        _log("\n  Nothing to process.")
        return

    # Process: build all graphs locally, then batch the bridge call
    _log(f"\n[3/3] Computing QBAF for {len(to_process)} conflicts...")
    t0 = time.time()
    enriched = 0
    failed = 0
    no_edges = 0
    # t/3302 observability — aggregate testedness tiers across this run (CL schema t/3302#2).
    tier_counts = {"all_prior": 0, "support_only": 0, "adversarial": 0}

    # Fork-B semantic-opposition pre-pass (t/3302). Computes extra edges per conflict index BEFORE
    # phase 1 so they merge into the same QBAF graph. Opt-in (--semantic-edges); the LLM path is
    # paid so the owner runs it under --write.
    semantic_by_ci = {}
    if getattr(args, "semantic_edges", False):
        _emit_path = getattr(args, "emit_semantic_predictions", "") or ""
        _sink = [] if _emit_path else None
        _inc_sd = getattr(args, "semantic_include_samedoc", False)
        _log(f"\n  Fork-B: detecting semantic-opposition edges (mode={args.classify_mode}, "
             f"min_conf={args.semantic_min_confidence}, include_same_doc={_inc_sd})...")
        semantic_by_ci = detect_semantic_edges(
            to_process, min_confidence=args.semantic_min_confidence, mode=args.classify_mode,
            predictions_sink=_sink, include_same_doc=_inc_sd,
            dedup_threshold=getattr(args, "semantic_dedup_threshold", 0.93))
        _n_sem = sum(len(v) for v in semantic_by_ci.values())
        _log(f"  Fork-B: {_n_sem} semantic edge(s) across {len(semantic_by_ci)} conflict(s).")
        if _emit_path:
            # Benefit-arm dry-run (t/3336): dump raw per-pair predictions for CL's node-tier Δ. No data
            # write — this path exits before the QBAF write phases regardless of --write.
            _doc = {
                "_meta": {
                    "ticket": "t/3336",
                    "purpose": "benefit-arm corpus predictions (CL scores node-tier Δ vs the ratified bar)",
                    "candidate_set": "within-conflict pairs with no existing stance edge (== --write set)",
                    "tau_note": "raw pre-τ predictions; CL applies τ=0.90 (contradict AND conf>=0.90 -> attack)",
                    "classifier": _CC_USAGE_ID,
                    "classify_mode": args.classify_mode,
                    "include_same_doc": _inc_sd,
                    "dedup_threshold": getattr(args, "semantic_dedup_threshold", 0.93),
                    "n_predictions": len(_sink),
                },
                "predictions": _sink,
            }
            with open(_emit_path, "w", encoding="utf-8") as fh:
                json.dump(_doc, fh, ensure_ascii=False, indent=2)
            _log(f"  Fork-B benefit arm: wrote {len(_sink)} predictions -> {_emit_path} "
                 f"(dry-run, no data write). Hand to CL to compute the node-tier Δ.")
            return

    # Phase 1: build local graphs (no subprocess)
    pre_results = []  # (index, path, conflict, pre_data_or_qbaf)
    bridge_batch = []  # items needing bridge computation
    bridge_indices = []  # indices into pre_results for bridge items

    for i, (path, conflict) in enumerate(to_process):
        pre = enrich_conflict(conflict, node_meta, extra_edges=semantic_by_ci.get(i))

        if pre is None:
            pre_results.append((i, path, conflict, None))
            continue

        if isinstance(pre, dict) and pre.get("_needs_bridge"):
            pre_results.append((i, path, conflict, pre))
            bridge_batch.append({
                "nodes": pre["qbaf_nodes_input"],
                # Whitelist ONLY the bridge's schema fields — strip attack_type + the fork-B provenance
                # (detector/edge_origin/confidence), which the DF-QuAD bridge doesn't accept.
                "edges": [
                    {"source": e["source"], "target": e["target"], "type": e["type"], "weight": e["weight"]}
                    for e in pre["edges"]
                ],
            })
            bridge_indices.append(len(pre_results) - 1)
        else:
            # No edges — already a complete qbaf dict
            pre_results.append((i, path, conflict, pre))

    # Phase 2: single batch bridge call for all graphs that need propagation
    bridge_results = []
    if bridge_batch:
        _log(f"  Sending {len(bridge_batch)} graphs to QBAF bridge (single process)...")
        try:
            bridge_results = _run_qbaf_bridge_batch(bridge_batch)
        except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            _log(f"  Batch bridge failed: {exc} — falling back to per-conflict")
            # Fallback: run individually
            bridge_results = []
            for item in bridge_batch:
                try:
                    r = _run_qbaf_bridge(item["nodes"], [{"source": e["source"], "target": e["target"], "type": e["type"], "weight": e["weight"]} for e in item.get("edges", [])])
                    bridge_results.append(r)
                except Exception:
                    bridge_results.append(None)

    # Phase 3: finalize and write
    bridge_idx = 0
    for idx, path, conflict, pre in pre_results:
        if pre is None:
            failed += 1
            continue

        if isinstance(pre, dict) and pre.get("_needs_bridge"):
            br = bridge_results[bridge_idx] if bridge_idx < len(bridge_results) else None
            bridge_idx += 1
            if br is None:
                failed += 1
                continue
            qbaf = _finalize_qbaf(pre, br)
        else:
            qbaf = pre
            no_edges += 1

        # t/3302 observability: record the testedness metric on the qbaf + accumulate the tier.
        # WARN per-conflict on all_prior (Fallback-Path Logging: a resolution that is purely the
        # unrevised base prior is a measurement gap); aggregate-count support_only rather than
        # per-conflict WARN it (CL t/3302#2).
        tm = _qbaf_testedness(qbaf, conflict.get("instances") or [])
        qbaf["testedness"] = tm
        tier_counts[tm["testedness"]] = tier_counts.get(tm["testedness"], 0) + 1
        if tm["testedness"] == "all_prior":
            _log(f"  WARN: QBAF all_prior (0 edges) for {conflict.get('claim_id')} — "
                 f"{tm['n_instances']} instances, stance_hist={tm['stance_hist']}; resolution is "
                 f"unrevised base strengths (measurement gap, t/3302).")

        conflict["qbaf"] = qbaf
        enriched += 1

    _log(f"  enriched={enriched} no_edges={no_edges} failed={failed}")

    if args.write and enriched > 0:
        from datetime import timezone
        wrapper["last_modified"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        wrapper["conflict_count"] = len(wrapper.get("conflicts", []))
        assert_clean_data_tree(conflicts_file)  # t/2902
        conflicts_file.write_text(
            json.dumps(wrapper, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        _log(f"  Wrote updated conflicts.json ({enriched} enriched)")

    elapsed = time.time() - t0

    _log(f"\n{'=' * 60}")
    _log(f"Results ({elapsed:.1f}s):")
    _log(f"  Enriched with QBAF: {enriched}")
    _log(f"  No edges (base strength only): {no_edges}")
    _log(f"  Failed: {failed}")
    # t/3302 observability — testedness tier distribution across this run.
    _tt = enriched or 1
    _log(f"  Testedness: all_prior={tier_counts['all_prior']} "
         f"({100*tier_counts['all_prior']/_tt:.0f}%) | support_only={tier_counts['support_only']} "
         f"({100*tier_counts['support_only']/_tt:.0f}%) | adversarial={tier_counts['adversarial']} "
         f"({100*tier_counts['adversarial']/_tt:.0f}%)")
    if not args.write:
        _log(f"  DRY RUN — use --write to persist")
    _log(f"{'=' * 60}")

    json.dump({
        "status": "complete" if args.write else "dry_run",
        "total_conflicts": len(conflicts),
        "eligible": len(eligible),
        "enriched": enriched,
        "no_edges": no_edges,
        "failed": failed,
        "testedness_tiers": tier_counts,
    }, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
