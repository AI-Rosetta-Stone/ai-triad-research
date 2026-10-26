"""t/4475: precision per cosine band for the 29 org->POV-node proposals (CL labels), plus
per-org claim-pool size. proposals.json was extracted from ai-triad-data origin/main
b93a2dbc taxonomy/Origin/organization_edges.json (all 29 POV-node edges, status=proposed).
Usage: python bands.py"""
import json, os
from collections import Counter, defaultdict
H = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(H, 'proposals.json')))
L = json.load(open(os.path.join(H, 'labels.json')))
def band(c):
    return '<0.60' if c < 0.60 else '0.60-0.65' if c < 0.65 else '0.65-0.70' if c < 0.70 else '>=0.70'
b = defaultdict(Counter); o = defaultdict(Counter)
for p in P:
    b[band(p['cos'])][L[p['id']]] += 1
    o[p['source']][L[p['id']]] += 1
print('| Band | n | Y | P | N |')
for k in ('<0.60', '0.60-0.65', '0.65-0.70', '>=0.70'):
    c = b[k]; print(f"| {k} | {sum(c.values())} | {c['Y']} | {c['P']} | {c['N']} |")
t = Counter(L[p['id']] for p in P); print('total', dict(t))
print('per org', {k: dict(v) for k, v in o.items()})
