"""t/4278: build the reversal manifest (SO e/343#2, condition C4) and the edge-copy plan (C3). Read-only.

Reads frozen_list.json (never re-derives the target set) and ai-triad-data at the given revision. For
each survivor it records exactly what a supersede-in-place write would ADD:
  - node-level refs (debate_refs, situation_refs, concept_refs): the retired node's IDs that aren't
    already on the survivor;
  - edges (C3): each edge with a retired endpoint, re-pointed to the survivor, deduplicated by
    (source, target, type) against existing edges and against each other, with any edge that would
    become a self-loop dropped. Both endpoints are remapped through the GLOBAL retire->survivor map
    (every group's, not just the edge's "owning" group) in one pass, so an edge between two nodes
    retired in DIFFERENT groups (e.g. t/4624's G9/G10, where saf-intentions-256 and saf-beliefs-281
    retire into different parents but point at each other) gets both ends remapped together, instead
    of each group's independent pass only remapping its own endpoint and leaving a half-remapped edge.
A group may set "fold_edges": false (default true) to opt OUT of edge-copying entirely -- SO
condition C1 on t/4624 (e/398#2): a demote-to-parent group's retiree relations are specific to the
narrow child and don't inherit upward to a general parent, unlike a duplicate-merge's. Those edges
are counted in "dropped_no_fold_edges" and left on the retired node, going dormant with it.
The originals are left in place for history. The undo is "remove superseded_by, then remove exactly
these additions".

Only groups with "mechanical": true are applied; editorial ones (G7, and 237 in G5) are listed but
held. Reads frozen_list.json plus any --extra-frozen paths (e.g. frozen_list_additions.json, t/4624),
merging their groups into one manifest -- a group id must be unique across all files given. Usage:
  python build_manifest.py --data <ai-triad-data root> --rev <rev> [--extra-frozen <path> ...] > reversal_manifest.json
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF_FIELDS = ("debate_refs", "situation_refs", "concept_refs")
POV_FILE = {"skeptic": "skeptic.json", "safetyist": "safetyist.json", "accelerationist": "accelerationist.json"}


def show(data, rev, path):
    out = subprocess.run(["git", "-C", data, "show", f"{rev}:{path}"], capture_output=True, text=True, encoding="utf-8")
    if out.returncode:
        raise SystemExit(f"git show {rev}:{path} failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])


def ref_key(r):
    return json.dumps(r, sort_keys=True) if isinstance(r, (dict, list)) else str(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--rev", required=True)
    ap.add_argument("--extra-frozen", action="append", default=[])
    a = ap.parse_args()
    groups = []
    for path in [os.path.join(HERE, "frozen_list.json")] + a.extra_frozen:
        frozen = json.load(open(path, encoding="utf-8"))
        if frozen["data_revision"] != a.rev:
            sys.stderr.write(f"WARN build_manifest: --rev {a.rev} differs from {path}'s "
                              f"data_revision {frozen['data_revision']}\n")
        groups.extend(frozen["groups"])
    seen_groups = set()
    for g in groups:
        if g["group"] in seen_groups:
            raise SystemExit(f"duplicate group id {g['group']!r} across input files")
        seen_groups.add(g["group"])
    edges = show(a.data, a.rev, "taxonomy/Origin/edges.json")["edges"]
    existing = {(e["source"], e["target"], e["type"]) for e in edges}
    nodes = {}
    for pov, f in POV_FILE.items():
        for n in show(a.data, a.rev, f"taxonomy/Origin/{f}")["nodes"]:
            nodes[n["id"]] = n

    retire_of_group = {}    # group id -> retire list (mechanical)
    sup_of = {}              # GLOBAL: retired id -> survivor id, across every group
    group_of_retired = {}    # retired id -> owning group id
    fold_edges_of = {}       # group id -> bool, default True (SO condition C1, t/4624/e/398#2:
                             # a demote-to-parent group can opt OUT of folding its edges onto the
                             # parent -- a narrow child's relations, especially CONTRADICTS/TENSION,
                             # don't inherit upward the way a duplicate-merge's do)
    for g in groups:
        retire = g.get("retire_mechanical", g["retire"])
        retire_of_group[g["group"]] = retire
        fold_edges_of[g["group"]] = g.get("fold_edges", True)
        for r in retire:
            sup_of[r] = g["survivor"]
            group_of_retired[r] = g["group"]

    out = {"data_revision": a.rev, "survivors": [], "held": []}
    add_edges_by_group = {g["group"]: [] for g in groups}
    dropped_self_by_group = {g["group"]: 0 for g in groups}
    no_fold_dropped_by_group = {g["group"]: 0 for g in groups}
    existing_or_planned = set(existing)
    for e in edges:
        if e["source"] not in sup_of and e["target"] not in sup_of:
            continue
        src_group = group_of_retired.get(e["source"])
        tgt_group = group_of_retired.get(e["target"])
        owning_group = src_group if src_group is not None else tgt_group
        if (src_group is not None and not fold_edges_of[src_group]) or \
           (tgt_group is not None and not fold_edges_of[tgt_group]):
            no_fold_dropped_by_group[owning_group] += 1
            continue
        src = sup_of.get(e["source"], e["source"])
        tgt = sup_of.get(e["target"], e["target"])
        if src == tgt:
            dropped_self_by_group[owning_group] += 1
            continue
        k = (src, tgt, e["type"])
        if k in existing_or_planned:
            continue
        existing_or_planned.add(k)
        ne = dict(e)
        ne.update(source=src, target=tgt, rationale_source="t4278-supersede-copy",
                  copied_from={"source": e["source"], "target": e["target"]})
        add_edges_by_group[owning_group].append(ne)

    for g in groups:
        surv = g["survivor"]
        retire = retire_of_group[g["group"]]
        held = [r for r in g["retire"] if r not in retire]
        if held:
            out["held"].append({"group": g["group"], "survivor": surv, "held_ids": held, "why": g.get("editorial_open", "editorial")})
        if not retire:
            continue
        s = nodes[surv]
        add_refs = {f: [] for f in REF_FIELDS}
        for r in retire:
            for f in REF_FIELDS:
                have = {ref_key(x) for x in as_list(s.get(f))} | {ref_key(x) for x in add_refs[f]}
                for x in as_list(nodes[r].get(f)):
                    if ref_key(x) not in have:
                        add_refs[f].append(x)
                        have.add(ref_key(x))
        out["survivors"].append({"group": g["group"], "survivor": surv, "superseded": retire,
                                 "disposition": g.get("disposition", "duplicate"),
                                 "fold_edges": fold_edges_of[g["group"]],
                                 "add_refs": {f: v for f, v in add_refs.items() if v},
                                 "add_edges": add_edges_by_group[g["group"]],
                                 "dropped_self_loops": dropped_self_by_group[g["group"]],
                                 "dropped_no_fold_edges": no_fold_dropped_by_group[g["group"]]})
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
