#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
evaluate_embeddings.py — Evaluate embedding quality for taxonomy attribution.

Subcommands
-----------
  compare-models    Encoder ablation: compare MRR across embedding models.
  rerank-baseline   Cross-encoder reranking on top-K bi-encoder candidates.
  rerank            Live per-query cross-encoder scoring for re-ranking (stdin/stdout).

Used by Compare-EmbeddingModel, Test-RerankerBaseline, and (rerank)
Get-RelevantTaxonomyNodes -CrossEncoderRerank PowerShell cmdlets.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

_SCRIPT_DIR = Path(__file__).resolve().parent
_SKIP_FILES = {
    "embeddings.json", "edges.json", "policy_actions.json",
    "lineage_categories.json", "_archived_edges.json",
    "interpretation_embeddings.json",
}
# Maximum stdin buffer (50 MB) — mirrors embed_taxonomy.py; prevents resource
# exhaustion from piped input on the live `rerank` path.
_MAX_STDIN_BYTES = 50 * 1024 * 1024


def _sigmoid(x: float) -> float:
    """Numerically stable logistic sigmoid, 1/(1+e^-x), overflow-safe both tails."""
    if x >= 0:
        z = np.exp(-x)
        return float(1.0 / (1.0 + z))
    z = np.exp(x)
    return float(z / (1.0 + z))


def _resolve_taxonomy_dir(override=None):
    repo_root = _SCRIPT_DIR.parent
    if override:
        return Path(override).resolve()
    config_path = repo_root / ".aitriad.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
            data_root = cfg.get("data_root", ".")
            tax_dir = cfg.get("taxonomy_dir", "taxonomy/Origin")
            base = Path(data_root) if Path(data_root).is_absolute() else (repo_root / data_root)
            return (base / tax_dir).resolve()
        except (json.JSONDecodeError, OSError):
            pass
    return (repo_root / "taxonomy" / "Origin").resolve()


