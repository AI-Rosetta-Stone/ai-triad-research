"""t/4472: sample within-document pairs for calibrating the Merge-ChunkSummaries semantic-dedup threshold.

Read-only over the summaries corpus. Builds every within-scope pair, embeds with the production embedder
(all-MiniLM-L6-v2, normalized), and draws a band-stratified sample for blind labelling:
  - key_points: same doc, same (camp, BDI category); text = canonical_proposition
  - factual_claims: same doc (global scope, as the spec proposes); text = claim

Multi-chunk documents (model_info.chunk_count > 1) are preferred: 2/3 of each band's draw comes from them when
enough exist, because cross-chunk duplicates are what Merge-ChunkSummaries sees.

Writes:
  population.json  pair counts per band and type (for prevalence-weighted P/R)
  label_sheet.json blind sheet: pair id + texts only, shuffled (no cosine, no band)
  label_key.json   pair id -> type, cosine, band, doc, chunked

Usage: python sample_pairs.py <data_root> <out_dir>
"""
import glob
import json
import os
import random
import sys
from collections import Counter, defaultdict

import numpy as np
from sentence_transformers import SentenceTransformer

ROOT, OUT = sys.argv[1:3]
SEED = 4472
BANDS = [(0.60, 0.70), (0.70, 0.75), (0.75, 0.80), (0.80, 0.85), (0.85, 0.90), (0.90, 0.95), (0.95, 1.01)]
PER_BAND = 10
CAMPS = ("accelerationist", "safetyist", "skeptic")


def band_of(c):
    for lo, hi in BANDS:
        if lo <= c < hi:
            return f"{lo:.2f}-{min(hi, 1.0):.2f}"
    return None


def chunk_count(s):
    mi = s.get("model_info") or {}
    try:
        return int(mi.get("chunk_count") or 0)
    except (TypeError, ValueError):
        return 0


kp_groups, fc_groups = defaultdict(list), defaultdict(list)
chunked, missing_cp = set(), 0
for f in sorted(glob.glob(os.path.join(ROOT, "summaries", "*.json"))):
    s = json.load(open(f, encoding="utf-8"))
    d = s.get("doc_id") or os.path.basename(f)[:-5]
    if chunk_count(s) > 1:
        chunked.add(d)
    for camp, b in (s.get("pov_summaries") or {}).items():
        if camp not in CAMPS or not isinstance(b, dict):
            continue
        for k in b.get("key_points") or []:
            cp = (k.get("canonical_proposition") or "").strip()
            if not cp:
                missing_cp += 1
                continue
            cat = str(k.get("category") or "").lower()
            kp_groups[(d, camp, cat)].append(dict(text=cp, anchors=k.get("anchors") or [], node=k.get("taxonomy_node_id")))
    for c in s.get("factual_claims") or []:
        t = (c.get("claim") or "").strip()
        if t:
            fc_groups[d].append(dict(text=t, label=c.get("claim_label")))

model = SentenceTransformer("all-MiniLM-L6-v2")


def all_pairs(groups, kind):
    items = [(g, i, it) for g, lst in groups.items() if len(lst) > 1 for i, it in enumerate(lst)]
    texts = sorted({it["text"] for _, _, it in items})
    vec = dict(zip(texts, model.encode(texts, normalize_embeddings=True, batch_size=128, show_progress_bar=True)))
    out = []
    for g, lst in groups.items():
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                a, b = lst[i], lst[j]
                if a["text"] == b["text"]:
                    cos = 1.0
                else:
                    cos = float(np.dot(vec[a["text"]], vec[b["text"]]))
                doc = g[0] if isinstance(g, tuple) else g
                out.append(dict(kind=kind, doc=doc, group=list(g) if isinstance(g, tuple) else [g], cos=round(cos, 4),
                                band=band_of(cos), chunked=doc in chunked, a=a, b=b))
    return out


rng = random.Random(SEED)
population, sample = {}, []
for kind, groups in (("key_point", kp_groups), ("factual_claim", fc_groups)):
    pairs = all_pairs(groups, kind)
    population[kind] = {
        "pairs_total": len(pairs),
        "by_band": dict(sorted(Counter(p["band"] for p in pairs if p["band"]).items())),
        "below_0.60": sum(1 for p in pairs if p["band"] is None),
        "by_band_chunked": dict(sorted(Counter(p["band"] for p in pairs if p["band"] and p["chunked"]).items())),
    }
    for lo, hi in BANDS:
        name = band_of(lo)
        inb = [p for p in pairs if p["band"] == name]
        ch = [p for p in inb if p["chunked"]]
        un = [p for p in inb if not p["chunked"]]
        rng.shuffle(ch)
        rng.shuffle(un)
        want_ch = min(len(ch), (PER_BAND * 2 + 2) // 3)
        pick = ch[:want_ch] + un[:PER_BAND - want_ch]
        if len(pick) < PER_BAND:
            pick += ch[want_ch:want_ch + PER_BAND - len(pick)]
        sample += pick

population["docs_chunked"] = len(chunked)
population["key_points_without_canonical_proposition"] = missing_cp
rng.shuffle(sample)
sheet, key = [], {}
for n, p in enumerate(sample, 1):
    pid = f"P{n:03d}"
    row = dict(id=pid, kind=p["kind"], a=p["a"]["text"], b=p["b"]["text"])
    if p["kind"] == "key_point":
        row["a_anchors"], row["b_anchors"] = p["a"]["anchors"], p["b"]["anchors"]
    sheet.append(row)
    key[pid] = dict(kind=p["kind"], cos=p["cos"], band=p["band"], doc=p["doc"], group=p["group"], chunked=p["chunked"])

os.makedirs(OUT, exist_ok=True)
json.dump(population, open(os.path.join(OUT, "population.json"), "w", encoding="utf-8"), indent=1)
json.dump(sheet, open(os.path.join(OUT, "label_sheet.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
json.dump(key, open(os.path.join(OUT, "label_key.json"), "w", encoding="utf-8"), indent=1)
print(json.dumps(population, indent=1))
print("sampled", len(sample))
