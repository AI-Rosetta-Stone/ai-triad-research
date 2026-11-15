"""t/246: score results.json against the pre-registered criteria in README.md."""
import json
import os
import sys
from collections import Counter

here = os.path.dirname(os.path.abspath(__file__))
res = json.load(open(os.path.join(here, "results.json"), encoding="utf-8-sig"))
held = {x["id"]: x for x in json.load(open(os.path.join(here, "heldout_labels.json"), encoding="utf-8"))["labels"]}
SEEDS = {"sit-447": "definitional", "sit-001": "interpretive", "sit-100": "interpretive", "sit-250": "interpretive",
         "sit-350": "interpretive", "sit-430": "interpretive", "sit-470": "interpretive", "sit-300": "structural",
         "sit-400": "structural"}
runs = res["runs"]
lab = lambda run, i: (run.get(i) or {}).get("label")

print(f"model {res['model']}  T={res['temperature']}  replicates {len(runs)}  prompt {res['prompt_sha256'][:12]}")
seed_ok = []
for k, run in enumerate(runs, 1):
    miss = [f"{i}:{lab(run, i)}" for i, g in SEEDS.items() if lab(run, i) != g]
    seed_ok.append(not miss)
    print(f"seed replicate {k}: {9 - len(miss)}/9  {miss or ''}")
c1 = all(seed_ok)

modal, flips = {}, []
for i in held:
    votes = Counter(lab(r, i) for r in runs)
    modal[i] = votes.most_common(1)[0][0]
    if len(votes) > 1:
        flips.append(f"{i} {dict(votes)}")
correct = sum(modal[i] == held[i]["label"] for i in held)
c2 = correct >= 24
gold_s = [i for i in held if held[i]["label"] == "structural"]
pred_s = [i for i in held if modal[i] == "structural"]
tp = len(set(gold_s) & set(pred_s))
s_rec, s_prec = tp / len(gold_s), (tp / len(pred_s) if pred_s else 0.0)
c3 = tp >= 2 and s_prec >= 0.5
gold_i = [i for i in held if held[i]["label"] == "interpretive"]
i_hit = sum(modal[i] == "interpretive" for i in gold_i)
c4 = i_hit >= 21
hi = [i for i in held if held[i]["confidence"] == "high"]
print(f"held-out modal accuracy {correct}/30   (high-confidence subset {sum(modal[i] == held[i]['label'] for i in hi)}/{len(hi)})")
print(f"structural: recall {tp}/{len(gold_s)}, precision {tp}/{len(pred_s)}   interpretive recall {i_hit}/{len(gold_i)}")
print("disagreements:", [f"{i} gold={held[i]['label']}({held[i]['confidence']}) model={modal[i]}" for i in held if modal[i] != held[i]["label"]])
print(f"flips across replicates: {len(flips)}/{len(held)} {flips}")
seed_flips = [i for i in SEEDS if len({lab(r, i) for r in runs}) > 1]
print(f"seed flips: {seed_flips}")
crit = {"C1 seeds 9/9 every replicate": c1, "C2 accuracy >= 24/30": c2,
        "C3 structural recall >= 2/4 and precision >= 0.5": c3, "C4 interpretive recall >= 21/26": c4}
for k, v in crit.items():
    print(f"{'PASS' if v else 'FAIL'}  {k}")
print("OVERALL:", "PASS" if all(crit.values()) else "FAIL")