def _load_golden_set(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load_taxonomy_descriptions(taxonomy_dir):
    nodes = {}
    for path in sorted(Path(taxonomy_dir).glob("*.json")):
        if path.name in _SKIP_FILES:
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            continue
        for node in data.get("nodes", []):
            node_id = node.get("id", "")
            label = node.get("label", "")
            desc = node.get("description", "") or label
            nodes[node_id] = f"{label}. {desc}" if label and desc != label else desc
    return nodes


def _compute_metrics(claims, node_ids, sim_matrix):
    id_to_idx = {nid: i for i, nid in enumerate(node_ids)}
    reciprocal_ranks = []
    per_pov = {}

    for i, claim in enumerate(claims):
        target = claim["attributed_node"]
        pov = claim["pov"]
        if target not in id_to_idx:
            continue

        target_idx = id_to_idx[target]
        scores = sim_matrix[i]
        rank = int((scores > scores[target_idx]).sum()) + 1
        rr = 1.0 / rank
        reciprocal_ranks.append(rr)

        if pov not in per_pov:
            per_pov[pov] = []
        per_pov[pov].append(rank)

    n = len(reciprocal_ranks)
    all_ranks = [1.0 / rr for rr in reciprocal_ranks]

    result = {
        "total_claims": n,
        "global_mrr": round(sum(reciprocal_ranks) / n, 4) if n else 0,
        "recall_at_1": round(sum(1 for r in all_ranks if r <= 1) / n, 4) if n else 0,
        "recall_at_3": round(sum(1 for r in all_ranks if r <= 3) / n, 4) if n else 0,
        "recall_at_5": round(sum(1 for r in all_ranks if r <= 5) / n, 4) if n else 0,
        "recall_at_10": round(sum(1 for r in all_ranks if r <= 10) / n, 4) if n else 0,
        "per_pov": {},
    }

    for pov in sorted(per_pov):
        ranks = per_pov[pov]
        pn = len(ranks)
        rrs = [1.0 / r for r in ranks]
        result["per_pov"][pov] = {
            "count": pn,
            "mrr": round(sum(rrs) / pn, 4) if pn else 0,
            "recall_at_1": round(sum(1 for r in ranks if r <= 1) / pn, 4) if pn else 0,
            "recall_at_3": round(sum(1 for r in ranks if r <= 3) / pn, 4) if pn else 0,
            "recall_at_5": round(sum(1 for r in ranks if r <= 5) / pn, 4) if pn else 0,
        }

    return result


def cmd_compare_models(args):
    """Compare embedding models on golden test set MRR."""
    import embed_model_pins

    golden = _load_golden_set(args.golden_set)
    claims = golden["claims"]

    taxonomy_dir = _resolve_taxonomy_dir(args.taxonomy_dir)
    nodes = _load_taxonomy_descriptions(taxonomy_dir)

    node_ids = sorted(nodes.keys())
    node_texts = [nodes[nid] for nid in node_ids]
    claim_texts = [c["claim_text"] for c in claims]

    models = [m.strip() for m in args.models.split(",")]
    results = {
        "baseline_reference": golden.get("metadata", {}).get("baseline_metrics", {}),
        "node_count": len(node_ids),
        "claim_count": len(claims),
        "models": {},
    }

    for model_name in models:
        print(f"\n{'=' * 60}", file=sys.stderr)
        print(f"Evaluating: {model_name}", file=sys.stderr)
        print(f"{'=' * 60}", file=sys.stderr)

        t0 = time.time()
        # t/110 (TL p/37#17): evaluation compares arbitrary candidates, so an unpinned name loads with
        # a WARN; the commit actually loaded is recorded in the report for reproducibility.
        model = embed_model_pins.load_sentence_transformer(model_name, allow_unpinned=True)  # model-load:allow-unpinned evaluation report only (stdout), candidate models

        print(f"Encoding {len(node_texts)} nodes...", file=sys.stderr)
        node_vecs = model.encode(node_texts, normalize_embeddings=True, show_progress_bar=True)

        print(f"Encoding {len(claim_texts)} claims...", file=sys.stderr)
        claim_vecs = model.encode(claim_texts, normalize_embeddings=True, show_progress_bar=True)

        sim_matrix = claim_vecs @ node_vecs.T
        metrics = _compute_metrics(claims, node_ids, sim_matrix)
        elapsed = time.time() - t0

        metrics["model"] = model_name
        metrics["model_revision"] = getattr(model, "resolved_revision", None)
        metrics["dimension"] = int(node_vecs.shape[1])
        metrics["elapsed_seconds"] = round(elapsed, 1)
        results["models"][model_name] = metrics

        print(
            f"MRR: {metrics['global_mrr']:.4f}  R@1: {metrics['recall_at_1']:.4f}  "
            f"R@5: {metrics['recall_at_5']:.4f}  ({elapsed:.1f}s)",
            file=sys.stderr,
        )

    best = max(results["models"].items(), key=lambda x: x[1]["global_mrr"])
    baseline_mrr = golden.get("metadata", {}).get("baseline_metrics", {}).get("global_mrr", 0)
    results["recommendation"] = {
        "best_model": best[0],
        "best_mrr": best[1]["global_mrr"],
        "production_baseline_mrr": baseline_mrr,
        "lift_vs_production": round(best[1]["global_mrr"] - baseline_mrr, 4),
    }

    json.dump(results, sys.stdout, indent=2)


def cmd_rerank_baseline(args):
    """Evaluate cross-encoder reranking on top-K bi-encoder candidates."""
    import embed_model_pins

    golden = _load_golden_set(args.golden_set)
    claims = golden["claims"]

    taxonomy_dir = _resolve_taxonomy_dir(args.taxonomy_dir)

    embeddings_path = taxonomy_dir / "embeddings.json"
    if not embeddings_path.exists():
        print("Error: embeddings.json not found. Run embed_taxonomy.py generate first.", file=sys.stderr)
        sys.exit(1)

    emb_data = json.loads(embeddings_path.read_text(encoding="utf-8"))

    node_ids = []
    node_vecs_list = []
    for nid, entry in emb_data["nodes"].items():
        if entry.get("degenerate") or nid.startswith("pol-"):
            continue
        vec = entry.get("vector")
        if not vec:
            continue
        node_ids.append(nid)
        node_vecs_list.append(vec)

    node_vecs = np.array(node_vecs_list, dtype=np.float32)
    node_descs = _load_taxonomy_descriptions(taxonomy_dir)

    bi_model_name = emb_data.get("model", "all-MiniLM-L6-v2")
    print(f"Loading bi-encoder ({bi_model_name}) for initial retrieval...", file=sys.stderr)
    # t/110: the bi-encoder must match embeddings.json, so it's the PINNED production model.
    bi_model = embed_model_pins.load_sentence_transformer(bi_model_name)

    claim_texts = [c["claim_text"] for c in claims]
    print(f"Encoding {len(claim_texts)} claims...", file=sys.stderr)
    claim_vecs = bi_model.encode(claim_texts, normalize_embeddings=True, show_progress_bar=True)

    sim_matrix = claim_vecs @ node_vecs.T
    id_to_idx = {nid: i for i, nid in enumerate(node_ids)}
    baseline_metrics = _compute_metrics(claims, node_ids, sim_matrix)

    top_k = args.top_k
    reranker_name = args.reranker_model
    print(f"\nLoading cross-encoder: {reranker_name}...", file=sys.stderr)
    reranker = embed_model_pins.load_cross_encoder(reranker_name, allow_unpinned=True)  # model-load:allow-unpinned evaluation report only (stdout), candidate reranker

    print(f"Reranking top-{top_k} for {len(claims)} claims...", file=sys.stderr)

    reranked_rrs = []
    per_pov_ranks = {}
    batch_size = 50
    t0 = time.time()

    for batch_start in range(0, len(claims), batch_size):
        batch_end = min(batch_start + batch_size, len(claims))

        all_pairs = []
        pair_map = []

        for ci in range(batch_start, batch_end):
            claim = claims[ci]
            top_indices = np.argsort(sim_matrix[ci])[::-1][:top_k]
            candidate_ids = [node_ids[j] for j in top_indices]

            for nid in candidate_ids:
                desc = node_descs.get(nid, nid)
                all_pairs.append((claim["claim_text"], desc))
            pair_map.append((ci, candidate_ids))

        scores = reranker.predict(all_pairs) if all_pairs else np.array([])

        score_idx = 0
        for ci, candidate_ids in pair_map:
            claim = claims[ci]
            target = claim["attributed_node"]
            pov = claim["pov"]

            claim_scores = scores[score_idx : score_idx + len(candidate_ids)]
            score_idx += len(candidate_ids)

            reranked = sorted(zip(candidate_ids, claim_scores), key=lambda x: x[1], reverse=True)

            new_rank = None
            for rank, (nid, _) in enumerate(reranked, 1):
                if nid == target:
                    new_rank = rank
                    break

            if new_rank is not None:
                rr = 1.0 / new_rank
            elif target in id_to_idx:
                orig_scores = sim_matrix[ci]
                orig_rank = int((orig_scores > orig_scores[id_to_idx[target]]).sum()) + 1
                rr = 1.0 / orig_rank
            else:
                rr = 0.0

            reranked_rrs.append(rr)
            if pov not in per_pov_ranks:
                per_pov_ranks[pov] = []
            per_pov_ranks[pov].append(1.0 / rr if rr > 0 else float("inf"))

        print(f"  {batch_end}/{len(claims)} claims reranked...", file=sys.stderr)

    elapsed = time.time() - t0

    n = len(reranked_rrs)
    all_ranks = [1.0 / rr if rr > 0 else float("inf") for rr in reranked_rrs]

    reranked_metrics = {
        "total_claims": n,
        "global_mrr": round(sum(reranked_rrs) / n, 4) if n else 0,
        "recall_at_1": round(sum(1 for r in all_ranks if r <= 1) / n, 4) if n else 0,
        "recall_at_3": round(sum(1 for r in all_ranks if r <= 3) / n, 4) if n else 0,
        "recall_at_5": round(sum(1 for r in all_ranks if r <= 5) / n, 4) if n else 0,
        "recall_at_10": round(sum(1 for r in all_ranks if r <= 10) / n, 4) if n else 0,
        "per_pov": {},
    }

    for pov in sorted(per_pov_ranks):
        ranks = per_pov_ranks[pov]
        pn = len(ranks)
        rrs = [1.0 / r if r != float("inf") else 0.0 for r in ranks]
        reranked_metrics["per_pov"][pov] = {
            "count": pn,
            "mrr": round(sum(rrs) / pn, 4) if pn else 0,
            "recall_at_1": round(sum(1 for r in ranks if r <= 1) / pn, 4) if pn else 0,
            "recall_at_3": round(sum(1 for r in ranks if r <= 3) / pn, 4) if pn else 0,
            "recall_at_5": round(sum(1 for r in ranks if r <= 5) / pn, 4) if pn else 0,
        }

    output = {
        "reranker_model": reranker_name,
        "reranker_revision": getattr(reranker, "resolved_revision", None),   # t/110
        "bi_encoder_model": bi_model_name,
        "bi_encoder_revision": getattr(bi_model, "resolved_revision", None),
        "top_k": top_k,
        "elapsed_seconds": round(elapsed, 1),
        "baseline_biencoder": baseline_metrics,
        "reranked": reranked_metrics,
        "lift": {
            "mrr_delta": round(reranked_metrics["global_mrr"] - baseline_metrics["global_mrr"], 4),
            "recall_at_1_delta": round(reranked_metrics["recall_at_1"] - baseline_metrics["recall_at_1"], 4),
            "recall_at_5_delta": round(reranked_metrics["recall_at_5"] - baseline_metrics["recall_at_5"], 4),
        },
    }

    print(f"\nBaseline MRR: {baseline_metrics['global_mrr']:.4f}", file=sys.stderr)
    print(f"Reranked MRR: {reranked_metrics['global_mrr']:.4f}", file=sys.stderr)
    print(f"Lift: {output['lift']['mrr_delta']:+.4f} ({elapsed:.1f}s)", file=sys.stderr)

    json.dump(output, sys.stdout, indent=2)


def cmd_rerank(args):
    """Score (query, candidate) pairs with a cross-encoder for live re-ranking.

    Reads a single JSON object from stdin:
        {"query": "...",
         "candidates": [{"id": "acc-beliefs-001", "text": "Label. Description"}, ...],
         "reranker_model": "cross-encoder/ms-marco-MiniLM-L6-v2"}   # optional

    Writes a JSON array to stdout, sorted by score descending:
        [{"id": "...", "score": <sigmoid(logit) 0-1>, "raw": <logit>}, ...]

    `score` is sigmoid(logit): a stable, per-pair, set-independent 0-1 display
    scale (endorsed over min-max, which is set-dependent — its top is ~1.0 even
    when every candidate is poor, killing the low-confidence signal; t/2287#5).
    It is a DISPLAY scale, NOT a probability; a confidence gate on this scale
    needs its own calibration — the bi-encoder 0.45 threshold is invalid here.
    `raw` is the underlying logit, retained for diagnostics. Only JSON goes to
    stdout; all progress/diagnostic logging goes to stderr.
    """
    raw = sys.stdin.read(_MAX_STDIN_BYTES)
    payload = json.loads(raw) if raw.strip() else {}
    query = payload.get("query", "")
    candidates = payload.get("candidates", []) or []
    if not query or not candidates:
        json.dump([], sys.stdout)
        return

    import embed_model_pins

    model_name = payload.get("reranker_model") or args.reranker_model
    print(f"Loading cross-encoder: {model_name}...", file=sys.stderr)
    # t/110 (TL p/37#19): a LIVE production path (Get-RelevantTaxonomyNodes -CrossEncoderRerank), so the
    # reranker must be PINNED; an unpinned model raises the ActionableError, and the opt-in caller
    # degrades to bi-encoder order on any rerank error.
    reranker = embed_model_pins.load_cross_encoder(model_name)

    pairs = [(query, c.get("text", "")) for c in candidates]
    print(f"Scoring {len(pairs)} (query, candidate) pairs...", file=sys.stderr)
    logits = reranker.predict(pairs)

    results = []
    for c, logit in zip(candidates, logits):
        lf = float(logit)
        results.append({
            "id": c.get("id", ""),
            "score": round(_sigmoid(lf), 6),
            "raw": round(lf, 6),
        })
    results.sort(key=lambda r: r["score"], reverse=True)
    json.dump(results, sys.stdout)


def main():
    parser = argparse.ArgumentParser(description="Evaluate embedding quality for taxonomy attribution.")
    sub = parser.add_subparsers(dest="command", required=True)

    cm = sub.add_parser("compare-models", help="Encoder ablation: compare MRR across models")
    cm.add_argument("--golden-set", required=True, help="Path to golden test set JSON")
    cm.add_argument("--taxonomy-dir", default=None, help="Override taxonomy directory")
    cm.add_argument(
        "--models",
        default="all-MiniLM-L6-v2,all-mpnet-base-v2,BAAI/bge-base-en-v1.5",
        help="Comma-separated model names (default: MiniLM, mpnet, BGE)",
    )

    rb = sub.add_parser("rerank-baseline", help="Cross-encoder reranking evaluation")
    rb.add_argument("--golden-set", required=True, help="Path to golden test set JSON")
    rb.add_argument("--taxonomy-dir", default=None, help="Override taxonomy directory")
    rb.add_argument("--top-k", type=int, default=10, help="Top-K candidates to rerank (default: 10)")
    rb.add_argument(
        "--reranker-model",
        default="cross-encoder/ms-marco-MiniLM-L6-v2",
        help="Cross-encoder model for reranking",
    )

    rr = sub.add_parser(
        "rerank",
        help="Live per-query cross-encoder scoring (stdin JSON {query, candidates[]} -> [{id, score, raw}])",
    )
    rr.add_argument(
        "--reranker-model",
        default="cross-encoder/ms-marco-MiniLM-L6-v2",
        help="Cross-encoder model (stdin 'reranker_model' overrides this)",
    )

    args = parser.parse_args()
    if args.command == "compare-models":
        cmd_compare_models(args)
    elif args.command == "rerank-baseline":
        cmd_rerank_baseline(args)
    elif args.command == "rerank":
        cmd_rerank(args)


if __name__ == "__main__":
    main()
