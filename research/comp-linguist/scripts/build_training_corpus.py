#!/usr/bin/env python3
"""
build_training_corpus.py — Extract multi-form training pairs for contrastive fine-tuning.

Phases:
  1. Real passages from source document snapshots (via evidence index lookup)
  2. LLM facts from source_evidence_index.json
  3. POV key_points from summary JSON files
  4. Factual claims from summary JSON files
  5. Node attributes (assumes, policy_actions)
  6. Edge-augmented pairs (soft positives via SUPPORTS, hard negatives via TENSION_WITH/CONTRADICTS)
  7. Steelman vulnerabilities as hard negatives

Output: training_corpus.json with provenance metadata per pair.
"""

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Optional

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = SCRIPT_DIR.parent
REPO_ROOT = RESEARCH_DIR.parent.parent
# Large data artifacts (corpora, model, results) live in the sibling data repo (t/1289).
ARTIFACTS_DIR = REPO_ROOT.parent / "ai-triad-data" / "research-artifacts" / "comp-linguist"

DEFAULT_CONFIG = {
    "data_root": REPO_ROOT / ".." / "ai-triad-data",
    "sources_root": REPO_ROOT / ".." / "ai-triad-sources",
    "taxonomy_dir": "taxonomy/Origin",
    "model_name": "all-MiniLM-L6-v2",
    "passage_similarity_threshold": 0.35,
    "passage_top_k": 3,
    "edge_confidence_threshold": 0.7,
    "soft_positive_decay": 0.5,
    "soft_positive_min_weight": 0.3,
}


def load_config():
    """Load paths from .aitriad.json if available."""
    config = dict(DEFAULT_CONFIG)
    aitriad_path = REPO_ROOT / ".aitriad.json"
    if aitriad_path.exists():
        raw = json.loads(aitriad_path.read_text(encoding="utf-8"))
        if "data_root" in raw:
            config["data_root"] = (REPO_ROOT / raw["data_root"]).resolve()
        if "sources_root" in raw:
            config["sources_root"] = (REPO_ROOT / raw["sources_root"]).resolve()
        if "taxonomy_dir" in raw:
            config["taxonomy_dir"] = raw["taxonomy_dir"]
    env_data = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env_data:
        config["data_root"] = Path(env_data)
    env_src = os.environ.get("AI_TRIAD_SOURCES_ROOT")
    if env_src:
        config["sources_root"] = Path(env_src)
    return config


