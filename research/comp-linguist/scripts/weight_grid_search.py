#!/usr/bin/env python3
"""
weight_grid_search.py — Find optimal field weights for node embeddings.

Embeds each field separately for all nodes, then tests every weight combination
against the golden test set. Reports MRR for each, sorted by performance.

Fields: description, assumes, lineage, epistemic_type, rhetorical_strategy
Current production weights: (0.8, 0.2, 0.0, 0.0, 0.0)
"""

import json
import sys
import time
from itertools import product
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = SCRIPT_DIR.parent
REPO_ROOT = RESEARCH_DIR.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from embed_model_pins import load_sentence_transformer  # noqa: E402  (t/152)

MODEL_NAME = "all-MiniLM-L6-v2"
FIELD_NAMES = ["description", "assumes", "lineage", "epistemic", "rhetorical"]


def log(msg: str):
    print(f"[grid] {msg}", file=sys.stderr)


def load_taxonomy_nodes(data_root, taxonomy_dir_rel):
    taxonomy_dir = data_root / taxonomy_dir_rel
    nodes = {}
    for pov_file in ["safetyist.json", "accelerationist.json", "skeptic.json"]:
        path = taxonomy_dir / pov_file
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        node_list = data.get("nodes", data)
        if isinstance(node_list, dict):
            node_list = list(node_list.values())
        for n in node_list:
            nid = n.get("id", "")
            if nid:
                nodes[nid] = n
    return nodes


def load_lineage_map(data_root, taxonomy_dir_rel):
    lc_path = data_root / taxonomy_dir_rel / "lineage_categories.json"
    if not lc_path.exists():
        return {}
    data = json.loads(lc_path.read_text(encoding="utf-8"))
    mapping = {}
    for cat in data.get("categories", []):
        label = cat.get("label", "Other")
        for val in cat.get("values", []):
            mapping[val] = label
    return mapping


def compose_field_texts(node, lineage_map):
    ga = node.get("graph_attributes", {}) or {}

    desc = node.get("description", "")
    label = node.get("label", "")
    desc_text = f"{label}. {desc}" if label and desc else desc or label or ""

    assumes = ga.get("assumes", []) or []
    assumes_text = ". ".join(assumes) if assumes else ""

    lineage_values = ga.get("intellectual_lineage", []) or []
    seen = set()
    cat_labels = []
    for val in lineage_values:
        if isinstance(val, dict):
            val = val.get("name", "")
        if not isinstance(val, str) or not val:
            continue
        cat_label = lineage_map.get(val, "Other")
        if cat_label not in seen:
            seen.add(cat_label)
            cat_labels.append(cat_label)
    lineage_text = ", ".join(cat_labels) if cat_labels else ""

    epistemic = ga.get("epistemic_type", "")
    epistemic_text = epistemic.replace("_", " ") if epistemic else ""

    rhetorical = ga.get("rhetorical_strategy", "")
    rhetorical_text = rhetorical.replace("_", " ") if rhetorical else ""

    return desc_text, assumes_text, lineage_text, epistemic_text, rhetorical_text


def evaluate_mrr(node_vectors, node_ids, claim_embeddings, golden, node_id_to_idx):
    rrs, top1, top5 = [], 0, 0
    for i, claim in enumerate(golden):
        target = claim["attributed_node"]
        if target not in node_id_to_idx:
            continue
        tidx = node_id_to_idx[target]
        sims = (node_vectors @ claim_embeddings[i:i+1].T).flatten()
        ranking = np.argsort(sims)[::-1]
        rank = int(np.where(ranking == tidx)[0][0]) + 1
        rrs.append(1.0 / rank)
        if rank == 1: top1 += 1
        if rank <= 5: top5 += 1
    n = len(rrs)
    return {
        "mrr": round(sum(rrs)/max(n,1), 4),
        "top1": round(top1/max(n,1), 4),
        "top5": round(top5/max(n,1), 4),
        "count": n,
    }


