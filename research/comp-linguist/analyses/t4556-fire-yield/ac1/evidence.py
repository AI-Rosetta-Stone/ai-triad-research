"""t/4556 AC1: attach source evidence to each blind sheet item for labelling.

Splits each snapshot into ~600-char passages and retrieves the top-2 by cosine
(all-MiniLM-L6-v2) for each item's point text. Writes evidence/<doc>.txt, one block per item,
in sheet order (already shuffled, no arm shown). The labeller judges genuine / stretched /
unsupported from these passages and does a full-text search when the passages are not decisive.
Also writes pairs.json: within each doc, the cross-item cosine for clustering equivalents.
"""
import json
import os
import re

import numpy as np
from sentence_transformers import SentenceTransformer

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = 'C:/Users/jsnov/repos/ai-triad-sources'
sheet = json.load(open(os.path.join(HERE, 'label_sheet.json'), encoding='utf-8'))
model = SentenceTransformer('all-MiniLM-L6-v2')
os.makedirs(os.path.join(HERE, 'evidence'), exist_ok=True)
pairs = {}
for doc in sorted({x['doc'] for x in sheet}):
    text = open(os.path.join(SRC, doc, 'snapshot.md'), encoding='utf-8').read()
    text = re.sub(r'!\[[^\]]*\]\(data:[^)]*\)', '', text)
    paras, buf = [], ''
    for para in re.split(r'\n\s*\n', text):
        buf = (buf + '\n' + para).strip()
        if len(buf) >= 600:
            paras.append(buf[:1200]); buf = ''
    if buf:
        paras.append(buf)
    pv = model.encode(paras, normalize_embeddings=True, batch_size=64, show_progress_bar=False)
    items = [x for x in sheet if x['doc'] == doc]
    qv = model.encode([x['point'] or '' for x in items], normalize_embeddings=True, show_progress_bar=False)
    with open(os.path.join(HERE, 'evidence', f'{doc}.txt'), 'w', encoding='utf-8') as f:
        for it, v in zip(items, qv):
            top = np.argsort(-(pv @ v))[:2]
            f.write(f"### {it['id']} [{it['camp']}/{it['category']}]\nPOINT: {it['point']}\n")
            for j in top:
                f.write(f"  > ({float(pv[j] @ v):.2f}) {paras[j][:500].replace(chr(10), ' ')}\n")
            f.write('\n')
    sim = qv @ qv.T
    pairs[doc] = [(items[i]['id'], items[j]['id'], round(float(sim[i, j]), 3))
                  for i in range(len(items)) for j in range(i + 1, len(items)) if sim[i, j] >= 0.6]
json.dump(pairs, open(os.path.join(HERE, 'pairs.json'), 'w', encoding='utf-8'), indent=1)
print('evidence written for', len(pairs), 'docs')
