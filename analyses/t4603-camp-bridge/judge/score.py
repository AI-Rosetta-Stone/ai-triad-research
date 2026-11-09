"""t/4880: score judge output against the t/4881 v2 two-rater reference labels.

Reference = the label where v2 raters A and B agree (binary: genuine vs bad).
Pass bar (stipulated, t/4880#2): on agreed off-tag items, bad-recall >= 0.8 AND
genuine items dropped <= 1 in 5. Every rate is reported with its counts.
Usage: python score.py <judge_out.jsonl> [label_key.json raterA.json raterB.json]
(defaults: the t/4742 sheet's key and v2 rater files)
"""
import collections
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, '..')

def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)

if len(sys.argv) > 4:
    key_path, a_path, b_path = sys.argv[2], sys.argv[3], sys.argv[4]
else:
    key_path = os.path.join(D, 'label_key.json')
    a_path = os.path.join(D, 'reliability', 'v2_raterA_labels_t4742.json')
    b_path = os.path.join(D, 'reliability', 'v2_raterB_labels_t4742.json')
key = load(key_path)
A = {k: v['label'] for k, v in load(a_path).items()}
B = {k: v['label'] for k, v in load(b_path).items()}

out, bad_parse = {}, []
with open(sys.argv[1], encoding='utf-8') as f:
    for line in f:
        r = json.loads(line)
        m = re.search(r'\{.*\}', r['text'] or '', re.S)
        try:
            out[r['id']] = json.loads(m.group(0))['relation']
        except Exception:
            bad_parse.append(r['id'])

def is_bad(lbl):
    return lbl != 'genuine'

def drops(rel):
    return rel != 'argues_for'

def cell(ids):
    agreed = [i for i in ids if i in out and is_bad(A[i]) == is_bad(B[i])]
    bad = [i for i in agreed if is_bad(A[i])]
    gen = [i for i in agreed if not is_bad(A[i])]
    caught = sum(drops(out[i]) for i in bad)
    lost = sum(drops(out[i]) for i in gen)
    return dict(n_agreed=len(agreed), bad_recall=f'{caught}/{len(bad)}', genuine_dropped=f'{lost}/{len(gen)}',
                recall=caught / len(bad) if bad else None, drop_rate=lost / len(gen) if gen else None)

ids = list(key)
res = {}
for name, sel in (('off_tag', lambda a: a.endswith('_off')), ('new_off', lambda a: a == 'new_off'),
                  ('new_on', lambda a: a == 'new_on'), ('all', lambda a: True)):
    res[name] = cell([i for i in ids if sel(key[i]['arm'])])
res['passes'] = (res['off_tag']['recall'] or 0) >= 0.8 and (res['off_tag']['drop_rate'] is not None and res['off_tag']['drop_rate'] <= 0.2)
res['relation_counts'] = dict(collections.Counter(out.values()))
res['unparsed'] = bad_parse
disputed = [i for i in ids if i in out and is_bad(A[i]) != is_bad(B[i])]
res['disputed'] = {i: out[i] for i in disputed}
print(json.dumps(res, indent=1))
