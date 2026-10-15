"""t/4211 M1: agreement between the CL's blind labels and the custodian-check judge.

Reads, from analyses/t4211-tag-aware-reflection/:
  m1-results.jsonl     judge output (t4211_m1_judge_calibration.ts)
  m1-sample-keys.json  the sample order (S01..Snn -> edit key)
  m1-cl-labels.json    the CL's blind labels, keyed S01..Snn

Prints the 3x3 confusion matrix, then Cohen's kappa at three granularities with n and prevalence:
three classes, flag (tension or conflict) vs consistent, and conflict vs not. Each edit is scored
by its worst verdict over its custodians.

Usage: python research/comp-linguist/scripts/t4211_m1_agreement.py
"""
import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "analyses", "t4211-tag-aware-reflection")
RANK = {"consistent": 0, "tension": 1, "conflict": 2}
CATS = ["consistent", "tension", "conflict"]


def load(name):
    with open(os.path.join(D, name), encoding="utf-8") as fh:
        return json.load(fh)


def kappa(pairs, cats):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca = collections.Counter(a for a, _ in pairs)
    cb = collections.Counter(b for _, b in pairs)
    pe = sum(ca[c] * cb[c] for c in cats) / (n * n)
    return po, pe, ((po - pe) / (1 - pe) if pe < 1 else float("nan"))


def main():
    keys = load("m1-sample-keys.json")
    labels = load("m1-cl-labels.json")["labels"]
    rows = {}
    with open(os.path.join(D, "m1-results.jsonl"), encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                r = json.loads(line)
                rows[r["key"]] = r

    pairs = []
    for n, key in enumerate(keys, 1):
        sid = f"S{n:02d}"
        worst = max(rows[key]["verdicts"], key=lambda v: RANK[v["verdict"]])
        pairs.append((sid, labels[sid][0], worst["verdict"]))

    three = [(a, b) for _, a, b in pairs]
    cm = collections.Counter(three)
    print(f"n = {len(pairs)} (rows: CL label, columns: judge)")
    print(" " * 12 + "".join(f"{c:>12s}" for c in CATS))
    for a in CATS:
        print(f"{a:>12s}" + "".join(f"{cm[(a, b)]:>12d}" for b in CATS))

    def report(name, mapped, cats):
        po, pe, k = kappa(mapped, cats)
        prev = ", ".join(f"{c}: CL {sum(a == c for a, _ in mapped)} / judge {sum(b == c for _, b in mapped)}" for c in cats)
        print(f"{name}: kappa {k:.2f} (agreement {po:.2f}, chance {pe:.2f}; {prev})")

    report("3-class", three, CATS)
    report("flag vs consistent", [tuple("flag" if x != "consistent" else "ok" for x in p) for p in three], ["flag", "ok"])
    report("conflict vs not", [tuple("conflict" if x == "conflict" else "not" for x in p) for p in three], ["conflict", "not"])
    print("disagreements: " + ", ".join(f"{s} (CL {a}, judge {b})" for s, a, b in pairs if a != b))


if __name__ == "__main__":
    main()
