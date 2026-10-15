#!/usr/bin/env python3
"""
train_cross_encoder.py — Train a cross-encoder reranker for claim-to-node matching.

Uses the base bi-encoder (all-MiniLM-L6-v2) for initial retrieval (top-K candidates),
then a cross-encoder for reranking. Avoids catastrophic forgetting since the
bi-encoder is never modified.

Cross-encoders process (claim, description) pairs through a single BERT pass,
producing a relevance score. More accurate than bi-encoders but slower (O(n) per query
vs O(1) after index build).

Inputs:
  - training_corpus.json (or filtered variant)
  - _golden_test_set.json (eval holdout)

Output:
  - Fine-tuned cross-encoder model
  - Evaluation report (MRR with reranking vs baseline)
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from sentence_transformers.cross_encoder import CrossEncoder
from sentence_transformers.cross_encoder.evaluation import CERerankingEvaluator

SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = SCRIPT_DIR.parent
REPO_ROOT = RESEARCH_DIR.parent.parent
# Large data artifacts (corpora, model, results) live in the sibling data repo (t/1289).
ARTIFACTS_DIR = REPO_ROOT.parent / "ai-triad-data" / "research-artifacts" / "comp-linguist"

sys.path.insert(0, str(SCRIPT_DIR))
from _model_release import LOCAL_MODEL_ROOT, report_release_steps  # noqa: E402

BI_ENCODER_MODEL = "all-MiniLM-L6-v2"
CROSS_ENCODER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


def log(msg: str):
    print(f"[xenc] {msg}", file=sys.stderr)


def load_node_descriptions(data_root: Path, taxonomy_dir_rel: str) -> dict:
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


def evaluate_biencoder_mrr(bi_model, golden, node_descriptions, label=""):
    """Baseline MRR using bi-encoder only."""
    if not golden or not node_descriptions:
        return {"mrr": 0.0, "top1": 0.0, "top5": 0.0, "count": 0}

    node_ids = sorted(node_descriptions.keys())
    node_texts = [node_descriptions[nid] for nid in node_ids]
    node_id_to_idx = {nid: i for i, nid in enumerate(node_ids)}

    node_embs = bi_model.encode(node_texts, show_progress_bar=False,
                                 normalize_embeddings=True, batch_size=256)
    claim_texts = [c["claim_text"] for c in golden]
    claim_embs = bi_model.encode(claim_texts, show_progress_bar=False,
                                  normalize_embeddings=True, batch_size=256)

    rrs, top1, top5 = [], 0, 0
    for i, claim in enumerate(golden):
        target = claim["attributed_node"]
        if target not in node_id_to_idx:
            continue
        tidx = node_id_to_idx[target]
        sims = (node_embs @ claim_embs[i:i+1].T).flatten()
        ranking = np.argsort(sims)[::-1]
        rank = int(np.where(ranking == tidx)[0][0]) + 1
        rrs.append(1.0 / rank)
        if rank == 1: top1 += 1
        if rank <= 5: top5 += 1

    n = len(rrs)
    result = {"mrr": round(sum(rrs)/max(n,1), 4), "top1": round(top1/max(n,1), 4),
              "top5": round(top5/max(n,1), 4), "count": n}
    prefix = f"[{label}] " if label else ""
    log(f"  {prefix}MRR={result['mrr']:.4f}  Top-1={result['top1']:.4f}  Top-5={result['top5']:.4f}  (n={n})")
    return result


def evaluate_reranked_mrr(bi_model, cross_model, golden, node_descriptions,
                           top_k=20, label=""):
    """MRR with bi-encoder retrieval + cross-encoder reranking."""
    if not golden or not node_descriptions:
        return {"mrr": 0.0, "top1": 0.0, "top5": 0.0, "count": 0}

    node_ids = sorted(node_descriptions.keys())
    node_texts = [node_descriptions[nid] for nid in node_ids]
    node_id_to_idx = {nid: i for i, nid in enumerate(node_ids)}

    node_embs = bi_model.encode(node_texts, show_progress_bar=False,
                                 normalize_embeddings=True, batch_size=256)
    claim_texts = [c["claim_text"] for c in golden]
    claim_embs = bi_model.encode(claim_texts, show_progress_bar=False,
                                  normalize_embeddings=True, batch_size=256)

    rrs, top1, top5 = [], 0, 0
    for i, claim in enumerate(golden):
        target = claim["attributed_node"]
        if target not in node_id_to_idx:
            continue
        tidx = node_id_to_idx[target]

        sims = (node_embs @ claim_embs[i:i+1].T).flatten()
        top_k_indices = np.argsort(sims)[::-1][:top_k]

        pairs = [(claim_texts[i], node_texts[idx]) for idx in top_k_indices]
        ce_scores = cross_model.predict(pairs, show_progress_bar=False)

        reranked = top_k_indices[np.argsort(ce_scores)[::-1]]

        if tidx in reranked:
            rank = int(np.where(reranked == tidx)[0][0]) + 1
        else:
            rank = top_k + 1

        rrs.append(1.0 / rank)
        if rank == 1: top1 += 1
        if rank <= 5: top5 += 1

    n = len(rrs)
    result = {"mrr": round(sum(rrs)/max(n,1), 4), "top1": round(top1/max(n,1), 4),
              "top5": round(top5/max(n,1), 4), "count": n, "top_k": top_k}
    prefix = f"[{label}] " if label else ""
    log(f"  {prefix}MRR={result['mrr']:.4f}  Top-1={result['top1']:.4f}  Top-5={result['top5']:.4f}  (n={n}, top_k={top_k})")
    return result


def build_cross_encoder_examples(corpus, node_descriptions, neg_per_pos=3):
    """Build training examples for cross-encoder: (query, positive, [negatives])."""
    pairs = corpus.get("pairs", [])
    positives = [p for p in pairs if p["weight"] > 0]

    node_ids = sorted(node_descriptions.keys())
    examples = []

    for p in positives:
        text = p["text"]
        node_id = p["node_id"]
        pos_desc = node_descriptions.get(node_id, "")
        if not pos_desc:
            continue

        neg_ids = random.sample(node_ids, min(neg_per_pos + 1, len(node_ids)))
        neg_ids = [nid for nid in neg_ids if nid != node_id][:neg_per_pos]
        neg_descs = [node_descriptions[nid] for nid in neg_ids if nid in node_descriptions]

        if neg_descs:
            examples.append({
                "query": text,
                "positive": [pos_desc],
                "negative": neg_descs,
            })

    random.shuffle(examples)
    return examples


def main():
    parser = argparse.ArgumentParser(description="Train cross-encoder reranker for claim matching")
    parser.add_argument("--corpus", default=str(ARTIFACTS_DIR / "training_corpus.json"))
    parser.add_argument("--output-dir", default=str(LOCAL_MODEL_ROOT / "cross_encoder"),
                        help="Output directory for the model. The default is gitignored; weights are published "
                             "as a release asset, never committed (t/4154)")
    parser.add_argument("--release-tag", default="comp-linguist-cross-encoder-v1",
                        help="Release tag to print in the publish steps")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--top-k", type=int, default=20,
                        help="Top-K candidates from bi-encoder for reranking")
    parser.add_argument("--neg-per-pos", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--eval-only", action="store_true",
                        help="Just evaluate pretrained cross-encoder, no training")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    aitriad_path = REPO_ROOT / ".aitriad.json"
    data_root = REPO_ROOT / ".." / "ai-triad-data"
    taxonomy_dir_rel = "taxonomy/Origin"
    if aitriad_path.exists():
        raw = json.loads(aitriad_path.read_text(encoding="utf-8"))
        if "data_root" in raw:
            data_root = (REPO_ROOT / raw["data_root"]).resolve()
        if "taxonomy_dir" in raw:
            taxonomy_dir_rel = raw["taxonomy_dir"]

    log("Loading node descriptions...")
    node_descriptions = load_node_descriptions(data_root, taxonomy_dir_rel)
    log(f"  {len(node_descriptions)} nodes")

    log("Loading golden test set...")
    golden_data = json.loads((RESEARCH_DIR / "_golden_test_set.json").read_text(encoding="utf-8"))
    golden = golden_data.get("claims", [])
    log(f"  {len(golden)} claims")

    log(f"Loading bi-encoder ({BI_ENCODER_MODEL})...")
    bi_model = SentenceTransformer(BI_ENCODER_MODEL)

    log(f"Loading cross-encoder ({CROSS_ENCODER_MODEL})...")
    cross_model = CrossEncoder(CROSS_ENCODER_MODEL)

    log("=" * 60)
    log("BASELINE EVALUATION")
    log("=" * 60)

    log("Bi-encoder only:")
    bi_baseline = evaluate_biencoder_mrr(bi_model, golden, node_descriptions, label="bi-encoder")

    log("Pretrained cross-encoder reranking:")
    for k in [10, 20, 50]:
        evaluate_reranked_mrr(bi_model, cross_model, golden, node_descriptions,
                              top_k=k, label=f"pretrained-top{k}")

    if args.eval_only:
        log("Eval-only mode — done.")
        return

    log("\n" + "=" * 60)
    log("TRAINING CROSS-ENCODER")
    log("=" * 60)

    log("Loading training corpus...")
    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    log(f"  {corpus['metadata']['total_pairs']} pairs")

    log("Building cross-encoder training examples...")
    train_examples = build_cross_encoder_examples(corpus, node_descriptions, args.neg_per_pos)
    log(f"  {len(train_examples)} training examples")

    train_samples = []
    for ex in train_examples:
        from sentence_transformers.cross_encoder import InputExample as CEInputExample
        for pos in ex["positive"]:
            train_samples.append(CEInputExample(texts=[ex["query"], pos], label=1.0))
        for neg in ex["negative"]:
            train_samples.append(CEInputExample(texts=[ex["query"], neg], label=0.0))

    log(f"  {len(train_samples)} total (query, doc, label) triples")

    from torch.utils.data import DataLoader
    train_dataloader = DataLoader(train_samples, shuffle=True, batch_size=args.batch_size)

    total_steps = len(train_dataloader) * args.epochs
    warmup_steps = int(total_steps * args.warmup_ratio)

    log(f"Training: {args.epochs} epochs, batch_size={args.batch_size}")
    log(f"  Total steps: {total_steps}, warmup: {warmup_steps}")

    cross_model.fit(
        train_dataloader=train_dataloader,
        epochs=args.epochs,
        warmup_steps=warmup_steps,
        optimizer_params={"lr": args.lr},
        output_path=str(output_dir / "best_model"),
        show_progress_bar=False,
    )

    log("\n" + "=" * 60)
    log("POST-TRAINING EVALUATION")
    log("=" * 60)

    trained_cross = CrossEncoder(str(output_dir / "best_model"))
    for k in [10, 20, 50]:
        evaluate_reranked_mrr(bi_model, trained_cross, golden, node_descriptions,
                              top_k=k, label=f"trained-top{k}")

    report_release_steps(output_dir / "best_model", "cross_encoder_model", args.release_tag)
    log("Done.")


if __name__ == "__main__":
    main()
