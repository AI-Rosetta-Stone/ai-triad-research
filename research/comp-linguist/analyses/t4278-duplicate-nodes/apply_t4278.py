"""t/4278: apply the supersede-in-place write (step 5, TL approval t/4278#19, hashes
03581b74/1bf104da/7586c585). Reads ONLY reversal_manifest.json. Writes the three POV
files through the REAL writer (scripts/json-canonical.mjs via Node -- same as
Write-PovTaxonomyFile), and edges.json through the verified real-contract Python
serializer (ser_edges, matching dryrun_apply_undo.py's check [3], itself verified
byte-exact against the live file at t/4624 and t/4278#19's recount).

Usage:
    python apply_t4278.py --data <ai-triad-data worktree> --node-script <repo>/scripts/json-canonical.mjs
"""
import argparse, collections, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
POV_FILES = ("skeptic.json", "safetyist.json", "accelerationist.json")
EDGES_PATH = "taxonomy/Origin/edges.json"


def ser_edges(obj):
    parts = ["{\n"]
    keys = list(obj.keys())
    for i, k in enumerate(keys):
        v = obj[k]
        if k == "edges":
            if not v:
                line = '  "edges": []'
            else:
                edge_lines = [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in v]
                line = '  "edges": [\n' + ",\n".join("    " + el for el in edge_lines) + "\n  ]"
        else:
            pretty = json.dumps(v, ensure_ascii=False, indent=2)
            pretty_lines = pretty.split("\n")
            reindented = pretty_lines[0]
            if len(pretty_lines) > 1:
                reindented += "\n" + "\n".join(("  " + ln if ln else ln) for ln in pretty_lines[1:])
            line = f'  "{k}": {reindented}'
        comma = "," if i < len(keys) - 1 else ""
        parts.append(line + comma + "\n")
    parts.append("}\n")
    return "".join(parts)


def write_pov_file_via_node(node_cmd, node_script, data, obj, target_path):
    carrier = os.path.join(os.path.dirname(target_path), ".apply_carrier.json")
    with open(carrier, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False))
    r = subprocess.run(node_cmd + [node_script, "--in", carrier, "--out", target_path], capture_output=True)
    os.remove(carrier)
    if r.returncode != 0:
        raise SystemExit(f"json-canonical.mjs failed for {target_path}: {r.returncode}: {r.stderr.decode()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="ai-triad-data worktree root")
    ap.add_argument("--node-script", required=True, help="path to scripts/json-canonical.mjs")
    a = ap.parse_args()

    man = json.load(open(os.path.join(HERE, "reversal_manifest.json"), encoding="utf-8"))
    sup_of = {r: s["survivor"] for s in man["survivors"] for r in s["superseded"]}
    surv = {s["survivor"]: s for s in man["survivors"]}

    node_cmd = ["node"]

    changed_files = []
    for f in POV_FILES:
        path = os.path.join(a.data, "taxonomy", "Origin", f)
        with open(path, "r", encoding="utf-8") as fh:
            before_text = fh.read()
        obj = json.loads(before_text)
        touched = False
        for n in obj["nodes"]:
            if n["id"] in sup_of:
                n["superseded_by"] = sup_of[n["id"]]
                touched = True
            if n["id"] in surv:
                for field, vals in surv[n["id"]]["add_refs"].items():
                    if vals:
                        n[field] = list(n.get(field) or []) + vals
                        touched = True
        if touched:
            write_pov_file_via_node(node_cmd, a.node_script, a.data, obj, path)
            changed_files.append(f"taxonomy/Origin/{f}")
            print(f"wrote taxonomy/Origin/{f} via json-canonical.mjs")

    e_path = os.path.join(a.data, EDGES_PATH)
    with open(e_path, "r", encoding="utf-8") as fh:
        e_before_text = fh.read()
    e_obj = json.loads(e_before_text, object_pairs_hook=collections.OrderedDict)
    all_add_edges = [edge for s in man["survivors"] for edge in s["add_edges"]]
    if all_add_edges:
        e_obj["edges"] = list(e_obj["edges"]) + all_add_edges
        new_edges_text = ser_edges(e_obj)
        with open(e_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(new_edges_text)
        changed_files.append(EDGES_PATH)
        print(f"wrote {EDGES_PATH} via ser_edges (verified real contract), +{len(all_add_edges)} edges")

    print("APPLY DONE. Changed files:", changed_files)


if __name__ == "__main__":
    main()
