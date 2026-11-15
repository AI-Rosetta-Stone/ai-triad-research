"""t/246 iteration 2: score a results file against the iteration-2 pre-registration (README)."""
import json
import os
import sys
from collections import Counter

here = os.path.dirname(os.path.abspath(__file__))
res_name = sys.argv[1] if len(sys.argv) > 1 else "results_v9.json"
held_name = sys.argv[2] if len(sys.argv) > 2 else "heldout2_labels.json"
res = json.load(open(os.path.join(here, res_name), encoding="utf-8-sig"))
held = {x["id"]: x for x in json.load(open(os.path.join(here, held_name), encoding="utf-8"))["labels"]}
SEEDS = {"sit-447": "definitional", "sit-001": "interpretive", "sit-100": "interpretive", "sit-250": "interpretive",
         "sit-350": "interpretive", "sit-430": "interpretive", "sit-470": "interpretive", "sit-300": "structural",
         "sit-400": "structural"}
runs = res["runs"]
lab = lambda run, i: (run.get(i) or {}).get("label")
modal = lambda i: Counter(lab(r, i) for r in runs).most_common(1)[0][0]

print(f"{res_name}: model {res['model']} T={res['temperature']} reps {len(runs)} prompt {res['prompt_sha256'][:12]}")
for k, run in enumerate(runs, 1):
    miss = [f"{i}:{lab(run, i)}" for i, g in SEEDS.items() if lab(run, i) != g]
    print(f"  seed replicate {k}: {9 - len(miss)}/9 {miss or ''}")
seed_modal_miss = [f"{i}:{modal(i)}" for i, g in SEEDS.items() if modal(i) != g]
c1 = not seed_modal_miss
non_abstain = [i for i in held if held[i]["label"] != "insufficient"]
correct = sum(modal(i) == held[i]["label"] for i in non_abstain)
gold_i = [i for i in held if held[i]["label"] == "interpretive"]
false_struct = [i for i in gold_i if modal(i) == "structural"]
need = round(0.86 * len(non_abstain) + 0.4999)  # 25 of 29 for the iteration-2 set
c2 = correct >= need
c3 = len(false_struct) <= 2
flips = [f"{i} {dict(Counter(lab(r, i) for r in runs))}" for i in held if len({lab(r, i) for r in runs}) > 1]
print(f"  seeds modal: {9 - len(seed_modal_miss)}/9 {seed_modal_miss or ''}")
print(f"  held-out modal accuracy (non-abstain): {correct}/{len(non_abstain)} (need >= {need})")
print(f"  false structural among CL-interpretive: {len(false_struct)}/{len(gold_i)} {false_struct}")
for i in held:
    if held[i]["label"] in ("structural", "insufficient"):
        print(f"  reported: {i} gold={held[i]['label']} modal={modal(i)}")
print(f"  disagreements: {[f'{i} gold={held[i][chr(108)+chr(97)+chr(98)+chr(101)+chr(108)]} model={modal(i)}' for i in non_abstain if modal(i) != held[i]['label']]}")
print(f"  flips: {len(flips)} {flips}")
for name, ok in (("C1 seeds modal 9/9", c1), (f"C2 held-out >= {need}/{len(non_abstain)}", c2), ("C3 false structural <= 2", c3)):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
print("  OVERALL:", "PASS" if c1 and c2 and c3 else "FAIL")
