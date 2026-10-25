"""t/4471 offline check: does restoring a dropped specific referent hurt node matching?

For 11 key_points whose canonical_proposition turned a claim ABOUT a specific
instrument into a generic one, a CL rewrite restores the referent with minimal
change. Measure the assigned node's rank (POV+BDI pool, production embedder)
for original vs anchored. Constructed rewrites; observed assignments.
"""
import json, os, re
import numpy as np
from sentence_transformers import SentenceTransformer

import sys

# Usage:  python anchored.py <ai-triad-data>
DATA = sys.argv[1]
S = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "elide_sample.json"), encoding="utf-8"))
ANCHORED = {
    0: "Implement California's AB 1405 state registry of independent AI auditors to replace corporate self-assessment and enforce accountability.",
    2: "The EU Digital Services Act requires major platforms to conduct annual systemic risk assessments and adopt proportionate mitigation measures for risks like minor protection.",
    5: "Mandate comprehensive Scope 1-3 emissions reporting for AI infrastructure by expanding regulatory frameworks such as the EU AI Act.",
    7: "Enforce FTC Act Section 5 deception authority to penalize AI companies that covertly steer system outputs away from user expectations.",
    8: "Operationalize AI governance enforcement through the Texas Attorney General's exclusive authority under TRAIGA while excluding private rights of action.",
    10: "Achieve robust AI safety oversight by expanding the EU Product Liability Directive to encompass software updates and machine learning adaptations.",
    11: "The FTC ought to enforce uniform dual disclosure standards for all AI-generated advertising and synthetic media content.",
    14: "Manual spreadsheet record-keeping fails to prove systematic NIST AI RMF implementation under TRAIGA, creating substantial audit vulnerability.",
    18: "China-based AI companies systematically extract proprietary capabilities from U.S. models through high-volume API querying to compress development cycles.",
    20: "China-based AI companies exploit API proxy gray markets and legal asymmetries to evade U.S. providers' regional restrictions and oversight.",
    22: "Frontier AI risks can cause irreversible harm, so EU AI Act Article 62 mandates statutory reporting of serious incidents to national authorities.",
}
NODE_RE = re.compile(r"^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$")
emb = json.load(open(os.path.join(DATA, "taxonomy", "Origin", "embeddings.json"), encoding="utf-8"))
ids = [n for n in emb["nodes"] if NODE_RE.match(n)]
mat = np.asarray([emb["nodes"][n]["vector"] for n in ids], dtype=np.float32)
mat /= np.linalg.norm(mat, axis=1, keepdims=True)
model = SentenceTransformer(emb.get("model", "all-MiniLM-L6-v2"), trust_remote_code=False)


def rank(text, node):
    q = model.encode([text], normalize_embeddings=True)[0]
    pov, bdi = node.split("-")[0], node.split("-")[1]
    pool = [i for i, n in enumerate(ids) if n.startswith(f"{pov}-{bdi}-")]
    s = mat[pool] @ q
    j = pool.index(ids.index(node))
    return int((s > s[j]).sum()) + 1, float(s[j])


rows = []
for i, anchored in ANCHORED.items():
    x = S[i]
    r0, c0 = rank(x["cp"], x["node"])
    r1, c1 = rank(anchored, x["node"])
    rows.append((i, x["node"], r0, r1, round(c0, 3), round(c1, 3)))
    print(f"E{i:02d} {x['node']:22s} rank {r0:>3} -> {r1:>3}   cos {c0:.3f} -> {c1:.3f}")
better = sum(1 for r in rows if r[3] < r[2]); worse = sum(1 for r in rows if r[3] > r[2])
print(f"n={len(rows)}  better={better} worse={worse} same={len(rows)-better-worse}  "
      f"median rank {np.median([r[2] for r in rows])} -> {np.median([r[3] for r in rows])}  "
      f"mean cos delta {np.mean([r[5]-r[4] for r in rows]):+.3f}")
