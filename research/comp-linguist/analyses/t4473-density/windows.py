"""t/4473: positional coverage. Split each snapshot into W-word windows; a window is covered
when a key_point verbatim locates inside it. Reports, per window size, the share of docs with
an uncovered run of >= R consecutive windows, ignoring the final window (reference lists,
bios and boilerplate cluster at the end). Read-only.
Usage: python windows.py <data_root> <sources_root>"""
import json, os, re, sys
from statistics import median
DATA, SOURCES = sys.argv[1], sys.argv[2]
CAMPS = ['accelerationist', 'safetyist', 'skeptic']

def toks(s):
    return re.sub(r'[^\w\s]', ' ', s.lower()).split()

def find(words, q):
    if len(q) < 5:
        return -1
    q = q[:8]
    first = q[0]
    for i, w in enumerate(words):
        if w == first and words[i:i + len(q)] == q:
            return i
    return -1

rows = []
for fn in sorted(os.listdir(os.path.join(DATA, 'summaries'))):
    if not fn.endswith('.json'):
        continue
    doc = fn[:-5]
    snap = os.path.join(SOURCES, doc, 'snapshot.md')
    if not os.path.exists(snap):
        continue
    try:
        s = json.load(open(os.path.join(DATA, 'summaries', fn), encoding='utf-8'))
    except Exception:
        continue
    text = re.sub(r'!\[[^\]]*\]\(data:[^)]*\)', '', open(snap, encoding='utf-8', errors='replace').read())
    words = toks(text)
    pos = []
    for c in CAMPS:
        for kp in ((s.get('pov_summaries') or {}).get(c) or {}).get('key_points') or []:
            v = kp.get('verbatim') or ''
            if isinstance(v, list):
                v = v[0] if v else ''
            i = find(words, toks(str(v)))
            if i >= 0:
                pos.append(i)
    rows.append((doc, (s.get('model_info') or {}).get('extraction_mode'), len(words), pos))

for W in (1000, 1500, 2500):
    for R in (1, 2, 3):
        flagged = n = 0
        for doc, mode, nw, pos in rows:
            nwin = max(1, -(-nw // W))
            if nwin < R + 1:
                continue
            n += 1
            cov = {p // W for p in pos}
            run = best = 0
            for k in range(nwin - 1):  # ignore the final window
                run = 0 if k in cov else run + 1
                best = max(best, run)
            flagged += best >= R
        print(f'W={W} R={R}: docs eligible {n}, would retry {flagged} ({flagged / max(n, 1):.0%})')
