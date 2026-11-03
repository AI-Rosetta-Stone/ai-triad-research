"""t/4473 §5 isolation guard (the t/4471 near-miss check).

The real ai-triad-data and ai-triad-sources checkouts are shared and already carry other
agents' uncommitted work, so "clean" here means: nothing this run could write has changed.
Hashes every real summaries/<doc>.json, every real sources/<doc>/ file for the sample, and
sources _index.json, plus the full `git status --porcelain` of both repos.

  python isolation_check.py snap <out.json>     record the baseline
  python isolation_check.py check <base.json>   exit 1 (and print the diff) if anything moved
"""
import hashlib
import json
import os
import subprocess
import sys

DATA = 'C:/Users/jsnov/repos/ai-triad-data'
SOURCES = 'C:/Users/jsnov/repos/ai-triad-sources'
HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = [r['doc'] for r in json.load(open(os.path.join(HERE, 'sample.json'), encoding='utf-8'))['sample']]


def h(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest() if os.path.exists(p) else None


def state():
    out = {'_index.json': h(os.path.join(SOURCES, '_index.json'))}
    for d in DOCS:
        out[f'summaries/{d}.json'] = h(os.path.join(DATA, 'summaries', f'{d}.json'))
        root = os.path.join(SOURCES, d)
        for dp, _, fns in os.walk(root):
            for fn in fns:
                p = os.path.join(dp, fn)
                out['sources/' + os.path.relpath(p, SOURCES).replace('\\', '/')] = h(p)
    for name, repo in (('data', DATA), ('sources', SOURCES)):
        st = subprocess.run(['git', '-C', repo, 'status', '--porcelain'], capture_output=True, text=True).stdout
        out[f'status:{name}'] = sorted(st.splitlines())
    return out


if sys.argv[1] == 'snap':
    json.dump(state(), open(sys.argv[2], 'w', encoding='utf-8'), indent=1)
    print('baseline recorded')
else:
    base, now = json.load(open(sys.argv[2], encoding='utf-8')), state()
    moved = [k for k in set(base) | set(now) if not k.startswith('status:') and base.get(k) != now.get(k)]
    for name in ('data', 'sources'):
        new = sorted(set(now[f'status:{name}']) - set(base[f'status:{name}']))
        # Other agents write debates/chats/analytics concurrently; any new entry touching
        # summaries/ or a sample doc is ours and fatal, anything else is reported only.
        ours = [l for l in new if 'summaries/' in l or '_index.json' in l or any(d in l for d in DOCS)]
        moved += [f'{name}: {l}' for l in ours]
        if new and not ours:
            print(f'note: {name} gained unrelated entries (concurrent agents): {new[:5]}')
    if moved:
        print('ISOLATION BREACH:', moved)
        sys.exit(1)
    print('isolation OK: real repos unchanged for every path this run can write')
