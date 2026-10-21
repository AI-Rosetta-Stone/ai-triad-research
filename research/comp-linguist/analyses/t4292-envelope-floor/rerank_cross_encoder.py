"""t/4292 step 2: offline cross-encoder rerank of the grounding envelope's per-camp candidates.

Question: does a relevance cross-encoder demote the labelled-bad nodes (q2 acc off-topic, q3 saf generic)
out of the top 3 without displacing on-topic ones? Offline, no model spend.

Method:
  1. Re-derive the production cosine ranking (all-MiniLM-L6-v2 query vector vs embeddings.json node
     vectors) and CHECK that its top 3 equals the production selection recorded in scores.json. A
     mismatch is reported, not assumed away.
  2. Take the top-K (10) cosine candidates per question x camp.
  3. Score (question, "label. description") with cross-encoder/ms-marco-MiniLM-L-6-v2, re-sort, take top 3.
  4. Report the labelled-bad nodes' ranks before/after and the top-3 churn across all 45 camp sets.

Run (offline; models must already be in the HF cache):
  HF_HUB_OFFLINE=1 python research/comp-linguist/analyses/t4292-envelope-floor/rerank_cross_encoder.py
"""
import json
import os
import sys

import numpy as np
from sentence_transformers import CrossEncoder, SentenceTransformer

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.environ.get('AI_TRIAD_DATA_ROOT', os.path.join(HERE, '..', '..', '..', '..', '..', '..', 'ai-triad-data'))
TAX = os.path.join(DATA_ROOT, 'taxonomy', 'Origin')
POV_FILES = {'acc': 'accelerationist.json', 'saf': 'safetyist.json', 'skp': 'skeptic.json'}
K = 10
TOP_N = 3
BAD = {('q2', 'acc'): {'acc-intentions-127', 'acc-intentions-071'},
       ('q3', 'saf'): {'saf-beliefs-206', 'saf-desires-001'}}


def main() -> None:
    if not os.path.isdir(TAX):
        sys.exit(f'Data root not found: {TAX} (set AI_TRIAD_DATA_ROOT)')
    questions = json.load(open(os.path.join(HERE, 'questions.json'), encoding='utf-8'))
    recorded = {q['id']: q for q in json.load(open(os.path.join(HERE, 'scores.json'), encoding='utf-8'))}
    emb = json.load(open(os.path.join(TAX, 'embeddings.json'), encoding='utf-8'))['nodes']

    nodes = {}
    for camp, fname in POV_FILES.items():
        for n in json.load(open(os.path.join(TAX, fname), encoding='utf-8'))['nodes']:
            if n['id'] in emb and emb[n['id']].get('vector'):
                nodes[n['id']] = (camp, n.get('label', ''), n.get('description', ''))
    ids = list(nodes)
    mat = np.array([emb[i]['vector'] for i in ids], dtype=np.float32)
    mat /= np.linalg.norm(mat, axis=1, keepdims=True)
    camp_of = np.array([nodes[i][0] for i in ids])

    bi = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
    ce = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')

    out, mismatches, churn, bad_report = [], 0, 0, []
    for q in questions:
        qv = bi.encode([q['text']], normalize_embeddings=True)[0]
        cos = mat @ qv
        row = {'id': q['id'], 'kind': q['kind'], 'camps': {}}
        for camp in POV_FILES:
            idx = np.where(camp_of == camp)[0]
            order = idx[np.argsort(-cos[idx])][:K]
            cand = [ids[i] for i in order]
            prod = [s['id'] for s in recorded[q['id']]['camps'][camp]['selected']]
            # Production dedupes duplicate labels (t/4352, merged after scores.json was recorded), so
            # compare against the label-deduped cosine top 3 as well as the raw one.
            seen, dedup = set(), []
            for c in cand:
                lab = nodes[c][1].strip().lower()
                if lab in seen:
                    continue
                seen.add(lab)
                dedup.append(c)
            match = cand[:TOP_N] == prod or dedup[:TOP_N] == prod
            if not match:
                mismatches += 1
            ce_scores = ce.predict([(q['text'], f'{nodes[c][1]}. {nodes[c][2]}') for c in dedup])
            reranked = [c for _, c in sorted(zip(ce_scores, dedup), key=lambda t: -t[0])]
            ce_of = dict(zip(dedup, (float(s) for s in ce_scores)))
            changed = set(reranked[:TOP_N]) != set(dedup[:TOP_N])
            churn += changed
            row['camps'][camp] = {
                'cosine_top3': dedup[:TOP_N], 'rerank_top3': reranked[:TOP_N],
                'matches_production': match, 'top3_changed': changed,
                'candidates': [{'id': c, 'label': nodes[c][1], 'cos': round(float(cos[ids.index(c)]), 3),
                                'ce': round(ce_of[c], 3), 'cos_rank': dedup.index(c) + 1,
                                'ce_rank': reranked.index(c) + 1} for c in dedup],
            }
            for bad in BAD.get((q['id'], camp), ()):
                bad_report.append({'q': q['id'], 'camp': camp, 'id': bad,
                                   'cos_rank': dedup.index(bad) + 1 if bad in dedup else None,
                                   'ce_rank': reranked.index(bad) + 1 if bad in reranked else None})
        out.append(row)

    json.dump(out, open(os.path.join(HERE, 'rerank.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(f'production-match: {45 - mismatches}/45   top-3 changed by rerank: {churn}/45')
    for b in bad_report:
        print('BAD', b)
    for row in out:
        for camp, r in row['camps'].items():
            if r['top3_changed']:
                print(f"\n{row['id']} {camp}  cos={r['cosine_top3']}  ->  ce={r['rerank_top3']}")
                for c in r['candidates']:
                    print(f"   cos#{c['cos_rank']:>2} ce#{c['ce_rank']:>2} cos={c['cos']:.3f} ce={c['ce']:+.2f}  {c['id']}  {c['label']}")


if __name__ == '__main__':
    main()
