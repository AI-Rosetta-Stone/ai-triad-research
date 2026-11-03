"""t/4473 spec §5 steps 2-5: compare three versions of each sample document's summary.

  saved  the corpus summary (ai-triad-data b93a2dbc), chunked single-shot in 13 of 15 docs
  pre    re-extracted on cbfc37be^ (the commit before #3867), same day, same model
  post   re-extracted on c0e5414c (origin/main with #3867 / t/4519)

saved -> post is the pre-registered comparison. The saved summaries ran a path (chunked single-shot)
that AutoFire Stage 1 no longer takes, so pre -> post is the same-mode control for #3867 itself.

  python measure.py sheet <saved_data> <pre_data> <post_data> <pre_logs> <post_logs>
  python measure.py score

The blind sheet mixes post off-tag, pre off-tag and post on-tag key_points, shuffled with seed 4473.
It shows camp, node label, point and verbatim only: no doc tag, no arm. Up to 30 items per arm, at
most 3 per doc per arm.
"""
import json
import os
import random
import re
import statistics
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CAMPS = ['accelerationist', 'safetyist', 'skeptic']
SEED = 4473
SAMPLE = json.load(open(os.path.join(HERE, 'sample.json'), encoding='utf-8'))['sample']
ARMS = ('post_off', 'pre_off', 'post_on')


def kps(path):
    s = json.load(open(path, encoding='utf-8'))
    out = []
    for camp in CAMPS:
        for i, k in enumerate(((s.get('pov_summaries') or {}).get(camp) or {}).get('key_points') or []):
            out.append({'camp': camp, 'idx': i, 'node': k.get('taxonomy_node_id'), 'point': k.get('point'),
                        'verbatim': k.get('verbatim')})
    return s, out


def node_labels(data):
    out = {}
    for f in ('accelerationist.json', 'safetyist.json', 'skeptic.json', 'situations.json'):
        p = os.path.join(data, 'taxonomy', 'Origin', f)
        if os.path.exists(p):
            for n in json.load(open(p, encoding='utf-8')).get('nodes', []):
                out[n.get('id')] = n.get('label')
    return out


def run(data, log_dir, doc, tag):
    """One re-extraction: counts, calls and token estimate, or the failure. None-safe for failed runs."""
    lp = os.path.join(log_dir, f'{doc}.log')
    log = open(lp, encoding='utf-8', errors='replace').read() if os.path.exists(lp) else ''
    m = re.search(r'system instruction \((\d+) tokens est\.\) \+ prompt \((\d+) tokens est\.\)', log)
    per_call = (int(m.group(1)) + int(m.group(2))) if m else 0
    retry = len(re.findall(r'Pipeline: density retry', log))
    failed = re.search(r'RUN FAILED: (.*)', log)
    if failed:
        # The data worktree still holds the saved summary for a failed run: never score it.
        return {'failure': failed.group(1).strip(), 'calls': 1 + retry, 'tok': per_call * (1 + retry)}, None, []
    s, k = kps(os.path.join(data, 'summaries', f'{doc}.json'))
    mi = s.get('model_info') or {}
    calls = (mi.get('fire_stats') or {}).get('api_calls') or (1 + retry)
    present = sorted((s.get('pov_summaries') or {}).keys())
    empty = [c for c in CAMPS if not any(x['camp'] == c for x in k)]
    ec = s.get('empty_cells')
    declared = {e.get('camp') for e in (ec or []) if isinstance(e, dict)}
    return {
        'mode': mi.get('extraction_mode'), 'calls': calls, 'retry': retry, 'tok': per_call * calls,
        'on': sum(x['camp'] == tag for x in k), 'off': sum(x['camp'] != tag for x in k),
        'camps_present': present, 'empty_camps': empty,
        'empty_cells_persisted': isinstance(ec, list),
        'empty_camps_undeclared': [c for c in empty if c not in declared],
        'tagged_empty_warn': bool(re.search(r"tagged camp '\w+' has 0 key_points", log)),
    }, s, k