def log(msg: str):
    print(f"[corpus] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------

def load_taxonomy_nodes(taxonomy_dir: Path) -> dict:
    """Load all POV nodes into a dict keyed by node_id."""
    nodes = {}
    for pov_file in ["safetyist.json", "accelerationist.json", "skeptic.json"]:
        path = taxonomy_dir / pov_file
        if not path.exists():
            log(f"WARNING: {path} not found")
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        node_list = data.get("nodes", data)
        if isinstance(node_list, dict):
            node_list = list(node_list.values())
        for n in node_list:
            nid = n.get("id", "")
            if nid:
                n["_pov_file"] = pov_file
                nodes[nid] = n
    return nodes


def load_source_evidence(data_root: Path) -> dict:
    path = data_root / "taxonomy" / "source_evidence_index.json"
    if not path.exists():
        log(f"WARNING: {path} not found")
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_edges(taxonomy_dir: Path) -> list:
    path = taxonomy_dir / "edges.json"
    if not path.exists():
        log(f"WARNING: {path} not found")
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("edges", [])


def load_summaries(data_root: Path) -> list:
    summaries_dir = data_root / "summaries"
    if not summaries_dir.exists():
        log(f"WARNING: {summaries_dir} not found")
        return []
    results = []
    for f in summaries_dir.iterdir():
        if f.suffix != ".json":
            continue
        try:
            results.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            continue
    return results


# Inline data: URIs (base64 images) are stripped before paragraphs are split, so base64 can't
# become a training passage (t/4385). Same two patterns as Remove-MarkdownDataUri.ps1: markdown
# data: images first, then bare data:...;base64,... runs. The payload class has no whitespace,
# so a bare URI stops at the first space and never swallows the prose after it.
_DATA_URI_IMAGE = re.compile(r"!\[[^\]]*\]\(\s*data:[^)]*\)")
_DATA_URI_BARE = re.compile(r"data:[A-Za-z0-9.+/-]+(?:;[A-Za-z0-9=.+-]+)*;base64,[A-Za-z0-9+/=]+")


def strip_data_uris(text: str) -> tuple[str, int]:
    """Remove inline data: URIs; return (text, chars removed)."""
    out = _DATA_URI_BARE.sub("", _DATA_URI_IMAGE.sub("", text))
    return out, len(text) - len(out)


def load_snapshot(sources_root: Path, doc_id: str) -> Optional[str]:
    snap_path = sources_root / doc_id / "snapshot.md"
    if not snap_path.exists():
        return None
    text, stripped = strip_data_uris(snap_path.read_text(encoding="utf-8", errors="replace"))
    if stripped:
        log(f"WARN: stripped {stripped} chars of inline data: URIs from {doc_id}/snapshot.md (t/4385)")
    return text


# ---------------------------------------------------------------------------
# Passage extraction
# ---------------------------------------------------------------------------

def split_paragraphs(markdown_text: str) -> list[str]:
    """Split markdown into paragraphs, filtering out metadata and short fragments."""
    lines = markdown_text.split("\n")
    paragraphs = []
    current = []

    for line in lines:
        stripped = line.strip()
        if stripped == "":
            if current:
                para = " ".join(current).strip()
                if len(para) >= 60:
                    paragraphs.append(para)
                current = []
        elif stripped.startswith("<!--") or stripped.startswith(">"):
            continue
        elif stripped.startswith("---"):
            continue
        else:
            current.append(stripped)

    if current:
        para = " ".join(current).strip()
        if len(para) >= 60:
            paragraphs.append(para)

    return paragraphs


def extract_passages(model, sources_root: Path, evidence_index: dict,
                     threshold: float, top_k: int) -> list[dict]:
    """Extract real passages from source documents using semantic search."""
    pairs = []
    doc_cache = {}
    para_embed_cache = {}

    all_lookups = []
    for node_id, node_data in evidence_index.items():
        for fact in node_data.get("facts", []):
            doc_id = fact.get("doc_id", "")
            claim = fact.get("claim", "")
            if doc_id and claim:
                all_lookups.append((node_id, doc_id, claim))

    log(f"Phase 1: Extracting passages for {len(all_lookups)} (node, doc, claim) triples...")

    batch_claims = [t[2] for t in all_lookups]
    if not batch_claims:
        return pairs

    log(f"  Encoding {len(batch_claims)} claim queries...")
    claim_embeddings = model.encode(batch_claims, show_progress_bar=False,
                                     normalize_embeddings=True, batch_size=256)

    processed_docs = 0
    for idx, (node_id, doc_id, claim) in enumerate(all_lookups):
        if doc_id not in doc_cache:
            text = load_snapshot(sources_root, doc_id)
            if text is None:
                doc_cache[doc_id] = None
                para_embed_cache[doc_id] = None
            else:
                paras = split_paragraphs(text)
                doc_cache[doc_id] = paras
                if paras:
                    para_embed_cache[doc_id] = model.encode(
                        paras, show_progress_bar=False,
                        normalize_embeddings=True, batch_size=256
                    )
                else:
                    para_embed_cache[doc_id] = None
                processed_docs += 1
                if processed_docs % 50 == 0:
                    log(f"  Processed {processed_docs} documents...")

        paras = doc_cache.get(doc_id)
        para_embeds = para_embed_cache.get(doc_id)
        if paras is None or para_embeds is None:
            continue

        query_vec = claim_embeddings[idx:idx+1]
        sims = (para_embeds @ query_vec.T).flatten()
        top_indices = np.argsort(sims)[::-1][:top_k]

        for rank, pi in enumerate(top_indices):
            sim = float(sims[pi])
            if sim >= threshold:
                pairs.append({
                    "text": paras[pi],
                    "node_id": node_id,
                    "source": "snapshot_passage",
                    "weight": 1.0,
                    "metadata": {
                        "doc_id": doc_id,
                        "similarity": round(sim, 4),
                        "rank": rank,
                    }
                })

    log(f"  Phase 1 complete: {len(pairs)} real passage pairs from {processed_docs} documents")
    return pairs


# ---------------------------------------------------------------------------
# Direct extraction phases
# ---------------------------------------------------------------------------

def extract_evidence_facts(evidence_index: dict) -> list[dict]:
    """Phase 2: LLM facts from source evidence index."""
    pairs = []
    for node_id, node_data in evidence_index.items():
        for fact in node_data.get("facts", []):
            claim = fact.get("claim", "")
            if claim and len(claim) >= 20:
                pairs.append({
                    "text": claim,
                    "node_id": node_id,
                    "source": "evidence_fact",
                    "weight": 0.8,
                    "metadata": {
                        "doc_id": fact.get("doc_id", ""),
                        "specificity": fact.get("specificity", ""),
                    }
                })
    log(f"Phase 2: {len(pairs)} evidence fact pairs")
    return pairs


def extract_pov_keypoints(summaries: list) -> list[dict]:
    """Phase 3: POV key_points from summary files."""
    pairs = []
    for summary in summaries:
        pov_sums = summary.get("pov_summaries", {})
        if not isinstance(pov_sums, dict):
            continue
        doc_id = summary.get("doc_id", "")
        for pov, pov_data in pov_sums.items():
            if not isinstance(pov_data, dict):
                continue
            for kp in pov_data.get("key_points", []):
                node_id = kp.get("taxonomy_node_id", "")
                point = kp.get("point", "")
                if node_id and point and len(point) >= 20:
                    pairs.append({
                        "text": point,
                        "node_id": node_id,
                        "source": "pov_keypoint",
                        "weight": 0.8,
                        "metadata": {
                            "doc_id": doc_id,
                            "pov": pov,
                            "stance": kp.get("stance", ""),
                        }
                    })
    log(f"Phase 3: {len(pairs)} POV key_point pairs")
    return pairs


def extract_factual_claims(summaries: list) -> list[dict]:
    """Phase 4: Factual claims from summary files."""
    pairs = []
    for summary in summaries:
        doc_id = summary.get("doc_id", "")
        for fc in summary.get("factual_claims", []):
            claim = fc.get("claim", "")
            linked = fc.get("linked_taxonomy_nodes", [])
            if claim and linked and len(claim) >= 20:
                for node_id in linked:
                    pairs.append({
                        "text": claim,
                        "node_id": node_id,
                        "source": "summary_factual_claim",
                        "weight": 0.7,
                        "metadata": {
                            "doc_id": doc_id,
                            "claim_label": fc.get("claim_label", ""),
                        }
                    })
    log(f"Phase 4: {len(pairs)} factual claim pairs")
    return pairs


def extract_node_attributes(nodes: dict) -> list[dict]:
    """Phase 5: Assumes and policy actions from node graph_attributes."""
    pairs = []
    for node_id, node in nodes.items():
        ga = node.get("graph_attributes", {})

        for assumes_text in ga.get("assumes", []):
            if assumes_text and len(assumes_text) >= 15:
                pairs.append({
                    "text": assumes_text,
                    "node_id": node_id,
                    "source": "assumes",
                    "weight": 0.6,
                    "metadata": {}
                })

        for pa in ga.get("policy_actions", []):
            action_text = pa.get("action", "")
            if action_text and len(action_text) >= 15:
                pairs.append({
                    "text": action_text,
                    "node_id": node_id,
                    "source": "policy_action",
                    "weight": 0.5,
                    "metadata": {
                        "policy_id": pa.get("policy_id", ""),
                    }
                })

    log(f"Phase 5: {len(pairs)} node attribute pairs (assumes + policy actions)")
    return pairs


# ---------------------------------------------------------------------------
# Edge augmentation
# ---------------------------------------------------------------------------

def build_edge_index(edges: list, conf_threshold: float) -> dict:
    """Build adjacency lists by edge type, filtered by confidence."""
    index = defaultdict(lambda: defaultdict(list))
    for e in edges:
        etype = e.get("type", "")
        conf = e.get("confidence", 0)
        if conf < conf_threshold:
            continue
        src = e.get("source", "")
        tgt = e.get("target", "")
        if src and tgt:
            index[etype][src].append({"target": tgt, "confidence": conf})
            if e.get("bidirectional", False):
                index[etype][tgt].append({"target": src, "confidence": conf})
    return index


def propagate_soft_positives(pairs: list[dict], edge_index: dict,
                              decay: float, min_weight: float,
                              known_nodes: set = None,
                              max_per_pair: int = 2) -> list[dict]:
    """Phase 6a: Propagate training pairs through SUPPORTS edges.

    Caps propagation at max_per_pair targets per source pair to prevent
    edge-propagated pairs from overwhelming direct pairs.
    Only propagates to nodes in known_nodes (if provided).
    """
    supports = edge_index.get("SUPPORTS", {})
    assumes_edges = edge_index.get("ASSUMES", {})
    propagated = []

    existing = {(p["text"], p["node_id"]) for p in pairs}

    for pair in pairs:
        node_id = pair["node_id"]
        text = pair["text"]
        base_weight = pair["weight"]
        pair_propagated = 0

        candidates = []
        for edge_list, edge_decay in [(supports, decay), (assumes_edges, decay * 0.7)]:
            for edge in edge_list.get(node_id, []):
                target = edge["target"]
                if known_nodes and target not in known_nodes:
                    continue
                prop_weight = base_weight * edge["confidence"] * edge_decay
                if prop_weight >= min_weight and (text, target) not in existing:
                    candidates.append((target, prop_weight, edge["confidence"],
                                       "SUPPORTS" if edge_decay == decay else "ASSUMES"))

        candidates.sort(key=lambda x: -x[1])
        for target, prop_weight, conf, etype in candidates[:max_per_pair]:
            propagated.append({
                "text": text,
                "node_id": target,
                "source": f"edge_propagated_{pair['source']}",
                "weight": round(prop_weight, 3),
                "metadata": {
                    "original_node": node_id,
                    "edge_type": etype,
                    "edge_confidence": conf,
                }
            })
            existing.add((text, target))

    log(f"Phase 6a: {len(propagated)} edge-propagated soft positive pairs (max {max_per_pair}/pair)")
    return propagated


def extract_hard_negatives(nodes: dict, edge_index: dict) -> list[dict]:
    """Phase 6b: Hard negatives from TENSION_WITH/CONTRADICTS edges + steelman."""
    hard_negs = []

    tension = edge_index.get("TENSION_WITH", {})
    contradicts = edge_index.get("CONTRADICTS", {})

    tension_targets = defaultdict(set)
    for src, edges in tension.items():
        for e in edges:
            tension_targets[src].add(e["target"])
    for src, edges in contradicts.items():
        for e in edges:
            tension_targets[src].add(e["target"])

    for node_id, node in nodes.items():
        ga = node.get("graph_attributes", {})
        steelman = ga.get("steelman_vulnerability", "")
        if steelman and len(steelman) >= 20:
            hard_negs.append({
                "text": steelman,
                "node_id": node_id,
                "source": "steelman_hard_negative",
                "weight": -1.0,
                "metadata": {
                    "opposing_nodes": list(tension_targets.get(node_id, set()))[:5],
                }
            })

    hard_neg_map = defaultdict(list)
    for hn in hard_negs:
        hard_neg_map[hn["node_id"]].append(hn)

    log(f"Phase 6b: {len(hard_negs)} steelman hard negatives")
    log(f"  Nodes with TENSION_WITH/CONTRADICTS targets: {len(tension_targets)}")
    return hard_negs, dict(tension_targets)


# ---------------------------------------------------------------------------
# Golden test set (held out for eval)
# ---------------------------------------------------------------------------

def load_golden_set(research_dir: Path) -> list[dict]:
    path = research_dir / "_golden_test_set.json"
    if not path.exists():
        log(f"WARNING: Golden test set not found at {path}")
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("claims", [])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Build training corpus for contrastive fine-tuning")
    parser.add_argument("--output", "-o", default=str(ARTIFACTS_DIR / "training_corpus.json"),
                        help="Output path for training corpus JSON")
    parser.add_argument("--skip-passages", action="store_true",
                        help="Skip Phase 1 (passage extraction) for faster iteration")
    parser.add_argument("--passage-threshold", type=float, default=DEFAULT_CONFIG["passage_similarity_threshold"])
    parser.add_argument("--passage-top-k", type=int, default=DEFAULT_CONFIG["passage_top_k"])
    parser.add_argument("--edge-confidence", type=float, default=DEFAULT_CONFIG["edge_confidence_threshold"])
    parser.add_argument("--decay", type=float, default=DEFAULT_CONFIG["soft_positive_decay"])
    parser.add_argument("--min-weight", type=float, default=DEFAULT_CONFIG["soft_positive_min_weight"])
    parser.add_argument("--max-prop-per-pair", type=int, default=2,
                        help="Max edge-propagated targets per source pair")
    args = parser.parse_args()

    config = load_config()
    data_root = Path(config["data_root"])
    sources_root = Path(config["sources_root"])
    taxonomy_dir = data_root / config["taxonomy_dir"]

    log(f"Data root: {data_root}")
    log(f"Sources root: {sources_root}")
    log(f"Taxonomy dir: {taxonomy_dir}")

    # Load all data
    t0 = time.time()
    nodes = load_taxonomy_nodes(taxonomy_dir)
    log(f"Loaded {len(nodes)} taxonomy nodes")

    evidence_index = load_source_evidence(data_root)
    log(f"Loaded source evidence for {len(evidence_index)} nodes")

    edges = load_edges(taxonomy_dir)
    log(f"Loaded {len(edges)} edges")

    summaries = load_summaries(data_root)
    log(f"Loaded {len(summaries)} summary files")

    golden = load_golden_set(RESEARCH_DIR)
    golden_node_ids = {c["attributed_node"] for c in golden}
    log(f"Loaded {len(golden)} golden test claims ({len(golden_node_ids)} unique nodes)")

    all_pairs = []

    # Phase 1: Real passages from snapshots
    if not args.skip_passages:
        from sentence_transformers import SentenceTransformer
        log(f"Loading model {config['model_name']}...")
        model = SentenceTransformer(config["model_name"])

        passage_pairs = extract_passages(
            model, sources_root, evidence_index,
            threshold=args.passage_threshold,
            top_k=args.passage_top_k
        )
        all_pairs.extend(passage_pairs)
    else:
        log("Phase 1: SKIPPED (--skip-passages)")

    # Phase 2: LLM facts
    all_pairs.extend(extract_evidence_facts(evidence_index))

    # Phase 3: POV key_points
    all_pairs.extend(extract_pov_keypoints(summaries))

    # Phase 4: Factual claims
    all_pairs.extend(extract_factual_claims(summaries))

    # Phase 5: Node attributes
    all_pairs.extend(extract_node_attributes(nodes))

    # Phase 6: Edge augmentation
    edge_index = build_edge_index(edges, conf_threshold=args.edge_confidence)

    propagated = propagate_soft_positives(
        all_pairs, edge_index,
        decay=args.decay,
        min_weight=args.min_weight,
        known_nodes=set(nodes.keys()),
        max_per_pair=args.max_prop_per_pair,
    )
    all_pairs.extend(propagated)

    hard_negatives, tension_map = extract_hard_negatives(nodes, edge_index)
    all_pairs.extend(hard_negatives)

    # Compute coverage stats
    covered_nodes = {p["node_id"] for p in all_pairs if p["weight"] > 0}
    gap_nodes = set(nodes.keys()) - covered_nodes
    source_counts = defaultdict(int)
    for p in all_pairs:
        source_counts[p["source"]] += 1

    elapsed = time.time() - t0

    # Build output
    corpus = {
        "metadata": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_pairs": len(all_pairs),
            "positive_pairs": sum(1 for p in all_pairs if p["weight"] > 0),
            "hard_negative_pairs": sum(1 for p in all_pairs if p["weight"] < 0),
            "unique_nodes_covered": len(covered_nodes),
            "total_taxonomy_nodes": len(nodes),
            "gap_nodes": len(gap_nodes),
            "coverage_rate": round(len(covered_nodes) / max(len(nodes), 1), 4),
            "golden_set_claims": len(golden),
            "golden_set_nodes": len(golden_node_ids),
            "sources": dict(source_counts),
            "elapsed_seconds": round(elapsed, 1),
            "config": {
                "passage_threshold": args.passage_threshold,
                "passage_top_k": args.passage_top_k,
                "edge_confidence": args.edge_confidence,
                "decay": args.decay,
                "min_weight": args.min_weight,
                "skip_passages": args.skip_passages,
                "max_prop_per_pair": args.max_prop_per_pair,
            }
        },
        "pairs": all_pairs,
        "tension_map": {k: list(v) for k, v in tension_map.items()},
        "gap_nodes": sorted(gap_nodes),
    }

    output_path = Path(args.output)
    output_path.write_text(json.dumps(corpus, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"\nCorpus written to {output_path}")
    log(f"  Total pairs: {len(all_pairs)}")
    log(f"  By source:")
    for src, count in sorted(source_counts.items(), key=lambda x: -x[1]):
        log(f"    {src}: {count}")
    log(f"  Coverage: {len(covered_nodes)}/{len(nodes)} nodes ({len(covered_nodes)/max(len(nodes),1)*100:.1f}%)")
    log(f"  Gap nodes: {len(gap_nodes)}")
    log(f"  Time: {elapsed:.1f}s")


if __name__ == "__main__":
    main()
