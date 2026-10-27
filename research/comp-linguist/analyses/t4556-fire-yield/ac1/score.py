"""t/4556 AC1 scoring. Reads labels.json (blind) and only then label_key.json (arm).

Per doc and pooled:
  - points per arm; genuine / stretched / unsupported per arm
  - distinct genuine propositions (clusters) found by the union, and the share each arm captures
  - FIRE-only and chunked-only clusters
Decision rule (pre-registered in ../RESULTS.md before any data): under-extraction is confirmed if FIRE
coverage is <= 50% of chunked coverage on >= 4 of 5+ docs AND the propositions FIRE misses are not
carried in its factual_claims. The factual_claims check is done by hand on the FIRE-missed clusters and
recorded in fc_check.json (cluster -> true if a FIRE factual_claim carries it).
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
L = json.load(open(os.path.join(HERE, 'labels.json'), encoding='utf-8'))
key = json.load(open(os.path.join(HERE, 'label_key.json'), encoding='utf-8'))
sheet = {x['id']: x for x in json.load(open(os.path.join(HERE, 'label_sheet.json'), encoding='utf-8'))}
fc_path = os.path.join(HERE, 'fc_check.json')
fc = json.load(open(fc_path, encoding='utf-8')) if os.path.exists(fc_path) else {}
assert set(L['labels']) == set(key), 'every sheet item must be labelled exactly once'

out, pooled = {}, {'fire': {}, 'chunk': {}}
for doc in sorted({x['doc'] for x in sheet.values()}):
    ids = [i for i in key if sheet[i]['doc'] == doc]
    r = {}
    for arm in ('fire', 'chunk'):
        mine = [i for i in ids if key[i] == arm]
        lab = [L['labels'][i][0] for i in mine]
        r[arm] = dict(points=len(mine), genuine=lab.count('genuine'), stretched=lab.count('stretched'),
                      unsupported=lab.count('unsupported'),
                      clusters=sorted({L['labels'][i][1] for i in mine if L['labels'][i][0] == 'genuine'}))
        for k in ('points', 'genuine', 'stretched', 'unsupported'):
            pooled[arm][k] = pooled[arm].get(k, 0) + r[arm][k]
    union = sorted(set(r['fire']['clusters']) | set(r['chunk']['clusters']))
    fire_only = sorted(set(r['fire']['clusters']) - set(r['chunk']['clusters']))
    missed = sorted(set(r['chunk']['clusters']) - set(r['fire']['clusters']))
    fcd = fc.get(doc, {})
    rescued = [c for c in missed if fcd.get(c)]
    cov_f, cov_c = len(r['fire']['clusters']) / len(union), len(r['chunk']['clusters']) / len(union)
    r.update(union=len(union), fire_coverage=round(cov_f, 3), chunk_coverage=round(cov_c, 3),
             fire_only=fire_only, fire_missed=missed, missed_in_fire_factual_claims=rescued,
             fire_coverage_incl_fc=round((len(r['fire']['clusters']) + len(rescued)) / len(union), 3),
             ratio=round(cov_f / cov_c, 3) if cov_c else None)
    r['under_extracted'] = bool(cov_c and (len(r['fire']['clusters']) + len(rescued)) / len(union) <= 0.5 * cov_c)
    out[doc] = r
n_under = sum(v['under_extracted'] for v in out.values())
summary = dict(docs=len(out), under_extracted_docs=n_under,
               rule='under-extraction iff (FIRE coverage incl. factual_claims) <= 50% of chunked coverage on >= 4 docs',
               verdict='confirmed' if n_under >= 4 else 'not confirmed', pooled=pooled,
               union_total=sum(v['union'] for v in out.values()),
               fire_clusters_total=sum(len(v['fire']['clusters']) for v in out.values()),
               chunk_clusters_total=sum(len(v['chunk']['clusters']) for v in out.values()))
json.dump(dict(summary=summary, per_doc=out), open(os.path.join(HERE, 'results.json'), 'w', encoding='utf-8'), indent=1)
print(json.dumps(summary, indent=1))
for d, v in out.items():
    print(f"{d[:42]:42} union={v['union']:2} fire={len(v['fire']['clusters']):2} ({v['fire_coverage']:.2f}) "
          f"chunk={len(v['chunk']['clusters']):2} ({v['chunk_coverage']:.2f}) missed={v['fire_missed']} fire_only={v['fire_only']}")