def sheet(saved_data, pre_data, post_data, pre_logs, post_logs):
    labels = node_labels(post_data)
    rows, per_doc = [], []
    for r in SAMPLE:
        d, tag = r['doc'], r['tag']
        _, ks = kps(os.path.join(saved_data, 'summaries', f'{d}.json'))
        pre, _, kpre = run(pre_data, pre_logs, d, tag)
        post, _, kpost = run(post_data, post_logs, d, tag)
        per_doc.append({'doc': d, 'tag': tag, 'chunked_saved': r['chunked'],
                        'saved_on': sum(x['camp'] == tag for x in ks), 'saved_off': sum(x['camp'] != tag for x in ks),
                        'pre': pre, 'post': post})
        for arm, src in (('post_off', [x for x in kpost if x['camp'] != tag]),
                         ('pre_off', [x for x in kpre if x['camp'] != tag]),
                         ('post_on', [x for x in kpost if x['camp'] == tag])):
            rows += [dict(x, doc=d, arm=arm) for x in src]
    rng = random.Random(SEED)
    picked = []
    for arm in ARMS:
        pool = [x for x in rows if x['arm'] == arm]
        rng.shuffle(pool)
        seen = defaultdict(int)
        for x in pool:
            if seen[x['doc']] < 3 and sum(p['arm'] == arm for p in picked) < 30:
                seen[x['doc']] += 1
                picked.append(x)
    rng.shuffle(picked)
    sht, key = [], {}
    for n, x in enumerate(picked, 1):
        iid = f'A{n:02d}'
        key[iid] = {'arm': x['arm'], 'doc': x['doc'], 'camp': x['camp'], 'idx': x['idx']}
        sht.append({'id': iid, 'camp': x['camp'], 'node': x['node'], 'node_label': labels.get(x['node']),
                    'point': x['point'], 'verbatim': x['verbatim']})
    json.dump(per_doc, open(os.path.join(HERE, 'per_doc.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(sht, open(os.path.join(HERE, 'label_sheet.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(key, open(os.path.join(HERE, 'label_key.json'), 'w', encoding='utf-8'), indent=1)
    print(f'sheet {len(sht)} items; arms', {a: sum(k["arm"] == a for k in key.values()) for a in ARMS})


def score():
    per_doc = json.load(open(os.path.join(HERE, 'per_doc.json'), encoding='utf-8'))
    key = json.load(open(os.path.join(HERE, 'label_key.json'), encoding='utf-8'))
    lab = json.load(open(os.path.join(HERE, 'labels.json'), encoding='utf-8'))
    res = {}
    for arm in ARMS:
        ls = [lab[i] for i, k in key.items() if k['arm'] == arm]
        res[arm] = {'n': len(ls), **{c: ls.count(c) for c in ('genuine', 'stretched', 'unsupported')}}
    ok = [p for p in per_doc if 'failure' not in p['post']]
    both = [p for p in ok if 'failure' not in p['pre']]

    def share(ps, side):
        off = sum(p[side]['off'] if side != 'saved' else p['saved_off'] for p in ps)
        on = sum(p[side]['on'] if side != 'saved' else p['saved_on'] for p in ps)
        return [off, off + on, round(off / (off + on), 3) if off + on else None]

    def med_change(ps, a, b):
        ch = []
        for p in ps:
            x = p['saved_on'] if a == 'saved' else p[a]['on']
            if x:
                ch.append((p[b]['on'] - x) / x)
        return {'median': round(statistics.median(ch), 3) if ch else None, 'n': len(ch)}

    out = {
        'labels': res,
        'off_tag_share': {'saved': share(ok, 'saved'), 'post': share(ok, 'post'),
                          'pre_paired': share(both, 'pre'), 'post_paired': share(both, 'post')},
        'on_tag_change': {'saved_to_post': med_change(ok, 'saved', 'post'),
                          'pre_to_post_paired': med_change(both, 'pre', 'post')},
        'kp_total_median': {'saved': statistics.median([p['saved_on'] + p['saved_off'] for p in ok]),
                            'pre_paired': statistics.median([p['pre']['on'] + p['pre']['off'] for p in both]),
                            'post_paired': statistics.median([p['post']['on'] + p['post']['off'] for p in both])},
        'post_docs_ok': [len(ok), len(per_doc)], 'paired_docs': len(both),
        'failures': {side: [(p['doc'], p[side]['failure']) for p in per_doc if 'failure' in p[side]] for side in ('pre', 'post')},
        'post_modes': {m: sum(p['post']['mode'] == m for p in ok) for m in ('fire', 'single_shot')},
        'single_shot_calls': {side: [(p['doc'], p[side]['calls']) for p in per_doc
                                     if p[side].get('mode') == 'single_shot' or ('failure' in p[side] and not p['chunked_saved'])]
                              for side in ('pre', 'post')},
        'post_empty_cells_persisted': [sum(p['post']['empty_cells_persisted'] for p in ok), len(ok)],
        'post_empty_camps': [(p['doc'], p['tag'], p['post']['empty_camps'], p['post']['tagged_empty_warn']) for p in ok if p['post']['empty_camps']],
        'post_tagged_camp_empty': [p['doc'] for p in ok if p['tag'] in p['post']['empty_camps']],
        'est_input_tokens': {side: sum(p[side]['tok'] for p in per_doc) for side in ('pre', 'post')},
    }
    json.dump(out, open(os.path.join(HERE, 'results.json'), 'w', encoding='utf-8'), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    if sys.argv[1] == 'sheet':
        sheet(*sys.argv[2:7])
    else:
        score()
