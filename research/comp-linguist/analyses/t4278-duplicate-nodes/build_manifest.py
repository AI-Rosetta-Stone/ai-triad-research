"""t/4278: build the reversal manifest (SO e/343#2, condition C4) and the edge-copy plan (C3). Read-only.

Reads frozen_list.json (never re-derives the target set) and ai-triad-data at the given revision. For
each survivor it records exactly what a supersede-in-place write would ADD:
  - node-level refs (debate_refs, situation_refs, concept_refs): the retired node's IDs that aren't
    already on the survivor;
  - edges (C3): each edge with a retired endpoint, re-pointed to the survivor, deduplicated by
    (source, target, type) against existing edges and against each other, with any edge that would
    become a self-loop dropped.
The originals are left in place for history. The undo is "remove superseded_by, then remove exactly
these additions".

Only groups with "mechanical": true are applied; editorial ones (G7, and 237 in G5) are listed but
held. Usage:
  python build_manifest.py --data <ai-triad-data root> --rev <rev> > reversal_manifest.json
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
    a = ap.parse_args()
    frozen = json.load(open(os.path.join(HERE, "frozen_list.json"), encoding="utf-8"))
    if frozen["data_revision"] != a.rev:
        sys.stderr.write(f"WARN build_manifest: --rev {a.rev} differs from frozen data_revision {frozen['data_revision']}\n")
    edges = show(a.data, a.rev, "taxonomy/Origin/edges.json")["edges"]
    existing = {(e["source"], e["target"], e["type"]) for e in edges}
    nodes = {}
    for pov, f in POV_FILE.items():
        for n in show(a.data, a.rev, f"taxonomy/Origin/{f}")["nodes"]:
            nodes[n["id"]] = n

    out = {"data_revision": a.rev, "survivors": [], "held": []}
    for g in frozen["groups"]:
        surv = g["survivor"]
        retire = g.get("retire_mechanical", g["retire"])
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
        new_edges, dropped_self = [], 0
        planned = set()
        for e in edges:
            if e["source"] not in retire and e["target"] not in retire:
                continue
            src = surv if e["source"] in retire else e["source"]
            tgt = surv if e["target"] in retire else e["target"]
            if src == tgt:
                dropped_self += 1
                continue
            k = (src, tgt, e["type"])
            if k in existing or k in planned:
                continue
            planned.add(k)
            ne = dict(e)
            ne.update(source=src, target=tgt, rationale_source="t4278-supersede-copy",
                      copied_from={"source": e["source"], "target": e["target"]})
            new_edges.append(ne)
        out["survivors"].append({"group": g["group"], "survivor": surv, "superseded": retire,
                                 "add_refs": {f: v for f, v in add_refs.items() if v},
                                 "add_edges": new_edges, "dropped_self_loops": dropped_self})
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
