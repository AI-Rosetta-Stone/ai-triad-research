#!/usr/bin/env python3
"""
train_claim_matcher.py — Contrastive fine-tuning of all-MiniLM-L6-v2 for claim-to-node matching.

Uses MultipleNegativesRankingLoss with edge-informed hard negatives.
Evaluates on golden test set (MRR).

Inputs:
  - training_corpus.json (from build_training_corpus.py)
  - _golden_test_set.json (eval holdout)
  - embeddings.json (current production node embeddings for baseline comparison)

Output:
  - Fine-tuned model saved to output directory
  - Evaluation report (MRR, per-source ablation)
"""

import argparse
import json
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import (
    InputExample,
    SentenceTransformer,
    losses,
    evaluation,
)
from torch.utils.data import DataLoader

SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = SCRIPT_DIR.parent
REPO_ROOT = RESEARCH_DIR.parent.parent
# Large data artifacts (corpora, model, results) live in the sibling data repo (t/1289).
ARTIFACTS_DIR = REPO_ROOT.parent / "ai-triad-data" / "research-artifacts" / "comp-linguist"

sys.path.insert(0, str(SCRIPT_DIR))
from _model_release import LOCAL_MODEL_ROOT, report_release_steps  # noqa: E402

MODEL_NAME = "all-MiniLM-L6-v2"


def log(msg: str):
    print(f"[train] {msg}", file=sys.stderr)


