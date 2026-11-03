"""t/4473 spec §5 step 1: draw the 15-document re-extraction sample.

Population: documents with exactly one camp in metadata pov_tags whose saved summary is
extraction_mode single_shot (chunked or not: this is the §2 "single-shot" population of 288),
whose saved model is still in ai-models.json (retired preview/-latest ids are excluded rather
than substituted), and which are not in the §2 label sheet. Shuffled with the kp_sample.py
seed (4473); the first 15 are taken.

Usage: python sample_docs.py <data_root> <sources_root> <ai-models.json>
Writes sample.json next to this script.
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA, SOURCES, MODELS = sys.argv[1:4]
CAMPS = ['accelerationist', 'safetyist', 'skeptic']
SEED = 4473
N = 15

reg = json.load(open(MODELS, encoding='utf-8'))
reg = reg.get('models', reg)
available = {m.get('id') for m in reg} if isinstance(reg, list) else set(reg)
labelled = {v['doc'] for v in json.load(open(os.path.join(HERE, '..', 'label_key.json'), encoding='utf-8')).values()}

pool = []
for fn in sorted(os.listdir(os.path.join(DATA, 'summaries'))):
    if not fn.endswith('.json'):
        continue
    doc = fn[:-5]
    meta_p = os.path.join(SOURCES, doc, 'metadata.json')
    if doc in labelled or not os.path.exists(meta_p) or not os.path.exists(os.path.join(SOURCES, doc, 'snapshot.md')):
        continue
    try:
        s = json.load(open(os.path.join(DATA, 'summaries', fn), encoding='utf-8'))
    except Exception:
        continue
    mi = s.get('model_info') or {}
    tags = [t for t in (json.load(open(meta_p, encoding='utf-8')).get('pov_tags') or []) if t in CAMPS]
    if len(tags) != 1 or mi.get('extraction_mode') != 'single_shot':
        continue
    if mi.get('model') not in available:
        continue
    pool.append({'doc': doc, 'tag': tags[0], 'model': mi.get('model'), 'temperature': mi.get('temperature', 0.1),
                 'chunked': bool(mi.get('chunked')), 'chunk_count': mi.get('chunk_count')})

rng = random.Random(SEED)
rng.shuffle(pool)
sample = pool[:N]
json.dump({'population': len(pool), 'seed': SEED, 'sample': sample},
          open(os.path.join(HERE, 'sample.json'), 'w', encoding='utf-8'), indent=1)
print(f'population {len(pool)}; sampled {len(sample)}')
for r in sample:
    print(r)
