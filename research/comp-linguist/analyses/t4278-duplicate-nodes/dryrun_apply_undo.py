"""t/4278 dry run: apply the supersede-in-place write, then reverse it via the manifest (SO e/343#2, C4),
entirely in memory on the files at the frozen revision. Writes nothing to the data repo.

Checks:
  0. Serializer round-trip (/data-mutation element 6), against each file's OWN real byte contract:
     - the three POV files are fully pretty-printed (json.dumps(indent=2, ensure_ascii=False)+"\n"),
       per docs/edges-json-format.md's own "Scope" section;
     - edges.json uses the hybrid contract in docs/edges-json-format.md: top-level values
       pretty-printed and re-indented one level, "edges" compacted one edge per line
       (json.dumps(e, ensure_ascii=False, separators=(',', ':'))). A uniform indent=2 does NOT
       reproduce edges.json -- that was t/4624#3's naive check, which is a different, weaker
       check than the SO's t/4278#6 confirmation (which verified the REAL PS/TS writers against
       the contract's golden fixture, not this script's approximation). This function now
       implements the real contract for edges.json, verified byte-exact at ai-triad-data 2abb64ef
       (t/4624, TL request).
     If a file doesn't round-trip, the real write must use that file's own module funnel.
  1. Apply: exactly the manifest's survivors and superseded nodes change, plus edges.json gains exactly
     add_edges. Every other node is deep-equal, and node counts and order are unchanged.
  2. Undo: remove superseded_by, the manifest's add_refs and the manifest's add_edges. The result must be
     byte-identical to the original.
Usage:
  python dryrun_apply_undo.py --data <ai-triad-data root> --rev <rev>
Exit 0 means all checks passed.
"""
import argparse, collections, copy, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
POV_FILES = ("skeptic.json", "safetyist.json", "accelerationist.json")
EDGES_PATH = "taxonomy/Origin/edges.json"


def raw(data, rev, path):
    r = subprocess.run(["git", "-C", data, "show", f"{rev}:{path}"], capture_output=True)
    if r.returncode:
        raise SystemExit(f"git show {rev}:{path} failed")
    return r.stdout.decode("utf-8")


def ser(obj):
    """Generic pretty-print, correct for the three POV files (docs/edges-json-format.md Scope)."""
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def ser_edges(obj):
    """The REAL edges.json byte contract (docs/edges-json-format.md): top-level values
    pretty-printed and re-indented one level; "edges" compacted one edge per line with
    compact separators. Mirrors PowerShell's Write-EdgesFile / TypeScript's JSON.stringify
    reference implementations -- NOT a uniform json.dumps(indent=2)."""
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


def ser_for(path, obj):
    return ser_edges(obj) if path == EDGES_PATH else ser(obj)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--rev", required=True)
    a = ap.parse_args()
    man = json.load(open(os.path.join(HERE, "reversal_manifest.json"), encoding="utf-8"))
    ok = True
    files = {f"taxonomy/Origin/{f}": raw(a.data, a.rev, f"taxonomy/Origin/{f}") for f in POV_FILES}
    files["taxonomy/Origin/edges.json"] = raw(a.data, a.rev, "taxonomy/Origin/edges.json")

    # 0. Serializer round-trip. Normalise CRLF first, since git may hand back either. edges.json
    # loads with object_pairs_hook=OrderedDict (contract rules 1 and 6: top-level and per-edge key
    # order must be preserved exactly as read -- a plain dict on an old Python could reorder it).
    for p, txt in files.items():
        loaded = json.loads(txt, object_pairs_hook=collections.OrderedDict) if p == EDGES_PATH else json.loads(txt)
        same = ser_for(p, loaded) == txt.replace("\r\n", "\n")
        print(f"[0] serializer round-trip {p}: {'OK' if same else 'MISMATCH -> real write must use the module funnel'}")
        ok &= same

    orig = {p: json.loads(t) for p, t in files.items()}
    work = copy.deepcopy(orig)
    sup_of = {r: s["survivor"] for s in man["survivors"] for r in s["superseded"]}
    surv = {s["survivor"]: s for s in man["survivors"]}

    # 1. Apply.
    for p in (k for k in work if not k.endswith("edges.json")):
        for n in work[p]["nodes"]:
            if n["id"] in sup_of:
                n["superseded_by"] = sup_of[n["id"]]
            if n["id"] in surv:
                for f, vals in surv[n["id"]]["add_refs"].items():
                    n[f] = list(n.get(f) or []) + vals
    e_path = "taxonomy/Origin/edges.json"
    for s in man["survivors"]:
        work[e_path]["edges"].extend(s["add_edges"])

    changed = set()
    for p in (k for k in work if not k.endswith("edges.json")):
        a_nodes, o_nodes = work[p]["nodes"], orig[p]["nodes"]
        if [n["id"] for n in a_nodes] != [n["id"] for n in o_nodes]:
            print(f"[1] FAIL node order or count changed in {p}"); ok = False
        for an, on in zip(a_nodes, o_nodes):
            if an != on:
                changed.add(an["id"])
        if {k: v for k, v in work[p].items() if k != "nodes"} != {k: v for k, v in orig[p].items() if k != "nodes"}:
            print(f"[1] FAIL file-level keys changed in {p}"); ok = False
    expect = set(sup_of) | {s for s, v in surv.items() if any(v["add_refs"].values())}
    print(f"[1] nodes changed: {len(changed)}; expected {len(expect)}: {'OK' if changed == expect else 'MISMATCH ' + str(sorted(changed ^ expect))}")
    ok &= changed == expect
    n_added = len(work[e_path]["edges"]) - len(orig[e_path]["edges"])
    n_expect = sum(len(s["add_edges"]) for s in man["survivors"])
    same_prefix = work[e_path]["edges"][:len(orig[e_path]["edges"])] == orig[e_path]["edges"]
    print(f"[1] edges added: {n_added} (expected {n_expect}); originals untouched: {same_prefix}")
    ok &= n_added == n_expect and same_prefix

    # 2. Undo via the manifest only.
    for p in (k for k in work if not k.endswith("edges.json")):
        for n in work[p]["nodes"]:
            n.pop("superseded_by", None)
            if n["id"] in surv:
                for f, vals in surv[n["id"]]["add_refs"].items():
                    k = len(n[f]) - len(vals)
                    assert n[f][k:] == vals, f"undo: {n['id']}.{f} tail doesn't match the manifest"
                    n[f] = n[f][:k]
                    if not n[f] and f not in next(x for x in orig[p]["nodes"] if x["id"] == n["id"]):
                        del n[f]
    work[e_path]["edges"] = work[e_path]["edges"][:len(orig[e_path]["edges"])]
    for p in work:
        same = ser_for(p, work[p]) == ser_for(p, orig[p])
        print(f"[2] undo byte-identical {p}: {'OK' if same else 'FAIL'}")
        ok &= same
    print("ALL CHECKS PASS" if ok else "CHECKS FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
