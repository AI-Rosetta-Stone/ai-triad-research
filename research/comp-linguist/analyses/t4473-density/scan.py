"""t/4473 baseline: what the density floors do to the current summary corpus.

For every summary in ai-triad-data/summaries, recompute the floors the pipeline applies
(Get-DensityFloors / Test-SummaryDensity in scripts/AITriad/Private/Invoke-DocumentSummary.ps1)
from the source snapshot's word count, and measure:
  - which floor checks the FINAL output still fails (single-shot accepts an under-dense
    result after one retry, so a failing final output means the retry fired and didn't help);
  - off-tag key_points: points in a camp the document's metadata pov_tags don't name;
  - section coverage: share of '##' sections in the snapshot that at least one key_point's
    verbatim quote (or excerpt_context "Section: ...") lands in.

Read-only. Writes scan_results.json next to this file.
Usage: python scan.py [data_root] [sources_root]
(the defaults assume the main checkout; pass both roots when running from a worktree)
"""
import json
import os
import re
import sys
from collections import Counter
from statistics import median

HERE = os.path.dirname(os.path.abspath(__file__))
REPOS = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..', '..'))
DATA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPOS, 'ai-triad-data')
SOURCES = sys.argv[2] if len(sys.argv) > 2 else os.path.join(REPOS, 'ai-triad-sources')
CAMPS = ['accelerationist', 'safetyist', 'skeptic']
CATS = ['Beliefs', 'Desires', 'Intentions']


def floors(wc):
    kp = max(3, wc // 500)
    return {'kp_min': kp, 'uc_min': max(2, wc // 2000), 'total': max(6, kp * 2)}


def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', s.lower())).strip()


def sections(text):
    """[(start_offset_in_normalized_text, heading)] for '#'/'##' headings."""
    out, pos = [], 0
    buf = []
    for line in text.splitlines():
        m = re.match(r'^(#{1,3})\s+(.*)', line)
        if m:
            out.append((len(norm(' '.join(buf))), m.group(2).strip()))
        buf.append(line)
    return out


def locate(verbatim, ntext):
    if isinstance(verbatim, list):  # some summaries store verbatim as a list of spans
        verbatim = verbatim[0] if verbatim else ''
    v = norm(str(verbatim))
    if not v:
        return -1
    i = ntext.find(v)
    if i >= 0:
        return i
    # fall back to the first 8 words (verbatim quotes are often lightly trimmed)
    head = ' '.join(v.split()[:8])
    return ntext.find(head) if len(head.split()) >= 5 else -1


def main():
    rows = []
    sdir = os.path.join(DATA, 'summaries')
    for fn in sorted(os.listdir(sdir)):
        if not fn.endswith('.json'):
            continue
        doc = fn[:-5]
        try:
            s = json.load(open(os.path.join(sdir, fn), encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(s, dict) or 'pov_summaries' not in s:
            continue
        snap = os.path.join(SOURCES, doc, 'snapshot.md')
        meta = os.path.join(SOURCES, doc, 'metadata.json')
        if not os.path.exists(snap):
            continue
        text = open(snap, encoding='utf-8', errors='replace').read()
        text = re.sub(r'!\[[^\]]*\]\(data:[^)]*\)', '', text)  # inline base64 images (t/4386)
        wc = len(text.split())
        tags = []
        if os.path.exists(meta):
            m = json.load(open(meta, encoding='utf-8'))
            tags = [t for t in (m.get('pov_tags') or []) if t in CAMPS]
        mi = s.get('model_info') or {}
        mode = mi.get('extraction_mode') or ('chunked' if mi.get('chunk_count') else 'single')
        f = floors(wc)
        ps = s.get('pov_summaries') or {}
        per = {c: len((ps.get(c) or {}).get('key_points') or []) for c in CAMPS}
        total = sum(per.values())
        ec = {(e.get('camp'), e.get('category')) for e in (s.get('empty_cells') or []) if isinstance(e, dict)}
        zero_undeclared = [c for c in CAMPS if per[c] == 0 and not all((c, k) in ec for k in CATS)]
        uc = len(s.get('unmapped_concepts') or [])
        fails = []
        if total < f['total']:
            fails.append('total')
        if zero_undeclared:
            fails.append('zero_camp')
        if uc < f['uc_min']:
            fails.append('uc')
        # sections
        ntext = norm(text)
        secs = sections(text)
        covered = set()
        located = 0
        kps = [kp for c in CAMPS for kp in ((ps.get(c) or {}).get('key_points') or [])]
        for kp in kps:
            i = locate(kp.get('verbatim') or '', ntext)
            if i >= 0:
                located += 1
                idx = max((j for j, (off, _) in enumerate(secs) if off <= i), default=None)
                if idx is not None:
                    covered.add(idx)
        rows.append({
            'doc': doc, 'mode': mode, 'wc': wc, 'tags': tags, 'per_camp': per, 'total': total,
            'floors': f, 'uc': uc, 'fails': fails, 'n_empty_cells': len(ec),
            'off_tag': sum(per[c] for c in CAMPS if tags and c not in tags),
            'n_sections': len(secs), 'sections_covered': len(covered),
            'kp_located': located, 'n_kp': len(kps),
        })

    out = os.path.join(HERE, 'scan_results.json')
    json.dump(rows, open(out, 'w', encoding='utf-8'), indent=1)

    n = len(rows)
    print(f'summaries scanned: {n}')
    print('modes:', dict(Counter(r['mode'] for r in rows)))
    print('wc median', median(r['wc'] for r in rows), ' total-floor median', median(r['floors']['total'] for r in rows))
    for mode in sorted({r['mode'] for r in rows}):
        rs = [r for r in rows if r['mode'] == mode]
        c = Counter(x for r in rs for x in r['fails'])
        print(f'[{mode}] n={len(rs)} final output still fails: any={sum(1 for r in rs if r["fails"])}', dict(c))
    tagged = [r for r in rows if r['tags']]
    kp_t = sum(r['total'] for r in tagged)
    off = sum(r['off_tag'] for r in tagged)
    print(f'tagged docs {len(tagged)}/{n}; key_points in untagged camps {off}/{kp_t} ({off / max(kp_t, 1):.1%})')
    one = [r for r in tagged if len(r['tags']) == 1]
    print(f'single-tag docs {len(one)}: off-tag kp {sum(r["off_tag"] for r in one)}/{sum(r["total"] for r in one)}')
    print('docs with any empty_cells:', sum(1 for r in rows if r['n_empty_cells']))
    sec = [r for r in rows if r['n_sections'] >= 2 and r['n_kp']]
    loc = sum(r['kp_located'] for r in sec) / max(sum(r['n_kp'] for r in sec), 1)
    cov = [r['sections_covered'] / r['n_sections'] for r in sec]
    print(f'docs with >=2 sections: {len(sec)}; verbatim located {loc:.1%}; median section coverage {median(cov):.2f}; '
          f'docs with full coverage {sum(1 for x in cov if x >= 1)}')
    big = [r for r in rows if r['wc'] >= 5000]
    print(f'docs >=5000 words: {len(big)}; total floor fails {sum(1 for r in big if "total" in r["fails"])}')


if __name__ == '__main__':
    main()
