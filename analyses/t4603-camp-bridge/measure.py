"""t/4473 spec §5 steps 2-5 on the default chunked production path (t/4473#6).

  saved  the corpus summary at ai-triad-data b93a2dbc: chunked single-shot in 13 of 15 docs,
         same model as this run (sample.json was drawn so)
  new    re-extracted through Invoke-BatchSummary (default flags) on origin/main d3870ca2+
         (#3867 / t/4519, plus t/4553 / t/4554 / t/4555)

Same entry point and same mode as the saved summaries, so saved -> new is the registered
comparison. It is NOT a pure #3867 effect: everything else that changed the summary prompts or
retrieval between the saved run and d3870ca2 (t/4468 chunk RAG windows, t/4471 wording) is in it too.

  python measure.py sheet <data_repo> <new_data_root> <log_dir>
  python measure.py score

The blind sheet mixes new off-tag, saved off-tag and new on-tag key_points, shuffled with seed
44731. It shows camp, node label, point and verbatim only: no doc, no tag, no arm. Up to 30 items
per arm, at most 3 per doc per arm.
"""
import json
import os
import random
import re
import statistics
import subprocess
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CAMPS = ['accelerationist', 'safetyist', 'skeptic']
SEED = 44731
SAVED_REV = 'b93a2dbc'
SAMPLE = json.load(open(os.path.join(HERE, 'sample.json'), encoding='utf-8'))['sample']
ARMS = ('new_off', 'saved_off', 'new_on')


def kps_of(s):
    out = []
    for camp in CAMPS:
        for i, k in enumerate(((s.get('pov_summaries') or {}).get(camp) or {}).get('key_points') or []):
            out.append({'camp': camp, 'idx': i, 'node': k.get('taxonomy_node_id'), 'point': k.get('point'),
                        'verbatim': k.get('verbatim')})
    return out


def saved_summary(data_repo, doc):
    r = subprocess.run(['git', '-C', data_repo, 'show', f'{SAVED_REV}:summaries/{doc}.json'], capture_output=True)
    return json.loads(r.stdout.decode('utf-8')) if r.returncode == 0 else None


def node_labels(data):
    out = {}
    for f in ('accelerationist.json', 'safetyist.json', 'skeptic.json', 'situations.json'):
        p = os.path.join(data, 'taxonomy', 'Origin', f)
        if os.path.exists(p):
            for n in json.load(open(p, encoding='utf-8')).get('nodes', []):
                out[n.get('id')] = n.get('label')
    return out


def new_run(data, log_dir, doc, tag, saved):
    """One batch re-extraction: counts, path, calls, emptiness handling, or why there is no output."""
    lp = os.path.join(log_dir, f'{doc}.log')
    log = open(lp, encoding='utf-8', errors='replace').read() if os.path.exists(lp) else ''
    if not log:
        return {'status': 'not_run'}, None, []
    # Triage drops a doc marked duplicate_of, so -DocId finds nothing to run: not a pipeline failure.
    if re.search(r'Documents to reprocess : 0|No matching documents found', log):
        return {'status': 'skipped_by_triage', 'reason': 'duplicate_of set in metadata'}, None, []
    failed = re.search(r'RUN FAILED: (.*)', log)
    p = os.path.join(data, 'summaries', f'{doc}.json')
    s = json.load(open(p, encoding='utf-8'))
    mi = s.get('model_info') or {}
    # The data worktree holds the saved summary until the run overwrites it: never score an unwritten one.
    if failed or s.get('generated_at') == (saved or {}).get('generated_at'):
        return {'status': 'failed', 'failure': failed.group(1).strip() if failed else 'summary not rewritten'}, None, []
    k = kps_of(s)
    chunked = bool(re.search(r'Large document — using chunked pipeline', log))
    autofire = bool(re.search(r'AutoFire Stage 1: .* switching to FIRE', log))
    m = re.search(r'split into (\d+) chunks', log)
    chunk_calls = int(m.group(1)) if m else 0
    fire_calls = (mi.get('fire_stats') or {}).get('api_calls')
    calls = chunk_calls if chunked else (fire_calls or 1)
    empty = [c for c in CAMPS if not any(x['camp'] == c for x in k)]
    ec = s.get('empty_cells')
    declared = {e.get('camp') for e in (ec or []) if isinstance(e, dict)}
    spend = re.search(r'SPEND_USD: ([\d.]+)', log)
    return {
        'status': 'ok', 'path': 'chunked' if chunked else ('fire' if autofire else 'single_shot'),
        'extraction_mode': mi.get('extraction_mode'), 'calls': calls,
        'on': sum(x['camp'] == tag for x in k), 'off': sum(x['camp'] != tag for x in k),
        'empty_camps': empty, 'empty_cells_persisted': isinstance(ec, list),
        'empty_cells_n': len(ec) if isinstance(ec, list) else None,
        'empty_camps_undeclared': [c for c in empty if c not in declared],
        'tagged_empty': tag in empty,
        'tagged_empty_warn': bool(re.search(rf"tagged camp '{tag}' has 0 key_points", log)),
        'crash': bool(re.search(r'PropertyNotFound|cannot be found on this object|NullReference', log)),
        'spend_usd': float(spend.group(1)) if spend else None,
    }, s, k


