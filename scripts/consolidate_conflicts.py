#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
consolidate_conflicts.py — Phase 1+2: Consolidate and enrich conflict items.

Phase 1 (Consolidation):
  - Loads all conflict JSON files from the data repo
  - Embeds each conflict description using all-MiniLM-L6-v2
  - Clusters by cosine similarity (default threshold 0.85)
  - Merges clusters into single conflicts with multiple instances

Phase 2 (Enrichment):
  - Re-links each consolidated conflict to the top-K most similar taxonomy
    nodes via embedding cosine similarity
  - Classifies attack_type (rebut/undercut/undermine) for 'disputes' instances
    using NLI cross-encoder
  - Writes schema-compliant conflict JSON files to a staging directory

Usage:
  python scripts/consolidate_conflicts.py                     # dry-run
  python scripts/consolidate_conflicts.py --write             # write to staging
  python scripts/consolidate_conflicts.py --write --replace   # replace originals
"""

import argparse
import json
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from data_tree_guard import assert_clean_data_tree  # t/2902

import numpy as np

import embed_taxonomy

_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent

# ── Resolve data root via .aitriad.json ──────────────────────────────────────

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
EMBEDDINGS_FILE: Optional[Path] = None
MODEL_NAME = "all-MiniLM-L6-v2"
NLI_MODEL_NAME = "cross-encoder/nli-deberta-v3-small"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _log(msg, **kwargs):
    print(msg, file=sys.stderr, **kwargs)


def _load_conflicts():
    """Load all conflicts from conflicts.json. Returns list of (None, data) tuples.

    The first element of each tuple is None (no per-file path in single-file model).
    Falls back to empty list if conflicts.json is missing.
    """
    conflicts_file = CONFLICTS_DIR / "conflicts.json"
    if not conflicts_file.exists():
        _log(f"  Warning: {conflicts_file} not found — returning empty list")
        return []
    try:
        wrapper = json.loads(conflicts_file.read_text(encoding="utf-8"))
        entries = wrapper.get("conflicts", [])
        return [(None, c) for c in entries]
    except (json.JSONDecodeError, OSError) as exc:
        _log(f"  ERROR reading {conflicts_file}: {exc}")
        return []


def _load_taxonomy_embeddings():
    """Load pre-computed taxonomy node embeddings from embeddings.json.

    Returns:
        node_ids: list of node IDs
        node_vectors: numpy array (N, 384)
        node_meta: dict mapping node_id -> {pov, label, description}
    """
    data = json.loads(EMBEDDINGS_FILE.read_text(encoding="utf-8"))
    nodes = data["nodes"]

    # Also load node labels/descriptions from POV files
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
                "description": node.get("description", ""),
            }

    node_ids = []
    vectors = []
    for nid, ndata in nodes.items():
        node_ids.append(nid)
        vectors.append(ndata["vector"])

    return node_ids, np.array(vectors, dtype=np.float32), meta


def _cosine_similarity_matrix(A, B):
    """Compute cosine similarity between row vectors of A and B."""
    A_norm = A / (np.linalg.norm(A, axis=1, keepdims=True) + 1e-10)
    B_norm = B / (np.linalg.norm(B, axis=1, keepdims=True) + 1e-10)
    return A_norm @ B_norm.T


# ── Phase 1: Clustering ─────────────────────────────────────────────────────

def cluster_conflicts(conflicts, model, threshold=0.85):
    """Cluster conflicts by description embedding similarity.

    Uses union-find to group conflicts whose descriptions exceed the
    cosine similarity threshold.

    Returns list of clusters, each a list of (path, data) tuples.
    """
    _log(f"  Embedding {len(conflicts)} conflict descriptions...")
    descriptions = [c[1].get("description", "") for c in conflicts]
    embeddings = model.encode(descriptions, show_progress_bar=True, batch_size=256)
    embeddings = np.array(embeddings, dtype=np.float32)

    _log("  Computing pairwise similarities...")
    # For 1698 items, the sim matrix is ~11.5 MB — fits in memory easily
    sim_matrix = _cosine_similarity_matrix(embeddings, embeddings)

    # Union-find clustering
    parent = list(range(len(conflicts)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    pair_count = 0
    for i in range(len(conflicts)):
        for j in range(i + 1, len(conflicts)):
            if sim_matrix[i, j] >= threshold:
                union(i, j)
                pair_count += 1

    _log(f"  Found {pair_count} similar pairs above threshold {threshold}")

    # Group by root
    groups = defaultdict(list)
    for i in range(len(conflicts)):
        groups[find(i)].append(conflicts[i])

    clusters = sorted(groups.values(), key=lambda g: len(g), reverse=True)
    return clusters, embeddings


def merge_cluster(cluster):
    """Merge a cluster of similar conflicts into a single consolidated conflict.

    Strategy:
    - Pick the conflict with the most instances as the "anchor"
    - Use its claim_label and description (longest description wins if tied)
    - Merge all instances, deduplicating by (doc_id, assertion[:80])
    - Merge all human_notes
    - Collect all linked_taxonomy_nodes (to be re-linked in Phase 2)
    - Preserve the anchor's claim_id
    """
    if len(cluster) == 1:
        return cluster[0][1], [c[0] for c in cluster]

    # Sort: most instances first, then longest description
    ranked = sorted(
        cluster,
        key=lambda c: (len(c[1].get("instances") or []), len(c[1].get("description", ""))),
        reverse=True,
    )
    anchor_path, anchor = ranked[0]

    # Merge instances with dedup
    seen_instances = set()
    merged_instances = []
    for _, conflict in ranked:
        for inst in (conflict.get("instances") or []):
            key = (inst.get("doc_id", ""), inst.get("assertion", "")[:80])
            if key not in seen_instances:
                seen_instances.add(key)
                merged_instances.append(inst)

    # Merge human_notes
    merged_notes = []
    seen_notes = set()
    for _, conflict in ranked:
        for note in (conflict.get("human_notes") or []):
            note_text = note if isinstance(note, str) else note.get("note", "")
            if note_text and note_text not in seen_notes:
                seen_notes.add(note_text)
                merged_notes.append(note)

    # Collect all original linked nodes (Phase 2 will replace these)
    original_links = set()
    for _, conflict in ranked:
        nodes = conflict.get("linked_taxonomy_nodes") or []
        if isinstance(nodes, str):
            nodes = [nodes]
        original_links.update(nodes)

    # Pick best label and description
    best_label = anchor.get("claim_label", "")
    best_desc = anchor.get("description", "")
    for _, conflict in ranked:
        desc = conflict.get("description", "")
        if len(desc) > len(best_desc):
            best_desc = desc
        label = conflict.get("claim_label", "")
        if len(label) > len(best_label) and len(label) <= 80:
            best_label = label

    merged = {
        "claim_id": anchor.get("claim_id", ""),
        "claim_label": best_label,
        "description": best_desc,
        "status": "open",
        "linked_taxonomy_nodes": sorted(original_links),  # placeholder — Phase 2 replaces
        "instances": merged_instances,
        "human_notes": merged_notes,
    }

    # Preserve verdict/qbaf if anchor had them
    if anchor.get("verdict"):
        merged["verdict"] = anchor["verdict"]
    if anchor.get("qbaf"):
        merged["qbaf"] = anchor["qbaf"]

    source_paths = [c[0] for c in cluster]
    return merged, source_paths


# ── Phase 2: Enrichment ─────────────────────────────────────────────────────

def relink_conflicts(consolidated, embeddings, model,
                     tax_node_ids, tax_vectors, tax_meta,
                     top_k=5, min_sim=0.35):
    """Re-link each consolidated conflict to the top-K most similar taxonomy nodes.

    Uses cosine similarity between the conflict description embedding and
    the pre-computed taxonomy node embeddings.

    Filters out policy nodes (pol-*) since conflicts should link to POV/situation nodes.
    Requires a minimum similarity threshold to avoid noise links.
    """
    _log(f"  Re-linking {len(consolidated)} conflicts to taxonomy (top-{top_k}, min_sim={min_sim})...")

    # Filter out policy nodes — conflicts should link to POV and situation nodes
    non_policy_mask = np.array([not nid.startswith("pol-") for nid in tax_node_ids])
    filtered_ids = [nid for nid, keep in zip(tax_node_ids, non_policy_mask) if keep]
    filtered_vectors = tax_vectors[non_policy_mask]

    # Embed all conflict descriptions
    descriptions = [c["description"] for c in consolidated]
    conflict_embeddings = model.encode(descriptions, show_progress_bar=False, batch_size=256)
    conflict_embeddings = np.array(conflict_embeddings, dtype=np.float32)

    # Compute similarities: (num_conflicts, num_tax_nodes)
    sims = _cosine_similarity_matrix(conflict_embeddings, filtered_vectors)

    valid_tax_ids = set(tax_meta.keys())
    stale_count = 0

    for i, conflict in enumerate(consolidated):
        row = sims[i]
        top_indices = np.argsort(row)[::-1][:top_k * 2]
        new_links = []
        for idx in top_indices:
            if row[idx] < min_sim:
                break
            nid = filtered_ids[idx]
            if nid not in valid_tax_ids:
                stale_count += 1
                continue
            new_links.append(nid)
            if len(new_links) >= top_k:
                break

        conflict["linked_taxonomy_nodes"] = new_links

    if stale_count > 0:
        _log(f"  Filtered {stale_count} stale node ID(s) not found in current taxonomy")

    return consolidated


def classify_attack_types(consolidated, nli_model):
    """Classify attack_type for 'disputes' instances using NLI cross-encoder.

    For each instance with stance='disputes', compares the instance assertion
    against the conflict description to determine:
    - rebut: the instance directly contradicts the claim (NLI: contradiction)
    - undercut: the instance challenges the reasoning (heuristic: mentions
      methodology, evidence quality, assumptions)
    - undermine: the instance attacks a premise (heuristic: cites counter-evidence)

    Falls back to 'rebut' when NLI is inconclusive.
    """
    _log("  Classifying attack types for 'disputes' instances...")

    # Collect all (description, assertion) pairs for NLI
    pairs = []
    pair_indices = []  # (conflict_idx, instance_idx)

    for ci, conflict in enumerate(consolidated):
        for ii, inst in enumerate(conflict.get("instances", [])):
            if inst.get("stance") == "disputes":
                pairs.append((conflict["description"], inst["assertion"]))
                pair_indices.append((ci, ii))

    if not pairs:
        _log("  No 'disputes' instances to classify.")
        return consolidated

    _log(f"  Running NLI on {len(pairs)} dispute pairs...")

    # NLI classification
    scores = nli_model.predict(pairs)
    label_order = getattr(nli_model, "_nli_label_order", None)
    if not label_order:
        raise ValueError("NLI model missing cached _nli_label_order; was config not read at load time?")

    # Undercut heuristics
    UNDERCUT_TERMS = {
        "methodology", "method", "flawed", "bias", "biased", "assumption",
        "assumes", "reasoning", "logic", "fallacy", "correlation",
        "causation", "sample size", "confound", "p-hacking", "replicat",
        "cherry-pick", "selection bias", "survivorship",
    }

    for idx, (ci, ii) in enumerate(pair_indices):
        inst = consolidated[ci]["instances"][ii]
        assertion_lower = inst["assertion"].lower()

        row = scores[idx]
        sorted_idx = np.argsort(row)[::-1]
        best_label = label_order[int(sorted_idx[0])]
        margin = float(row[sorted_idx[0]]) - float(row[sorted_idx[1]])

        # Check for undercut heuristics
        has_undercut_signal = any(term in assertion_lower for term in UNDERCUT_TERMS)

        # Check for undermine (cites specific counter-evidence)
        has_counter_evidence = inst.get("counter_evidence") is not None

        if has_undercut_signal:
            inst["attack_type"] = "undercut"
        elif has_counter_evidence:
            inst["attack_type"] = "undermine"
        elif best_label == "contradiction" and margin >= 0.5:
            inst["attack_type"] = "rebut"
        else:
            # Default for disputes without strong signal
            inst["attack_type"] = "rebut"

    classified = sum(1 for ci, ii in pair_indices
                     if consolidated[ci]["instances"][ii].get("attack_type"))
    _log(f"  Classified {classified} instances")
    return consolidated


# ── Output ───────────────────────────────────────────────────────────────────

def write_consolidated(consolidated, source_map, output_dir, replace=False):
    """Write consolidated conflicts to a single conflicts.json.

    Args:
        consolidated: list of merged conflict dicts
        source_map: dict mapping claim_id -> merge source count (int)
        output_dir: directory containing conflicts.json
        replace: ignored (legacy flag from per-file model)
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "generated_at": datetime.now().isoformat(),
        "original_count": sum(source_map.values()),
        "consolidated_count": len(consolidated),
        "reduction": f"{(1 - len(consolidated) / max(1, sum(source_map.values()))) * 100:.0f}%",
        "clusters": {},
    }

    for conflict in consolidated:
        cid = conflict["claim_id"]
        count = source_map.get(cid, 1)
        manifest["clusters"][cid] = {
            "instance_count": len(conflict.get("instances", [])),
            "linked_nodes": len(conflict.get("linked_taxonomy_nodes", [])),
            "merged_from": count,
        }

    consolidated.sort(key=lambda c: c.get("claim_id", ""))

    wrapper = {
        "_schema_version": "2.0",
        "_doc": "All conflict entries. Per-entry schema unchanged from conflict.schema.json.",
        "last_modified": datetime.now().isoformat(),
        "conflict_count": len(consolidated),
        "conflicts": consolidated,
    }

    conflicts_path = output_dir / "conflicts.json"
    assert_clean_data_tree(conflicts_path)  # t/2902
    conflicts_path.write_text(
        json.dumps(wrapper, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    _log(f"  Wrote {len(consolidated)} conflicts to {conflicts_path}")

    manifest_path = output_dir / "_consolidation_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    return manifest


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    global DATA_ROOT, CONFLICTS_DIR, TAXONOMY_DIR, EMBEDDINGS_FILE
    DATA_ROOT = _resolve_data_root()
    CONFLICTS_DIR = DATA_ROOT / "conflicts"
    TAXONOMY_DIR = DATA_ROOT / "taxonomy" / "Origin"
    EMBEDDINGS_FILE = TAXONOMY_DIR / "embeddings.json"

    parser = argparse.ArgumentParser(description="Consolidate and enrich conflict items")
    parser.add_argument("--threshold", type=float, default=0.85,
                        help="Cosine similarity threshold for clustering (default: 0.85)")
    parser.add_argument("--top-k", type=int, default=5,
                        help="Max taxonomy nodes to link per conflict (default: 5)")
    parser.add_argument("--min-sim", type=float, default=0.35,
                        help="Minimum similarity for taxonomy linking (default: 0.35)")
    parser.add_argument("--write", action="store_true",
                        help="Write consolidated files (default: dry-run)")
    parser.add_argument("--replace", action="store_true",
                        help="Replace originals (moves merged files). Requires --write.")
    parser.add_argument("--output-dir", type=str, default="",
                        help="Output directory (default: ai-triad-data/conflicts-consolidated/)")
    parser.add_argument("--skip-nli", action="store_true",
                        help="Skip NLI attack type classification (faster)")
    args = parser.parse_args()

    if args.replace and not args.write:
        parser.error("--replace requires --write")

    _log("=" * 60)
    _log("Conflict Consolidation & Enrichment Pipeline")
    _log("=" * 60)

    # ── Load data ──
    _log("\n[1/6] Loading conflict files...")
    conflicts = _load_conflicts()
    _log(f"  Loaded {len(conflicts)} conflicts from {CONFLICTS_DIR}")

    if len(conflicts) < 2:
        _log("  Not enough conflicts to consolidate.")
        return

    _log("\n[2/6] Loading taxonomy embeddings...")
    tax_node_ids, tax_vectors, tax_meta = _load_taxonomy_embeddings()
    _log(f"  Loaded {len(tax_node_ids)} node embeddings ({tax_vectors.shape[1]}-dim)")

    _log("\n[3/6] Loading embedding model...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL_NAME)

    # ── Phase 1: Cluster ──
    _log(f"\n[4/6] Phase 1: Clustering conflicts (threshold={args.threshold})...")
    t0 = time.time()
    clusters, conflict_embeddings = cluster_conflicts(conflicts, model, threshold=args.threshold)
    elapsed = time.time() - t0

    # Stats
    singletons = sum(1 for c in clusters if len(c) == 1)
    multi = [c for c in clusters if len(c) > 1]
    multi_sizes = [len(c) for c in multi]

    _log(f"\n  Clustering complete in {elapsed:.1f}s:")
    _log(f"    {len(clusters)} clusters from {len(conflicts)} conflicts")
    _log(f"    {singletons} singletons (unique claims)")
    _log(f"    {len(multi)} multi-item clusters")
    if multi_sizes:
        _log(f"    Largest cluster: {max(multi_sizes)} items")
        _log(f"    Mean cluster size: {sum(multi_sizes)/len(multi_sizes):.1f}")
    _log(f"    Reduction: {len(conflicts)} -> {len(clusters)} ({(1 - len(clusters)/len(conflicts))*100:.0f}%)")

    # Show top clusters
    _log("\n  Top 10 clusters:")
    for i, cluster in enumerate(clusters[:10]):
        labels = [c[1].get("claim_label", "?")[:60] for c in cluster[:3]]
        _log(f"    [{len(cluster)} items] {labels[0]}")
        for lbl in labels[1:]:
            _log(f"      + {lbl}")

    # ── Merge clusters ──
    _log("\n[5/6] Merging clusters...")
    consolidated = []
    source_map = {}  # claim_id -> merge count (int)

    for cluster in clusters:
        merged, source_paths = merge_cluster(cluster)
        consolidated.append(merged)
        source_map[merged["claim_id"]] = len(source_paths)

    # ── Phase 2: Enrich ──
    _log(f"\n[6/6] Phase 2: Enrichment...")

    # Re-link to taxonomy
    consolidated = relink_conflicts(
        consolidated, conflict_embeddings, model,
        tax_node_ids, tax_vectors, tax_meta,
        top_k=args.top_k, min_sim=args.min_sim,
    )

    # Classify attack types
    if not args.skip_nli:
        _log("  Loading NLI model...")
        nli_model = embed_taxonomy._load_nli_model()
        consolidated = classify_attack_types(consolidated, nli_model)
    else:
        _log("  Skipping NLI (--skip-nli)")

    # ── Stats ──
    total_instances = sum(len(c.get("instances", [])) for c in consolidated)
    total_links = sum(len(c.get("linked_taxonomy_nodes", [])) for c in consolidated)
    avg_instances = total_instances / max(1, len(consolidated))
    avg_links = total_links / max(1, len(consolidated))
    disputes_with_type = sum(
        1 for c in consolidated for inst in c.get("instances", [])
        if inst.get("stance") == "disputes" and inst.get("attack_type")
    )

    _log("\n" + "=" * 60)
    _log("Results:")
    _log(f"  Consolidated conflicts: {len(consolidated)}")
    _log(f"  Total instances: {total_instances} (avg {avg_instances:.1f}/conflict)")
    _log(f"  Total taxonomy links: {total_links} (avg {avg_links:.1f}/conflict)")
    _log(f"  Attack types classified: {disputes_with_type}")
    _log("=" * 60)

    # ── Write or report ──
    if args.write:
        output_dir = args.output_dir or str(DATA_ROOT / "conflicts-consolidated")
        _log(f"\nWriting {len(consolidated)} conflicts to {output_dir}...")
        manifest = write_consolidated(consolidated, source_map, output_dir, replace=args.replace)
        _log(f"  Done. Manifest: {output_dir}/_consolidation_manifest.json")

        # Print summary to stdout as JSON
        json.dump({
            "status": "complete",
            "original_count": len(conflicts),
            "consolidated_count": len(consolidated),
            "total_instances": total_instances,
            "total_links": total_links,
            "attack_types_classified": disputes_with_type,
            "output_dir": output_dir,
        }, sys.stdout, indent=2)
        print()
    else:
        _log("\n  DRY RUN — no files written. Use --write to persist.")
        json.dump({
            "status": "dry_run",
            "original_count": len(conflicts),
            "would_consolidate_to": len(consolidated),
            "total_instances": total_instances,
            "total_links": total_links,
        }, sys.stdout, indent=2)
        print()


if __name__ == "__main__":
    main()
