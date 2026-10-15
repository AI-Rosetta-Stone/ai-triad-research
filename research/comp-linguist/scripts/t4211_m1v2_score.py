"""t/4211 M1 v2: score each judge model against the v2 gate (m1-report.md §5.2).

Inputs, from analyses/t4211-tag-aware-reflection/:
  m1v2-results-<model>.jsonl      judge v2 over the 167 observed edits
  m1v2-constructed-<model>.jsonl  judge v2 over the constructed set (keys C:<id>)
  m1-sample-keys.json, m1-cl-labels.json   the 34 blind CL labels from M1 v1 (observed)
  m1-constructed-set.json         the constructed items with their intended verdict

The v2 gate, per model:
  1. conflict-vs-not kappa >= 0.6 on the observed 34 plus the constructed 12 together;
  2. every constructed conflict is judged conflict (6 of 6);
  3. flag-vs-consistent kappa >= 0.6 on the observed 34;
  plus the unchecked rate on the 167 observed edits, against the 5% condition (#3312 review).
Each edit is scored by its worst verdict over its custodians; an unchecked row counts as a flag (fail closed).

Usage: python research/comp-linguist/scripts/t4211_m1v2_score.py [--models gemini-3.5-flash-lite,gemini-3.1-pro-preview]
"""
import argparse
import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "analyses", "t4211-tag-aware-reflection")
RANK = {"consistent": 0, "tension": 1, "conflict": 2}
SHORT = {"gemini-3.5-flash-lite": "flash-lite", "gemini-3.1-pro-preview": "pro"}


def load_json(name):
    with open(os.path.join(D, name), encoding="utf-8") as fh:
        return json.load(fh)


def load_rows(name):
    with open(os.path.join(D, name), encoding="utf-8") as fh:
        return {r["key"]: r for r in (json.loads(l) for l in fh if l.strip())}


def worst(row):
    if row["outcome"] != "checked":
        return "unchecked"
    return max(row["verdicts"], key=lambda v: RANK[v["verdict"]])["verdict"]


def kappa(pairs):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca = collections.Counter(a for a, _ in pairs)
    cb = collections.Counter(b for _, b in pairs)
    pe = sum(ca[c] * cb[c] for c in set(ca) | set(cb)) / (n * n)
    return (po - pe) / (1 - pe) if pe < 1 else float("nan"), po


def score(model):
    short = SHORT.get(model, model)
    obs = load_rows(f"m1v2-results-{short}.jsonl")
    con = load_rows(f"m1v2-constructed-{short}.jsonl")
    keys = load_json("m1-sample-keys.json")
    labels = load_json("m1-cl-labels.json")["labels"]
    items = {i["id"]: i for i in load_json("m1-constructed-set.json")["items"]}

    pop = collections.Counter(worst(r) for r in obs.values())
    n_pop = len(obs)
    unchecked_rate = pop["unchecked"] / n_pop

    observed = [(labels[f"S{n:02d}"][0], worst(obs[k])) for n, k in enumerate(keys, 1)]
    constructed = [(items[k[2:]]["expected"], worst(r)) for k, r in sorted(con.items())]

    conf = lambda v: "conflict" if v == "conflict" else "not"
    flag = lambda v: "ok" if v == "consistent" else "flag"
    k_conf, _ = kappa([(conf(a), conf(b)) for a, b in observed + constructed])
    k_flag, _ = kappa([(flag(a), flag(b)) for a, b in observed])
    k_three, _ = kappa(observed)
    caught = sum(1 for a, b in constructed if a == "conflict" and b == "conflict")
    n_conf = sum(1 for a, _ in constructed if a == "conflict")
    near_as_conflict = sum(1 for a, b in constructed if a != "conflict" and b == "conflict")

    print(f"=== {model} ===")
    print(f"population n={n_pop}: {dict(pop)}; unchecked {pop['unchecked']}/{n_pop} = {unchecked_rate:.1%}")
    cm = collections.Counter(observed)
    cats = ["consistent", "tension", "conflict", "unchecked"]
    print("observed 34, rows CL / columns judge:")
    for a in cats[:3]:
        print(f"  {a:>10s} " + " ".join(f"{cm[(a, b)]:>3d}" for b in cats))
    print(f"  3-class kappa {k_three:.2f} (n=34)")
    print(f"  constructed: conflicts caught {caught}/{n_conf}; near misses judged conflict {near_as_conflict}/{len(constructed) - n_conf}")
    for k, r in sorted(con.items()):
        print(f"    {k[2:]} expected {items[k[2:]]['expected']:9s} judge {worst(r)}")
    gate = {
        f"1 conflict-vs-not kappa >= 0.6 (observed + constructed, n={len(observed) + len(constructed)})": (k_conf, k_conf >= 0.6),
        "2 constructed conflicts caught 6/6": (f"{caught}/{n_conf}", caught == n_conf),
        "3 flag-vs-consistent kappa >= 0.6 (observed, n=34)": (k_flag, k_flag >= 0.6),
        f"unchecked rate <= 5% (n={n_pop})": (f"{unchecked_rate:.1%}", unchecked_rate <= 0.05),
    }
    for name, (value, ok) in gate.items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {value if isinstance(value, str) else f'{value:.2f}'}")
    print(f"  disagreements (observed): " + ", ".join(
        f"S{n:02d} CL {a} / judge {b}" for n, (a, b) in enumerate(observed, 1) if a != b))
    return all(ok for _, ok in gate.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="gemini-3.5-flash-lite,gemini-3.1-pro-preview")
    for m in ap.parse_args().models.split(","):
        print(f"GATE {'PASSED' if score(m) else 'NOT MET'} for {m}\n")


if __name__ == "__main__":
    main()
