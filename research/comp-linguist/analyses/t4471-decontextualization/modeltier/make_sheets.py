"""t/4471 model-tier check: blind label sheets pooling round-2 (flash-lite) and pro items.

Same construction as round2/make_sheets.py (seed 4471, opaque ids, arm key in a separate file),
but the pool is round 2 + pro, so both arms are labelled together under one blind pass.

Usage: python make_sheets.py <r2_data_root> <pro_data_root> <docs.txt> <out_dir>
"""
import json
import os
import random
import sys

R2, PRO, DOCS, OUT = sys.argv[1:5]
POV = {"accelerationist": "acc", "safetyist": "saf", "skeptic": "skp"}
docs = [d.strip() for d in open(DOCS, encoding="utf-8") if d.strip()]


def items(root, arm):
    fcs, kps = [], []
    for d in docs:
        p = os.path.join(root, "summaries", f"{d}.json")
        if not os.path.exists(p):
            print(f"WARN: {arm} has no summary for {d}")
            continue
        s = json.load(open(p, encoding="utf-8"))
        for c in s.get("factual_claims") or []:
            fcs.append(dict(arm=arm, doc=d, claim=(c.get("claim") or "").strip()))
        for camp, b in (s.get("pov_summaries") or {}).items():
            if camp in POV and isinstance(b, dict):
                for k in b.get("key_points") or []:
                    kps.append(dict(arm=arm, doc=d, cp=(k.get("canonical_proposition") or "").strip(),
                                    anchors=k.get("anchors") or [], point=(k.get("point") or "").strip()))
    return fcs, kps


f2, k2 = items(R2, "r2")
fp, kp = items(PRO, "pro")
rng = random.Random(4471)


def blind(rows, prefix):
    rng.shuffle(rows)
    sheet, key = [], {}
    for i, r in enumerate(rows, 1):
        rid = f"{prefix}{i:03d}"
        key[rid] = {"arm": r["arm"], "doc": r["doc"]}
        sheet.append({"id": rid, **{k: v for k, v in r.items() if k not in ("arm", "doc")}})
    return sheet, key


fc_sheet, fc_key = blind(f2 + fp, "F")
an_sheet, an_key = blind([k for k in k2 + kp if k["anchors"]], "A")
cp_sheet, cp_key = blind([{k: v for k, v in x.items() if k in ("arm", "doc", "cp")} for x in kp], "C")
os.makedirs(OUT, exist_ok=True)
for name, obj in [("fc_sheet", fc_sheet), ("anchors_sheet", an_sheet), ("cp_sheet", cp_sheet),
                  ("key", {"fc": fc_key, "anchors": an_key, "cp": cp_key})]:
    json.dump(obj, open(os.path.join(OUT, f"{name}.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(f"fc {len(fc_sheet)} (r2 {len(f2)}, pro {len(fp)}); anchors {len(an_sheet)} "
      f"(r2 {sum(1 for k in k2 if k['anchors'])}, pro {sum(1 for k in kp if k['anchors'])}); cp {len(cp_sheet)}")
