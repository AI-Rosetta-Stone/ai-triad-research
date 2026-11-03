"""t/4556 AC1: build the blind label sheet.

Pools every key_point from both arms per doc, shuffles (seed 4556), and assigns opaque ids.
label_sheet.json carries only doc / id / camp / category / point text (no arm).
label_key.json maps id -> arm and is not opened until labelling is finished.
Also dumps both arms' factual_claims per doc (factual_claims.json) for the "where did it go" check.
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
WT = 'C:/Users/jsnov/repos/ai-triad-data/.worktrees'
ARMS = {'fire': f'{WT}/data-t4556-fire', 'chunk': f'{WT}/data-t4556-chunk'}
sample = json.load(open(os.path.join(HERE, 'sample.json'), encoding='utf-8'))['sample']
rng = random.Random(4556)
sheet, key, fcs, counts = [], {}, {}, {}
for s in sample:
    d = s['doc']
    items = []
    counts[d] = {}
    for arm, root in ARMS.items():
        p = os.path.join(root, 'summaries', f'{d}.json')
        if not os.path.exists(p):
            counts[d][arm] = None
            continue
        summ = json.load(open(p, encoding='utf-8'))
        mi = summ.get('model_info') or {}
        n = 0
        for camp, b in (summ.get('pov_summaries') or {}).items():
            if not isinstance(b, dict):
                continue
            for k in b.get('key_points') or []:
                n += 1
                items.append(dict(arm=arm, camp=camp, category=k.get('category'),
                                  point=k.get('point'), canonical=k.get('canonical_proposition')))
        fcs.setdefault(d, {})[arm] = [c.get('claim') for c in summ.get('factual_claims') or []]
        counts[d][arm] = dict(key_points=n, factual_claims=len(summ.get('factual_claims') or []),
                              mode=mi.get('extraction_mode'), chunk_count=mi.get('chunk_count'),
                              fire_stats=summ.get('fire_stats') or mi.get('fire_stats'))
    if any(v is None for v in counts[d].values()):
        continue  # a doc missing from either arm is not paired and is not labelled
    rng.shuffle(items)
    for i, it in enumerate(items):
        iid = f'{d[:12]}-{i:03d}'
        key[iid] = it['arm']
        sheet.append(dict(id=iid, doc=d, camp=it['camp'], category=it['category'],
                          point=it['point'], canonical=it['canonical']))
json.dump(sheet, open(os.path.join(HERE, 'label_sheet.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
json.dump(key, open(os.path.join(HERE, 'label_key.json'), 'w', encoding='utf-8'), indent=1)
json.dump(fcs, open(os.path.join(HERE, 'factual_claims.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
json.dump(counts, open(os.path.join(HERE, 'counts.json'), 'w', encoding='utf-8'), indent=1, default=str)
print(f'{len(sheet)} items across {len({x["doc"] for x in sheet})} paired docs')