def sheet(data_repo, new_data, log_dir):
    labels = node_labels(new_data)
    rows, per_doc = [], []
    for r in SAMPLE:
        d, tag = r['doc'], r['tag']
        saved = saved_summary(data_repo, d)
        ks = kps_of(saved) if saved else []
        smi = (saved or {}).get('model_info') or {}
        new, _, kn = new_run(new_data, log_dir, d, tag, saved)
        per_doc.append({'doc': d, 'tag': tag, 'chunked_saved': r['chunked'], 'saved_model': smi.get('model'),
                        'saved_mode': smi.get('extraction_mode'),
                        'saved_on': sum(x['camp'] == tag for x in ks), 'saved_off': sum(x['camp'] != tag for x in ks),
                        'new': new})
        for arm, src in (('new_off', [x for x in kn if x['camp'] != tag]),
                         ('saved_off', [x for x in ks if x['camp'] != tag] if new.get('status') == 'ok' else []),
                         ('new_on', [x for x in kn if x['camp'] == tag])):
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
        iid = f'C{n:02d}'
        key[iid] = {'arm': x['arm'], 'doc': x['doc'], 'camp': x['camp'], 'idx': x['idx']}
        sht.append({'id': iid, 'camp': x['camp'], 'node': x['node'], 'node_label': labels.get(x['node']),
                    'point': x['point'], 'verbatim': x['verbatim']})
    json.dump(per_doc, open(os.path.join(HERE, 'per_doc.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(sht, open(os.path.join(HERE, 'label_sheet.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(key, open(os.path.join(HERE, 'label_key.json'), 'w', encoding='utf-8'), indent=1)
    print(f'sheet {len(sht)} items; arms', {a: sum(k["arm"] == a for k in key.values()) for a in ARMS})


def pct(a, b):
    return f'{a}/{b} ({100 * a / b:.0f}%)' if b else f'{a}/0'


def score():
    per_doc = json.load(open(os.path.join(HERE, 'per_doc.json'), encoding='utf-8'))
    key = json.load(open(os.path.join(HERE, 'label_key.json'), encoding='utf-8'))
    labels = json.load(open(os.path.join(HERE, 'labels.json'), encoding='utf-8'))
    res = {}
    for arm in ARMS:
        ls = [labels[i] for i, k in key.items() if k['arm'] == arm and i in labels]
        res[arm] = {'n': len(ls), 'genuine': ls.count('genuine'), 'stretched': ls.count('stretched'),
                    'unsupported': ls.count('unsupported')}
        res[arm]['bad'] = res[arm]['stretched'] + res[arm]['unsupported']
    ok = [p for p in per_doc if p['new']['status'] == 'ok']
    ch = [p for p in ok if p['new']['path'] == 'chunked']
    changes = [(p['new']['on'] - p['saved_on']) / p['saved_on'] for p in ok if p['saved_on']]
    changes_ch = [(p['new']['on'] - p['saved_on']) / p['saved_on'] for p in ch if p['saved_on']]
    single = [p for p in ok if p['new']['path'] != 'chunked']
    off_new = sum(p['new']['off'] for p in ok)
    tot_new = sum(p['new']['off'] + p['new']['on'] for p in ok)
    off_saved = sum(p['saved_off'] for p in ok)
    tot_saved = sum(p['saved_off'] + p['saved_on'] for p in ok)
    summary = {
        'docs': {'sample': len(per_doc), 'ok': len(ok), 'chunked': len(ch),
                 'status': {p['doc']: p['new']['status'] for p in per_doc}},
        'labels': res,
        'off_tag_bad': pct(res['new_off']['bad'], res['new_off']['n']),
        'saved_off_tag_bad': pct(res['saved_off']['bad'], res['saved_off']['n']),
        'on_tag_genuine': pct(res['new_on']['genuine'], res['new_on']['n']),
        'on_tag_median_change_all': round(statistics.median(changes), 3) if changes else None,
        'on_tag_median_change_chunked': round(statistics.median(changes_ch), 3) if changes_ch else None,
        'on_tag_change_n': len(changes),
        'on_tag_saved_total': sum(p['saved_on'] for p in ok), 'on_tag_new_total': sum(p['new']['on'] for p in ok),
        'kp_median_saved': statistics.median([p['saved_on'] + p['saved_off'] for p in ok]) if ok else None,
        'kp_median_new': statistics.median([p['new']['on'] + p['new']['off'] for p in ok]) if ok else None,
        'calls_non_chunked': {p['doc']: (p['new']['path'], p['new']['calls']) for p in single},
        'empty_cells_persisted': f"{sum(p['new']['empty_cells_persisted'] for p in ok)}/{len(ok)}",
        'empty_camps': {p['doc']: p['new']['empty_camps'] for p in ok if p['new']['empty_camps']},
        'empty_camps_undeclared': {p['doc']: p['new']['empty_camps_undeclared'] for p in ok if p['new']['empty_camps_undeclared']},
        'tagged_empty': {p['doc']: p['new']['tagged_empty_warn'] for p in ok if p['new']['tagged_empty']},
        'crashes': [p['doc'] for p in per_doc if p['new'].get('crash') or p['new']['status'] == 'failed'],
        'skipped_by_triage': [p['doc'] for p in per_doc if p['new']['status'] == 'skipped_by_triage'],
        'off_tag_share_new': pct(off_new, tot_new), 'off_tag_share_saved': pct(off_saved, tot_saved),
        'spend_usd': round(sum(p['new'].get('spend_usd') or 0 for p in per_doc), 4),
    }
    json.dump(summary, open(os.path.join(HERE, 'results.json'), 'w', encoding='utf-8'), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    if sys.argv[1] == 'sheet':
        sheet(*sys.argv[2:5])
    else:
        score()
