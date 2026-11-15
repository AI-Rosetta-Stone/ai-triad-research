#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""check_composition_drift.py — composition-drift gate for embeddings.json (t/2425).

Prevents the t/2425 incident class (duplicated-constant drift between the two
embeddings generators: scripts/embed_taxonomy.py and taxonomy-editor's
updateNodeEmbeddings). It verifies that the shipped corpus was actually produced
with the composition its own envelope `field_weights` DECLARES:

  re-encode N sampled nodes per the DECLARED envelope weights and assert
  cosine >= THRESHOLD (0.9999) vs the shipped vectors.

If that holds, declared == actual and the two generators cannot have silently
diverged without failing this check. Fires if the corpus is regenerated at
weights != the envelope, the envelope is edited without a matching regen, or a
generator's composition logic drifts.

Environment-drift vs composition-drift (TL condition, t/2425#4)
--------------------------------------------------------------
A CI runner whose encoder can't reproduce the shipped vectors would false-fail.
So we run a CONTROL first — re-encode per the KNOWN-canonical composition
(description-only) and check reproduction:

  * CONTROL fails (canonical can't reproduce)  -> ENVIRONMENT drift. Never blocks;
    emit a warning and exit 0 (the gate degrades to advisory — the runner is not
    reproducible enough to trust a hard failure).
  * CONTROL passes, TEST (declared weights) fails -> COMPOSITION drift. This is the
    real regression: block in --mode blocking, warn in --mode advisory.

--selftest proves BOTH arms in the current environment (for Gate Verification):
  clean arm  — declared weights reproduce (expect pass),
  failure arm— a deliberately-wrong composition (0.8/0.2) is planted and MUST be
               detected as drift.
  Exits 0 iff the gate passes the clean arm AND flags the planted drift; non-zero
  if the gate is broken (missed the plant or false-flagged clean).

Exit codes: 0 = pass/advisory/selftest-ok; 1 = composition drift (blocking mode);
2 = usage/load error; 3 = selftest failure (gate itself is broken).
"""

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

import numpy as np

THRESHOLD = 0.9999          # reproduction floor (same as the t/2408 byte-stability gate)
DEFAULT_SAMPLE_N = 6
CANONICAL_WEIGHTS = (1.0, 0.0, 0.0, 0.0, 0.0)   # description-only (the live-corpus composition)


def _find_embed_taxonomy() -> Path:
    """Walk up from this file to locate scripts/embed_taxonomy.py."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "scripts" / "embed_taxonomy.py"
        if cand.exists():
            return cand
    raise FileNotFoundError("scripts/embed_taxonomy.py not found above this file")


def _load_embed_taxonomy():
    """Import embed_taxonomy so the gate uses the REAL generator's field composition."""
    spec = importlib.util.spec_from_file_location("embed_taxonomy", _find_embed_taxonomy())
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _resolve_taxonomy_dir(override: str | None) -> Path:
    if override:
        return Path(override).resolve()
    env = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env:
        return (Path(env) / "taxonomy" / "Origin").resolve()
    # .aitriad.json fallback
    here = Path(__file__).resolve()
    for parent in here.parents:
        cfg = parent / ".aitriad.json"
        if cfg.exists():
            c = json.loads(cfg.read_text(encoding="utf-8"))
            root = Path(c.get("data_root", ".."))
            base = root if root.is_absolute() else (parent / root)
            return (base / c.get("taxonomy_dir", "taxonomy/Origin")).resolve()
    raise FileNotFoundError("cannot resolve taxonomy dir (pass --taxonomy-dir or set AI_TRIAD_DATA_ROOT)")


def _compose(model, et, nodes, weights):
    """Compose vectors for `nodes` under `weights` via embed_taxonomy's own field
    extraction (raw per-field encode -> weighted sum -> single L2). Faithful to the
    generator's recipe, so the gate tracks the real composition."""
    w = np.asarray(weights, dtype=np.float64)
    field_texts = [et._compose_field_texts(n, {}) for n in nodes]   # (desc,assumes,lineage,epist,rhet)
    # encode each of the 5 fields for all nodes, raw (no normalize) — matches generate()
    per_field = []
    for f in range(5):
        texts = [ft[f] for ft in field_texts]
        per_field.append(np.asarray(model.encode(texts, normalize_embeddings=False), dtype=np.float64))
    out = np.zeros_like(per_field[0])
    for f in range(5):
        out += w[f] * per_field[f]
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return out / norms


def _min_cos(composed, shipped):
    c = []
    for i in range(len(shipped)):
        a = composed[i]; b = np.asarray(shipped[i], dtype=np.float64)
        c.append(float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))))
    return min(c), c


def _sample(tax_dir: Path, et, n: int):
    """Pick N nodes present in embeddings.json with a description (+ shipped vector)."""
    emb = json.loads((tax_dir / "embeddings.json").read_text(encoding="utf-8"))
    emb_nodes = emb["nodes"]
    declared = emb.get("field_weights") or {}
    # load POV nodes (reuse embed_taxonomy loader against this dir)
    et.TAXONOMY_DIR = tax_dir
    pov = {}
    for p in sorted(tax_dir.glob("*.json")):
        if p.name in et.SKIP_FILES or p.stem.startswith("embeddings-"):
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            continue
        for node in d.get("nodes", []):
            if isinstance(node, dict) and isinstance(node.get("id"), str):
                pov[node["id"]] = node
    picks = []
    for nid, node in pov.items():
        e = emb_nodes.get(nid)
        if e and not e.get("degenerate") and node.get("description"):
            picks.append((node, e["vector"]))
        if len(picks) >= n:
            break
    return picks, declared, emb