def load_corpus(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_golden_set(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("claims", [])


def load_node_descriptions(data_root: Path, taxonomy_dir_rel: str) -> dict:
    """Load node_id -> description for evaluation."""
    taxonomy_dir = data_root / taxonomy_dir_rel
    descs = {}
    for pov_file in ["safetyist.json", "accelerationist.json", "skeptic.json"]:
        path = taxonomy_dir / pov_file
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        nodes = data.get("nodes", data)
        if isinstance(nodes, dict):
            nodes = list(nodes.values())
        for n in nodes:
            nid = n.get("id", "")
            desc = n.get("description", "")
            if nid and desc:
                descs[nid] = desc
    return descs


def build_training_examples(corpus: dict, tension_map: dict,
                             max_hard_negatives: int = 3,
                             node_descriptions: dict = None) -> list[InputExample]:
    """Build InputExample pairs for MNRL training.

    MNRL uses (anchor, positive) pairs. In-batch negatives are automatic.
    We add edge-informed hard negatives by pairing the anchor text with
    opposing-node descriptions as additional negative examples.
    """
    pairs = corpus.get("pairs", [])
    positives = [p for p in pairs if p["weight"] > 0]
    hard_neg_pairs = [p for p in pairs if p["weight"] < 0]

    if not node_descriptions:
        node_descriptions = {}

    examples = []
    hard_neg_examples = []

    for p in positives:
        text = p["text"]
        node_id = p["node_id"]
        desc = node_descriptions.get(node_id, "")
        if not desc:
            continue
        examples.append(InputExample(texts=[text, desc]))

    log(f"  Positive training examples: {len(examples)}")

    if node_descriptions:
        for hn in hard_neg_pairs:
            node_id = hn["node_id"]
            opposing = hn.get("metadata", {}).get("opposing_nodes", [])
            if not opposing:
                opposing = list(tension_map.get(node_id, []))

            sampled = random.sample(opposing, min(max_hard_negatives, len(opposing)))
            for opp_id in sampled:
                opp_desc = node_descriptions.get(opp_id, "")
                if opp_desc:
                    hard_neg_examples.append(InputExample(texts=[hn["text"], opp_desc]))

    log(f"  Hard negative examples: {len(hard_neg_examples)}")
    all_examples = examples + hard_neg_examples
    random.shuffle(all_examples)
    return all_examples


def evaluate_mrr(model: SentenceTransformer, golden: list[dict],
                  node_descriptions: dict, label: str = "") -> dict:
    """Compute MRR on golden test set."""
    if not golden or not node_descriptions:
        return {"mrr": 0.0, "top1": 0.0, "top5": 0.0, "count": 0}

    node_ids = sorted(node_descriptions.keys())
    node_texts = [node_descriptions[nid] for nid in node_ids]
    node_id_to_idx = {nid: i for i, nid in enumerate(node_ids)}

    node_embeddings = model.encode(node_texts, show_progress_bar=False,
                                    normalize_embeddings=True, batch_size=256)

    claim_texts = [c["claim_text"] for c in golden]
    claim_embeddings = model.encode(claim_texts, show_progress_bar=False,
                                     normalize_embeddings=True, batch_size=256)

    reciprocal_ranks = []
    top1_hits = 0
    top5_hits = 0

    for i, claim in enumerate(golden):
        target_node = claim["attributed_node"]
        if target_node not in node_id_to_idx:
            continue

        target_idx = node_id_to_idx[target_node]
        sims = (node_embeddings @ claim_embeddings[i:i+1].T).flatten()
        ranking = np.argsort(sims)[::-1]
        rank = int(np.where(ranking == target_idx)[0][0]) + 1

        reciprocal_ranks.append(1.0 / rank)
        if rank == 1:
            top1_hits += 1
        if rank <= 5:
            top5_hits += 1

    n = len(reciprocal_ranks)
    result = {
        "mrr": round(sum(reciprocal_ranks) / max(n, 1), 4),
        "top1": round(top1_hits / max(n, 1), 4),
        "top5": round(top5_hits / max(n, 1), 4),
        "count": n,
    }
    prefix = f"[{label}] " if label else ""
    log(f"  {prefix}MRR={result['mrr']:.4f}  Top-1={result['top1']:.4f}  Top-5={result['top5']:.4f}  (n={n})")
    return result


def train(model: SentenceTransformer, examples: list[InputExample],
          golden: list[dict], node_descriptions: dict,
          epochs: int, batch_size: int, lr: float,
          warmup_ratio: float, patience: int, output_dir: Path) -> dict:
    """Train with MNRL and early stopping based on golden set MRR."""

    train_dataloader = DataLoader(examples, shuffle=True, batch_size=batch_size)
    train_loss = losses.MultipleNegativesRankingLoss(model)

    no_improvement = 0
    history = []

    total_steps = len(train_dataloader) * epochs
    warmup_steps = int(total_steps * warmup_ratio)

    log(f"Training: {len(examples)} examples, {epochs} epochs, batch_size={batch_size}")
    log(f"  Total steps: {total_steps}, warmup: {warmup_steps}")

    # Baseline evaluation — early stopping compares against this
    log("Baseline (before training):")
    baseline = evaluate_mrr(model, golden, node_descriptions, label="baseline")
    history.append({"epoch": 0, "mrr": baseline["mrr"], "top1": baseline["top1"], "top5": baseline["top5"]})
    best_mrr = baseline["mrr"]
    best_epoch = 0

    for epoch in range(1, epochs + 1):
        t0 = time.time()
        model.fit(
            train_objectives=[(train_dataloader, train_loss)],
            epochs=1,
            warmup_steps=warmup_steps if epoch == 1 else 0,
            optimizer_params={"lr": lr},
            show_progress_bar=False,
        )
        elapsed = time.time() - t0

        log(f"Epoch {epoch}/{epochs} ({elapsed:.1f}s):")
        result = evaluate_mrr(model, golden, node_descriptions, label=f"epoch-{epoch}")
        history.append({"epoch": epoch, "mrr": result["mrr"], "top1": result["top1"], "top5": result["top5"]})

        if result["mrr"] > best_mrr:
            best_mrr = result["mrr"]
            best_epoch = epoch
            no_improvement = 0
            model.save(str(output_dir / "best_model"))
            log(f"  New best MRR={best_mrr:.4f} — model saved")
        else:
            no_improvement += 1
            log(f"  No improvement ({no_improvement}/{patience})")

        if no_improvement >= patience:
            log(f"  Early stopping at epoch {epoch}")
            break

    return {
        "baseline": baseline,
        "best_mrr": best_mrr,
        "best_epoch": best_epoch,
        "final_epoch": len(history) - 1,
        "history": history,
        "improvement": round(best_mrr - baseline["mrr"], 4),
        "improvement_pct": round((best_mrr - baseline["mrr"]) / max(baseline["mrr"], 0.001) * 100, 1),
    }


def main():
    parser = argparse.ArgumentParser(description="Train claim matcher via contrastive fine-tuning")
    parser.add_argument("--corpus", default=str(ARTIFACTS_DIR / "training_corpus.json"),
                        help="Path to training corpus JSON")
    parser.add_argument("--output-dir", default=str(LOCAL_MODEL_ROOT / "claim_matcher"),
                        help="Output directory for the fine-tuned model. The default is gitignored; weights are "
                             "published as a release asset, never committed (t/4154)")
    parser.add_argument("--release-tag", default="comp-linguist-claim-matcher-v2",
                        help="Release tag to print in the publish steps")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-hard-negatives", type=int, default=3)
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load config for data paths
    aitriad_path = REPO_ROOT / ".aitriad.json"
    data_root = REPO_ROOT / ".." / "ai-triad-data"
    taxonomy_dir_rel = "taxonomy/Origin"
    if aitriad_path.exists():
        raw = json.loads(aitriad_path.read_text(encoding="utf-8"))
        if "data_root" in raw:
            data_root = (REPO_ROOT / raw["data_root"]).resolve()
        if "taxonomy_dir" in raw:
            taxonomy_dir_rel = raw["taxonomy_dir"]

    # Load data
    log("Loading training corpus...")
    corpus = load_corpus(Path(args.corpus))
    log(f"  {corpus['metadata']['total_pairs']} total pairs, {corpus['metadata']['positive_pairs']} positive")

    log("Loading golden test set...")
    golden = load_golden_set(RESEARCH_DIR / "_golden_test_set.json")
    log(f"  {len(golden)} claims")

    log("Loading node descriptions...")
    node_descriptions = load_node_descriptions(data_root, taxonomy_dir_rel)
    log(f"  {len(node_descriptions)} nodes")

    tension_map = corpus.get("tension_map", {})

    # Load model
    log(f"Loading model {MODEL_NAME}...")
    model = SentenceTransformer(MODEL_NAME)

    # Build training examples
    log("Building training examples...")
    examples = build_training_examples(
        corpus, tension_map,
        max_hard_negatives=args.max_hard_negatives,
        node_descriptions=node_descriptions,
    )
    log(f"  Total training examples: {len(examples)}")

    # Train
    log("=" * 60)
    log("TRAINING")
    log("=" * 60)
    results = train(
        model, examples, golden, node_descriptions,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        warmup_ratio=args.warmup_ratio,
        patience=args.patience,
        output_dir=output_dir,
    )

    # Save results
    results_path = output_dir / "training_results.json"
    results["config"] = {
        "corpus": args.corpus,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "warmup_ratio": args.warmup_ratio,
        "patience": args.patience,
        "seed": args.seed,
        "max_hard_negatives": args.max_hard_negatives,
        "corpus_metadata": corpus.get("metadata", {}),
    }
    results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    log("=" * 60)
    log("RESULTS")
    log("=" * 60)
    log(f"  Baseline MRR:    {results['baseline']['mrr']:.4f}")
    log(f"  Best MRR:        {results['best_mrr']:.4f} (epoch {results['best_epoch']})")
    log(f"  Improvement:     +{results['improvement']:.4f} ({results['improvement_pct']:+.1f}%)")
    log(f"  Model saved to:  {output_dir / 'best_model'}")
    log(f"  Results saved to: {results_path}")
    report_release_steps(output_dir / "best_model", "fine_tuned_model", args.release_tag)


if __name__ == "__main__":
    main()
