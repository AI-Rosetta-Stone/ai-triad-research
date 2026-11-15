#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""
generate_corpus.py — Helper for synthetic corpus generation pipeline.

Subcommands
-----------
  get-prompts         Get all generation prompts for specified nodes.
  get-hashes          Compute description hashes for staleness detection.
  filter-statements   Filter generated statements by rationale quality.
  export-embeddings   Embed corpus statements and export in dual format.

Used by New-SyntheticCorpus, Update-SyntheticCorpus, Sync-SyntheticCorpus,
and Export-SyntheticEmbeddings PowerShell cmdlets.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
_RESEARCH_DIR = _REPO_ROOT / "research" / "comp-linguist"

sys.path.insert(0, str(_RESEARCH_DIR))


def _resolve_taxonomy_dir(override=None):
    if override:
        return Path(override).resolve()
    config_path = _REPO_ROOT / ".aitriad.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
            data_root = cfg.get("data_root", ".")
            tax_dir = cfg.get("taxonomy_dir", "taxonomy/Origin")
            base = Path(data_root) if Path(data_root).is_absolute() else (_REPO_ROOT / data_root)
            return (base / tax_dir).resolve()
        except (json.JSONDecodeError, OSError):
            pass
    return (_REPO_ROOT / "taxonomy" / "Origin").resolve()


def _get_assembler(taxonomy_dir):
    from _archetype_templates import PromptAssembler
    return PromptAssembler(data_root=str(taxonomy_dir), research_dir=str(_RESEARCH_DIR))


def cmd_get_prompts(args):
    """Get all generation prompts for specified nodes."""
    taxonomy_dir = _resolve_taxonomy_dir(args.taxonomy_dir)
    assembler = _get_assembler(taxonomy_dir)

    node_ids = []
    if args.node_ids:
        node_ids = [n.strip() for n in args.node_ids.split(",")]
    elif args.pov:
        assembler._load()
        povs = ["acc", "saf", "skp"] if args.pov == "all" else [args.pov]
        node_ids = sorted(
            nid for nid in assembler._nodes if any(nid.startswith(p + "-") for p in povs)
        )

    if not node_ids:
        print("Error: specify --node-ids or --pov", file=sys.stderr)
        sys.exit(1)

    result = []
    stats = {"nodes": len(node_ids), "prompts": 0, "total_statements": 0}

    for nid in node_ids:
        try:
            prompts, primary, audience, total = assembler.generate_all_prompts(nid)
        except (ValueError, KeyError) as e:
            print(f"Warning: skipping {nid}: {e}", file=sys.stderr)
            continue

        node = assembler.get_node(nid)
        desc = node.get("description", "") if node else ""
        desc_hash = hashlib.sha256(desc.encode()).hexdigest()[:16]

        for p in prompts:
            prompt_text = p["system"] + p["user"]
            prompt_hash = hashlib.sha256(prompt_text.encode()).hexdigest()[:16]
            result.append({
                "node_id": p["node_id"],
                "archetype": p["archetype"],
                "audience": p["audience"],
                "count": p["count"],
                "system": p["system"],
                "user": p["user"],
                "prompt_hash": prompt_hash,
                "description_hash": desc_hash,
            })
            stats["prompts"] += 1
            stats["total_statements"] += p["count"]

    print(
        f"Generated {stats['prompts']} prompts for {stats['nodes']} nodes "
        f"({stats['total_statements']} total statements)",
        file=sys.stderr,
    )
    json.dump({"prompts": result, "stats": stats}, sys.stdout)


def cmd_get_hashes(args):
    """Compute description hashes for all nodes."""
    taxonomy_dir = _resolve_taxonomy_dir(args.taxonomy_dir)
    assembler = _get_assembler(taxonomy_dir)
    assembler._load()

    hashes = {}
    for nid, node in sorted(assembler._nodes.items()):
        desc = node.get("description", "")
        hashes[nid] = hashlib.sha256(desc.encode()).hexdigest()[:16]

    json.dump(hashes, sys.stdout)


def cmd_filter_statements(args):
    """Filter statements by rationale quality. Reads JSON array from stdin."""
    from _archetype_templates import filter_by_rationale

    taxonomy_dir = _resolve_taxonomy_dir(args.taxonomy_dir)
    assembler = _get_assembler(taxonomy_dir)
    assembler._load()

    raw = sys.stdin.read()
    data = json.loads(raw)
    node_id = data.get("node_id", "")
    statements = data.get("statements", [])

    nb_data = assembler._neighbors.get(node_id, {})
    neighbor_ids = [n.get("node_id", "") for n in nb_data.get("neighbors", [])]

    kept, filtered = filter_by_rationale(statements, node_id, neighbor_ids)

    json.dump({
        "node_id": node_id,
        "kept": kept,
        "filtered": filtered,
        "kept_count": len(kept),
        "filtered_count": len(filtered),
    }, sys.stdout)