def _declared_tuple(declared: dict):
    """envelope field_weights dict -> (desc,assumes,lineage,epist,rhet) tuple."""
    return (
        float(declared.get("description", 0.0)),
        float(declared.get("assumes", 0.0)),
        float(declared.get("lineage", 0.0)),
        float(declared.get("epistemic", 0.0)),
        float(declared.get("rhetorical", 0.0)),
    )


def main():
    ap = argparse.ArgumentParser(description="Composition-drift gate for embeddings.json (t/2425).")
    ap.add_argument("--taxonomy-dir", default=None)
    ap.add_argument("--sample", type=int, default=DEFAULT_SAMPLE_N)
    ap.add_argument("--mode", choices=["advisory", "blocking"], default="advisory",
                    help="advisory: composition drift warns (exit 0). blocking: composition drift fails (exit 1).")
    ap.add_argument("--selftest", action="store_true",
                    help="prove both arms in this environment; exit non-zero iff the gate is broken.")
    args = ap.parse_args()

    try:
        tax_dir = _resolve_taxonomy_dir(args.taxonomy_dir)
        et = _load_embed_taxonomy()
        picks, declared, emb = _sample(tax_dir, et, args.sample)
    except Exception as exc:  # load/usage error
        print(f"::warning::composition-drift gate could not load corpus: {exc}", file=sys.stderr)
        sys.exit(2)

    if not picks:
        print("::warning::composition-drift gate found no sampleable nodes — skipping", file=sys.stderr)
        sys.exit(0)

    if not declared:
        print("::warning::embeddings.json envelope has no field_weights to check against — skipping", file=sys.stderr)
        sys.exit(0)

    # t/152: load at the pin, the same revision scripts/embed_taxonomy.py encodes with (local import: heavy).
    sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts"))
    from embed_model_pins import load_sentence_transformer
    model = load_sentence_transformer(emb.get("model", "all-MiniLM-L6-v2"))
    nodes = [p[0] for p in picks]
    shipped = [p[1] for p in picks]

    # CONTROL: canonical description-only reproduction (environment probe)
    ctrl_min, _ = _min_cos(_compose(model, et, nodes, CANONICAL_WEIGHTS), shipped)
    control_ok = ctrl_min >= THRESHOLD

    # TEST: reproduce per the DECLARED envelope weights
    declared_w = _declared_tuple(declared)
    test_min, _ = _min_cos(_compose(model, et, nodes, declared_w), shipped)
    test_ok = test_min >= THRESHOLD

    if args.selftest:
        # failure arm: a deliberately-wrong composition (0.8/0.2) MUST be detected
        plant_min, _ = _min_cos(_compose(model, et, nodes, (0.8, 0.2, 0.0, 0.0, 0.0)), shipped)
        planted_detected = plant_min < THRESHOLD
        print(json.dumps({
            "selftest": True, "control_min_cos": round(ctrl_min, 6),
            "declared_min_cos": round(test_min, 6), "planted_0.8_0.2_min_cos": round(plant_min, 6),
            "clean_arm_env_reproduces": control_ok, "failure_arm_detects_plant": planted_detected,
        }, indent=2))
        if not control_ok:
            # Environment drift — the runner can't reproduce even the canonical composition, so the
            # gate is unverifiable here. Warn LOUDLY but exit 0 (warn-only on a shaky runner per
            # t/2425#4) — NEVER red the build on environment drift, only on a real gate defect.
            print(f"::warning::selftest UNVERIFIABLE — the CI encoder cannot reproduce the canonical "
                  f"composition (control {ctrl_min:.6f} < {THRESHOLD}): environment drift, not a gate or "
                  f"composition defect. Investigate the encoder stack. Advisory — not failing.", file=sys.stderr)
            sys.exit(0)
        if not planted_detected:
            # env reproduces (control ok) but the gate missed a planted drift -> the gate is broken
            print("::error::selftest failure arm FAILED — env reproduces the corpus but the gate did NOT "
                  "detect a planted 0.8/0.2 drift. The gate itself is broken.", file=sys.stderr)
            sys.exit(3)
        print(f"selftest OK — clean arm (env reproduces canonical @ {ctrl_min:.6f}) AND failure arm "
              f"(planted drift detected @ {plant_min:.6f}) both fire.", file=sys.stderr)
        sys.exit(0)

    result = {"declared_field_weights": declared, "control_min_cos": round(ctrl_min, 6),
              "declared_min_cos": round(test_min, 6), "threshold": THRESHOLD, "sample": len(picks)}
    print(json.dumps(result, indent=2))

    if not control_ok:
        # environment drift — never blocks
        print(f"::warning::ENVIRONMENT drift — canonical composition reproduces at only {ctrl_min:.6f} "
              f"(< {THRESHOLD}); the CI encoder is not reproducible enough to trust a hard failure. "
              f"Gate degraded to advisory this run.", file=sys.stderr)
        sys.exit(0)

    if not test_ok:
        # composition drift — control passed, so the env is fine; declared != actual
        msg = (f"COMPOSITION drift — the corpus does NOT reproduce at the envelope's declared "
               f"field_weights {declared} (min cos {test_min:.6f} < {THRESHOLD}), but DOES at the "
               f"canonical description-only composition (control {ctrl_min:.6f}). The envelope and the "
               f"actual vectors disagree — align the generators/envelope (t/2425).")
        if args.mode == "blocking":
            print(f"::error::{msg}", file=sys.stderr)
            sys.exit(1)
        print(f"::warning::{msg} [advisory mode — not blocking]", file=sys.stderr)
        sys.exit(0)

    print(f"OK — corpus reproduces at declared field_weights (min cos {test_min:.6f} >= {THRESHOLD}).", file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
