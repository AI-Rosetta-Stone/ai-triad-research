"""t/4473: precision check for a positional-coverage retry.

Flags docs with an uncovered run of >= 2 consecutive 2,500-word windows (the final window is
ignored), samples 15 flagged docs with a fixed seed, and prints 120 words from the middle of
the first uncovered window, so the labeller can judge whether the gap holds claims the
extraction missed. Writes gap_sample.json. Read-only.
Usage: python gap_sample.py <data_root> <sources_root>
"""
import json
import os
import random
import re
import sys

DATA, SOURCES = sys.argv[1], sys.argv[2]
CAMPS = ['accelerationist', 'safetyist', 'skeptic']
W, R, N, SEED = 2500, 2, 15, 4473


def toks(s):
    return re.sub(r'[^\w\s]', ' ', s.lower()).split()


def find(words, q):
    if len(q) < 5:
        return -1
    q = q[:8]
    for i, w in enumerate(words):
        if w == q[0] and words[i:i + len(q)] == q:
            return i
    return -1


def snapshot(doc):
    p = os.path.join(SOURCES, doc, 'snapshot.md')
    return re.sub(r'!\[[^\]]*\]\(data:[^)]*\)', '', open(p, encoding='utf-8', errors='replace').read())


flagged = []
for fn in sorted(os.listdir(os.path.join(DATA, 'summaries'))):
    if not fn.endswith('.json'):
        continue
    doc = fn[:-5]
    if not os.path.exists(os.path.join(SOURCES, doc, 'snapshot.md')):
        continue
    try:
        s = json.load(open(os.path.join(DATA, 'summaries', fn), encoding='utf-8'))
    except Exception:
        continue
    words = toks(snapshot(doc))
    nwin = -(-len(words) // W)
    if nwin < R + 1:
        continue
    cov = set()
    for c in CAMPS:
        for kp in ((s.get('pov_summaries') or {}).get(c) or {}).get('key_points') or []:
            v = kp.get('verbatim') or ''
            if isinstance(v, list):
                v = v[0] if v else ''
            i = find(words, toks(str(v)))
            if i >= 0:
                cov.add(i // W)
    run, start = 0, None
    for k in range(nwin - 1):
        if k in cov:
            run = 0
            continue
        run += 1
        if run >= R:
            start = k - run + 1
            break
    if start is not None:
        flagged.append((doc, len(words), start))

rng = random.Random(SEED)
sample = rng.sample(flagged, min(N, len(flagged)))
out = []
for n, (doc, nw, start) in enumerate(sample, 1):
    plain = snapshot(doc).split()
    mid = start * W + W // 2
    excerpt = ' '.join(plain[mid:mid + 120])
    out.append({'id': f'G{n:02d}', 'doc': doc, 'words': nw, 'window': start, 'excerpt': excerpt})
    print(f'G{n:02d} {doc} ({nw} words, window {start})\n  {excerpt[:900]}\n')
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gap_sample.json'), 'w', encoding='utf-8'), indent=1)
print(f'flagged {len(flagged)}; sampled {len(out)}')
