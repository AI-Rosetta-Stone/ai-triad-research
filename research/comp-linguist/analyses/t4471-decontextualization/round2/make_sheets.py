"""t/4471 round 2: build blind label sheets.

Round-1 and round-2 items are pooled and shuffled (seed 4471) under opaque ids, so the rater
labels without knowing which prompt produced an item. The arm key goes to a separate file that
is read only by score.py after labelling.

Usage: python make_sheets.py <r1_data_root> <r2_data_root> <docs.txt> <out_dir>
"""
import json
import os
import random
import sys

R1, R2, DOCS, OUT = sys.argv[1:5]
POV = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp"}
docs = [d.strip() for d in open(DOCS, encoding="utf-8") if d.strip()]


def items(root, arm):
    fcs, kps = [], []
    for d in docs:
        s = json.load(open(os.path.join(root, "summaries", f"{d}.json"), encoding="utf-8"))
        for c in s.get("factual_claims") or []:
            fcs.append(dict(arm=arm, doc=d, claim=(c.get("claim") or "").strip()))
        for camp, b in (s.get("pov_summaries") or {}).items():
            if camp in POV and isinstance(b, dict):
                for k in b.get("key_points") or []:
                    kps.append(dict(arm=arm, doc=d, cp=(k.get("canonical_proposition") or "").strip(),
                                    anchors=k.get("anchors") or [], point=(k.get("point") or "").strip()))
    return fcs, kps


f1, k1 = items(R1, "r1")
f2, k2 = items(R2, "r2")
rng = random.Random(4471)


def blind(rows, prefix):
    rng.shuffle(rows)
    sheet, key = [], {}
    for i, r in enumerate(rows, 1):
        rid = f"{prefix}{i:03d}"
        key[rid] = {"arm": r["arm"], "doc": r["doc"]}
        sheet.append({"id": rid, **{k: v for k, v in r.items() if k not in ("arm", "doc")}})
    return sheet, key


fc_sheet, fc_key = blind(f1 + f2, "F")
an_sheet, an_key = blind([k for k in k1 + k2 if k["anchors"]], "A")
cp_sheet, cp_key = blind([{k: v for k, v in x.items() if k in ("arm", "doc", "cp")} for x in k2], "C")
os.makedirs(OUT, exist_ok=True)
for name, obj in [("fc_sheet", fc_sheet), ("anchors_sheet", an_sheet), ("cp_sheet", cp_sheet),
                  ("key", {"fc": fc_key, "anchors": an_key, "cp": cp_key})]:
    json.dump(obj, open(os.path.join(OUT, f"{name}.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(f"fc {len(fc_sheet)} (r1 {len(f1)}, r2 {len(f2)}); anchors {len(an_sheet)}; cp {len(cp_sheet)}")
