"""t/4880 probe: does point-to-node cosine similarity separate genuine from bad labels?

Reads the labelled t/4603 and t/4742 sheets (git, origin/main) and the live taxonomy.
Read-only; no writes outside stdout.
"""
import json, subprocess, os
from sentence_transformers import SentenceTransformer, util

REPO = r'C:\Users\jsnov\repos\ai-triad-research'
TAX = r'C:\Users\jsnov\repos\ai-triad-data\taxonomy\Origin'
D = 'analyses/t4603-camp-bridge/'

def show(path):
    out = subprocess.run(['git', '-C', REPO, 'show', f'origin/main:{path}'], capture_output=True, check=True)
    return json.loads(out.stdout.decode('utf-8'))

nodes = {}
for f in ('accelerationist.json', 'safetyist.json', 'skeptic.json', 'situations.json'):
    d = json.load(open(os.path.join(TAX, f), encoding='utf-8'))
    for n in (d['nodes'] if isinstance(d, dict) else d):
        nodes[n['id']] = f"{n.get('label', '')}. {n.get('description', '')}"

items = []
for sfx in ('', '_t4603'):
    sheet, key, lab = show(D + f'label_sheet{sfx}.json'), show(D + f'label_key{sfx}.json'), show(D + f'labels{sfx}.json')
    for it in sheet:
        if it['node'] in nodes:
            items.append((sfx or '_t4742', key[it['id']]['arm'], it['id'], it['point'], nodes[it['node']], lab[it['id']]))
missing = sum(1 for sfx in ('', '_t4603') for it in show(D + f'label_sheet{sfx}.json') if it['node'] not in nodes)

m = SentenceTransformer('all-MiniLM-L6-v2')
P = m.encode([i[3] for i in items], convert_to_tensor=True, batch_size=64)
N = m.encode([i[4] for i in items], convert_to_tensor=True, batch_size=64)
sims = util.cos_sim(P, N).diagonal().tolist()

def auc(pos, neg):
    # P(score_genuine > score_bad), ties = 0.5
    if not pos or not neg:
        return None
    w = sum((p > q) + 0.5 * (p == q) for p in pos for q in neg)
    return w / (len(pos) * len(neg))

for name, sel in (('all', lambda a: True), ('off-tag', lambda a: a.endswith('_off')), ('new_off', lambda a: a == 'new_off')):
    g = [s for s, i in zip(sims, items) if sel(i[1]) and i[5] == 'genuine']
    b = [s for s, i in zip(sims, items) if sel(i[1]) and i[5] != 'genuine']
    med = lambda x: sorted(x)[len(x) // 2] if x else None
    print(f"{name:8s} n_genuine={len(g)} n_bad={len(b)} median_g={med(g):.3f} median_b={med(b):.3f} AUC={auc(g, b):.3f}")
print('items without a resolvable node (excluded):', missing)
json.dump([dict(round=i[0], arm=i[1], id=i[2], label=i[5], sim=round(s, 4)) for s, i in zip(sims, items)],
          open(os.path.join(os.path.dirname(__file__), 't4880_sims.json'), 'w'), indent=1)
