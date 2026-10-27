"""t/4471 model-tier check: un-blind the labels and score each arm against the pre-registered bars (spec §7c).

Reads labelling/{fc,anchors}_labels.json and labelling/key.json.
Reports every rate on all 11 docs and on the 8 docs that did not supply the round-2 examples.

Usage: python score.py   (the org arm was skipped for the model-tier check)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.join(HERE, "labelling")
EXAMPLE_DOCS = {
    "atria-dawn-dawn-agentic-superintelligence-evolving-roles-2026-1",
    "ai-companies-have-become-democratically-accountable-2026",
    "anthropic-pays-authors-15-billion-settle-copyright-2026",
}
OUTWARD = {"pronoun", "internal", "date_no_year"}


def load(name):
    return json.load(open(os.path.join(LAB, name), encoding="utf-8"))


key = load("key.json")
fc = load("fc_labels.json")["labels"]
an = load("anchors_labels.json")["labels"]


def rate(labels, keymap, hit, arm, subset):
    ids = [i for i, k in keymap.items() if k["arm"] == arm and (not subset or k["doc"] not in EXAMPLE_DOCS)]
    return sum(hit(labels[i]) for i in ids), len(ids)


out = {}
for arm in ("r2", "pro"):
    for subset, tag in ((False, "all11"), (True, "excl3")):
        n_out, n = rate(fc, key["fc"], lambda v: v in OUTWARD, arm, subset)
        n_art, _ = rate(fc, key["fc"], lambda v: v == "artifact", arm, subset)
        n_ok, n_an = rate(an, key["anchors"], bool, arm, subset)
        out[f"{arm}_{tag}"] = {"fc_outward": f"{n_out}/{n}", "fc_artifact": f"{n_art}/{n}",
                               "anchors_precision": f"{n_ok}/{n_an}"}

json.dump(out, open(os.path.join(HERE, "scores.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(json.dumps(out, indent=1, ensure_ascii=False))