def main():
    aitriad_path = REPO_ROOT / ".aitriad.json"
    data_root = REPO_ROOT / ".." / "ai-triad-data"
    taxonomy_dir_rel = "taxonomy/Origin"
    if aitriad_path.exists():
        raw = json.loads(aitriad_path.read_text(encoding="utf-8"))
        if "data_root" in raw:
            data_root = (REPO_ROOT / raw["data_root"]).resolve()
        if "taxonomy_dir" in raw:
            taxonomy_dir_rel = raw["taxonomy_dir"]

    nodes = load_taxonomy_nodes(data_root, taxonomy_dir_rel)
    lineage_map = load_lineage_map(data_root, taxonomy_dir_rel)
    log(f"Loaded {len(nodes)} nodes")

    golden_data = json.loads((RESEARCH_DIR / "_golden_test_set.json").read_text(encoding="utf-8"))
    golden = golden_data.get("claims", [])
    log(f"Loaded {len(golden)} golden claims")

    log(f"Loading model {MODEL_NAME}...")
    model = load_sentence_transformer(MODEL_NAME)
    print(f"model resolved_revision={model.resolved_revision}", file=sys.stderr)

    node_ids = sorted(nodes.keys())
    node_id_to_idx = {nid: i for i, nid in enumerate(node_ids)}

    all_field_texts = []
    for nid in node_ids:
        all_field_texts.append(compose_field_texts(nodes[nid], lineage_map))

    log("Encoding fields separately...")
    field_vecs = []
    for f_idx, f_name in enumerate(FIELD_NAMES):
        texts = [ft[f_idx] if ft[f_idx] else "." for ft in all_field_texts]
        vecs = model.encode(texts, show_progress_bar=False, batch_size=256)
        field_vecs.append(vecs)
        non_empty = sum(1 for ft in all_field_texts if ft[f_idx])
        log(f"  {f_name}: {non_empty}/{len(node_ids)} non-empty")

    log("Encoding golden claims...")
    claim_texts = [c["claim_text"] for c in golden]
    claim_embs = model.encode(claim_texts, show_progress_bar=False,
                               normalize_embeddings=True, batch_size=256)

    # Grid search over weight combinations
    # Test increments of 0.1 for description and assumes (the two non-zero fields)
    # Also test adding lineage, epistemic, rhetorical
    weight_steps = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

    results = []

    # Phase 1: Exhaustive search on desc + assumes (most likely to matter)
    log("\nPhase 1: Grid search desc + assumes...")
    for w_desc in weight_steps:
        for w_assumes in weight_steps:
            if w_desc + w_assumes == 0:
                continue
            w_total = w_desc + w_assumes
            # Normalize to sum to 1
            wd = w_desc / w_total
            wa = w_assumes / w_total
            weights = (wd, wa, 0.0, 0.0, 0.0)

            combined = wd * field_vecs[0] + wa * field_vecs[1]
            norms = np.linalg.norm(combined, axis=1, keepdims=True)
            norms = np.where(norms < 1e-8, 1.0, norms)
            combined = combined / norms

            result = evaluate_mrr(combined, node_ids, claim_embs, golden, node_id_to_idx)
            result["weights"] = weights
            results.append(result)

    # Phase 2: Test adding each extra field to the best desc+assumes combo
    best_p1 = max(results, key=lambda r: r["mrr"])
    log(f"Best desc+assumes: {best_p1['weights'][:2]} -> MRR={best_p1['mrr']:.4f}")

    wd_best = best_p1["weights"][0]
    wa_best = best_p1["weights"][1]

    log("\nPhase 2: Testing additional fields on top of best desc+assumes...")
    for f_idx in range(2, 5):
        f_name = FIELD_NAMES[f_idx]
        for w_extra in [0.05, 0.1, 0.15, 0.2, 0.3]:
            scale = 1.0 - w_extra
            weights = [wd_best * scale, wa_best * scale, 0.0, 0.0, 0.0]
            weights[f_idx] = w_extra

            combined = sum(w * field_vecs[i] for i, w in enumerate(weights))
            norms = np.linalg.norm(combined, axis=1, keepdims=True)
            norms = np.where(norms < 1e-8, 1.0, norms)
            combined = combined / norms

            result = evaluate_mrr(combined, node_ids, claim_embs, golden, node_id_to_idx)
            result["weights"] = tuple(round(w, 3) for w in weights)
            results.append(result)

    # Phase 3: Test description-only with label variations
    log("\nPhase 3: Description-only variations...")
    # Raw description only (no label)
    desc_only_texts = [nodes[nid].get("description", "") or "." for nid in node_ids]
    desc_only_vecs = model.encode(desc_only_texts, show_progress_bar=False, batch_size=256)
    norms = np.linalg.norm(desc_only_vecs, axis=1, keepdims=True)
    norms = np.where(norms < 1e-8, 1.0, norms)
    desc_only_vecs = desc_only_vecs / norms
    result = evaluate_mrr(desc_only_vecs, node_ids, claim_embs, golden, node_id_to_idx)
    result["weights"] = "desc_only_no_label"
    results.append(result)

    # Sort by MRR
    results.sort(key=lambda r: r["mrr"], reverse=True)

    log("\n" + "=" * 70)
    log("TOP 20 WEIGHT COMBINATIONS")
    log("=" * 70)
    log(f"{'Rank':>4}  {'MRR':>7}  {'Top-1':>7}  {'Top-5':>7}  Weights")
    log("-" * 70)
    for i, r in enumerate(results[:20]):
        w = r["weights"]
        if isinstance(w, str):
            w_str = w
        else:
            w_str = f"d={w[0]:.2f} a={w[1]:.2f} l={w[2]:.2f} e={w[3]:.2f} r={w[4]:.2f}"
        log(f"{i+1:>4}  {r['mrr']:>7.4f}  {r['top1']:>7.4f}  {r['top5']:>7.4f}  {w_str}")

    log("\nCurrent production: d=0.80 a=0.20 l=0.00 e=0.00 r=0.00")
    prod = [r for r in results if isinstance(r["weights"], tuple)
            and abs(r["weights"][0] - 0.8) < 0.01 and abs(r["weights"][1] - 0.2) < 0.01]
    if prod:
        log(f"  MRR={prod[0]['mrr']:.4f}")

    # Save full results
    output_path = RESEARCH_DIR / "weight_grid_results.json"
    serializable = []
    for r in results:
        sr = dict(r)
        if isinstance(sr["weights"], tuple):
            sr["weights"] = list(sr["weights"])
        serializable.append(sr)
    output_path.write_text(json.dumps(serializable, indent=2), encoding="utf-8")
    log(f"\nFull results saved to {output_path}")


if __name__ == "__main__":
    main()
