"""t/4473: per-key_point on-tag / off-tag split, verbatim-located proxy, and a blind labelling sample.

on_tag  = the key_point's camp is in the document's metadata pov_tags
off_tag = the document is tagged, but not with this camp

Writes kp_rows.json (all key_points of tagged docs) and label_sheet.json: 30 off-tag and
30 on-tag key_points, one per document, from single-shot and FIRE docs alike, shuffled
with a fixed seed. The sheet hides the tags, so the labeller sees camp, node, point and
verbatim only. The key (label_key.json) maps item id -> on/off.
Usage: python kp_sample.py <data_root> <sources_root>
"""
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA, SOURCES = sys.argv[1], sys.argv[2]
CAMPS = ['accelerationist', 'safetyist', 'skeptic']
SEED = 4473


def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', s.lower())).strip()


def located(verbatim, ntext):
    if isinstance(verbatim, list):
        verbatim = verbatim[0] if verbatim else ''
    v = norm(str(verbatim))
    if not v:
        return False
    if v in ntext:
        return True
    head = ' '.join(v.split()[:8])
    return len(head.split()) >= 5 and head in ntext


def node_labels():
    out = {}
    tdir = os.path.join(DATA, 'taxonomy', 'Origin')
    for f in ('accelerationist.json', 'safetyist.json', 'skeptic.json', 'situations.json'):
        p = os.path.join(tdir, f)
        if not os.path.exists(p):
            continue
        d = json.load(open(p, encoding='utf-8'))
        for n in d.get('nodes', []):
            out[n.get('id')] = n.get('label')
    return out


def main():
    labels = node_labels()
    rows = []
    sdir = os.path.join(DATA, 'summaries')
    for fn in sorted(os.listdir(sdir)):
        if not fn.endswith('.json'):
            continue
        doc = fn[:-5]
        meta = os.path.join(SOURCES, doc, 'metadata.json')
        snap = os.path.join(SOURCES, doc, 'snapshot.md')
        if not (os.path.exists(meta) and os.path.exists(snap)):
            continue
        try:
            s = json.load(open(os.path.join(sdir, fn), encoding='utf-8'))
        except Exception:
            continue
        tags = [t for t in (json.load(open(meta, encoding='utf-8')).get('pov_tags') or []) if t in CAMPS]
        if not tags or not isinstance(s, dict):
            continue
        ntext = norm(open(snap, encoding='utf-8', errors='replace').read())
        mode = (s.get('model_info') or {}).get('extraction_mode')
        for camp in CAMPS:
            for i, kp in enumerate(((s.get('pov_summaries') or {}).get(camp) or {}).get('key_points') or []):
                rows.append({
                    'doc': doc, 'mode': mode, 'camp': camp, 'idx': i, 'n_tags': len(tags),
                    'on_tag': camp in tags, 'stance': kp.get('stance'),
                    'located': located(kp.get('verbatim') or '', ntext),
                    'node': kp.get('taxonomy_node_id'), 'point': kp.get('point'),
                    'verbatim': kp.get('verbatim'),
                })
    json.dump(rows, open(os.path.join(HERE, 'kp_rows.json'), 'w', encoding='utf-8'), indent=1)

    for key in (True, False):
        rs = [r for r in rows if r['on_tag'] is key]
        st = Counter(r['stance'] for r in rs)
        print(f"{'on' if key else 'off'}-tag kp n={len(rs)} verbatim located {sum(r['located'] for r in rs) / len(rs):.1%} stance {dict(st.most_common(4))}")

    rng = random.Random(SEED)
    by_doc = defaultdict(lambda: {True: [], False: []})
    for r in rows:
        by_doc[r['doc']][r['on_tag']].append(r)
    docs = sorted(d for d, v in by_doc.items() if v[True] and v[False])
    rng.shuffle(docs)
    off_docs, on_docs = docs[:30], docs[30:60]
    items = [dict(rng.choice(by_doc[d][False]), arm='off') for d in off_docs] + \
            [dict(rng.choice(by_doc[d][True]), arm='on') for d in on_docs]
    rng.shuffle(items)
    sheet, key = [], {}
    for n, it in enumerate(items, 1):
        iid = f'K{n:02d}'
        key[iid] = {'arm': it['arm'], 'doc': it['doc'], 'camp': it['camp'], 'idx': it['idx']}
        sheet.append({'id': iid, 'camp': it['camp'], 'node': it['node'], 'node_label': labels.get(it['node']),
                      'stance': it['stance'], 'point': it['point'], 'verbatim': it['verbatim']})
    json.dump(sheet, open(os.path.join(HERE, 'label_sheet.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(key, open(os.path.join(HERE, 'label_key.json'), 'w', encoding='utf-8'), indent=1)
    print(f'label sheet: {len(sheet)} items from {len(off_docs) + len(on_docs)} docs')


if __name__ == '__main__':
    main()