def cmd_export_embeddings(args):
    """Embed corpus statements and export in dual format."""
    import embed_model_pins

    taxonomy_dir = _resolve_taxonomy_dir(args.taxonomy_dir)
    synthetic_dir = taxonomy_dir / "synthetic"

    if not synthetic_dir.exists():
        print(f"Error: synthetic directory not found: {synthetic_dir}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir) if args.output_dir else synthetic_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    model_name = args.model or "all-MiniLM-L6-v2"
    # t/110: these embeddings are read in production (lib/debate/syntheticStatementLookup.ts), so the
    # model must be PINNED -- an unpinned --model is refused, never loaded from `main` (TL p/37#17).
    try:
        revision = embed_model_pins.pinned_revision(model_name)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Loading model: {model_name}@{revision[:7]}", file=sys.stderr)
    model = embed_model_pins.load_sentence_transformer(model_name)

    do_numpy = args.format in ("numpy", "all")
    do_json = args.format in ("json", "all")

    json_output = {"metadata": {"model": model_name, "model_revision": revision,
                                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, "nodes": {}}

    for pov in ["acc", "saf", "skp"]:
        corpus_path = synthetic_dir / f"corpus_{pov}.json"
        if not corpus_path.exists():
            print(f"Skipping {pov}: {corpus_path.name} not found", file=sys.stderr)
            continue

        corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
        entries = corpus.get("entries", [])
        if not entries:
            print(f"Skipping {pov}: no entries", file=sys.stderr)
            continue

        by_node = {}
        for e in entries:
            if e.get("pruned"):
                continue
            nid = e["node_id"]
            if nid not in by_node:
                by_node[nid] = []
            by_node[nid].append(e)

        all_texts = []
        text_map = []
        for nid in sorted(by_node):
            for e in by_node[nid]:
                all_texts.append(e["statement"])
                text_map.append((nid, e.get("archetype", "unknown")))

        print(f"Encoding {len(all_texts)} {pov} statements...", file=sys.stderr)
        vectors = model.encode(all_texts, normalize_embeddings=True, show_progress_bar=True)

        if do_numpy:
            npy_path = output_dir / f"embeddings_{pov}.npy"
            np.save(str(npy_path), vectors)

            index = {}
            offset = 0
            for nid in sorted(by_node):
                count = len(by_node[nid])
                index[nid] = {"start": offset, "count": count}
                offset += count

            idx_path = output_dir / f"index_{pov}.json"
            idx_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
            print(f"  NumPy: {npy_path.name} ({vectors.shape}), {idx_path.name}", file=sys.stderr)

        if do_json:
            offset = 0
            for nid in sorted(by_node):
                node_entries = by_node[nid]
                count = len(node_entries)
                node_vecs = vectors[offset : offset + count]
                archetypes = [e.get("archetype", "unknown") for e in node_entries]
                json_output["nodes"][nid] = {
                    "pov": pov,
                    "vectors": [v.tolist() for v in node_vecs],
                    "archetypes": archetypes,
                }
                offset += count

    if do_json:
        json_path = output_dir / "synthetic_embeddings.json"
        json_path.write_text(json.dumps(json_output), encoding="utf-8")
        print(f"  JSON: {json_path.name} ({len(json_output['nodes'])} nodes)", file=sys.stderr)

    print("Export complete.", file=sys.stderr)
    json.dump({"status": "ok", "nodes": len(json_output["nodes"]), "model": model_name, "model_revision": revision}, sys.stdout)


def main():
    parser = argparse.ArgumentParser(description="Synthetic corpus generation helper.")
    sub = parser.add_subparsers(dest="command", required=True)

    gp = sub.add_parser("get-prompts", help="Get generation prompts for nodes")
    gp.add_argument("--taxonomy-dir", default=None)
    gp.add_argument("--node-ids", help="Comma-separated node IDs")
    gp.add_argument("--pov", choices=["acc", "saf", "skp", "all"], help="Generate for all nodes in POV")

    gh = sub.add_parser("get-hashes", help="Compute description hashes for all nodes")
    gh.add_argument("--taxonomy-dir", default=None)

    sub.add_parser("filter-statements", help="Filter statements by rationale (stdin JSON)")

    ee = sub.add_parser("export-embeddings", help="Embed corpus and export")
    ee.add_argument("--taxonomy-dir", default=None)
    ee.add_argument("--output-dir", help="Output directory (default: synthetic dir)")
    ee.add_argument("--model", help="Embedding model (default: all-MiniLM-L6-v2)")
    ee.add_argument("--format", choices=["numpy", "json", "all"], default="all")

    args = parser.parse_args()
    if args.command == "get-prompts":
        cmd_get_prompts(args)
    elif args.command == "get-hashes":
        cmd_get_hashes(args)
    elif args.command == "filter-statements":
        cmd_filter_statements(args)
    elif args.command == "export-embeddings":
        cmd_export_embeddings(args)


if __name__ == "__main__":
    main()
