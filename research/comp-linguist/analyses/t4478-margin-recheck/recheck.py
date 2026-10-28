"""t/4478 recheck: keypoint_surfacing_margin (0.06) under POV+BDI-scoped retrieval.

Recomputes top1_score restricted to the key_point's own POV+BDI pool (mirroring the
t/4478 implementation) for every safetyist key_point that already carries the t/2288
retrieval fields, and compares the resulting (top1_BDI - assigned_score) margin against
the existing POV-only margin. Full population, not a sample -- avoids the original
t/2341 study's unpersisted-sample problem.

Read-only on both repos. No embeddings regenerated/written; a local offline
all-MiniLM-L6-v2 encode is used only to score the already-extracted attribution_text
against already-shipped node vectors (embeddings.json), matching the production query
field choice (t/2341 Arm1: attribution_text primary, NOT canonical_proposition).
"""
import json, glob, re, os
import numpy as np
from sentence_transformers import SentenceTransformer

DATA = os.environ.get("AI_TRIAD_DATA_ROOT", r"C:\Users\jsnov\repos\ai-triad-data")
SUMMARIES = os.path.join(DATA, "summaries")
ORIGIN = os.path.join(DATA, "taxonomy", "Origin")

# ---- load node embeddings + BDI category + pillar exclusion ----
emb = json.load(open(os.path.join(ORIGIN, "embeddings.json"), encoding="utf-8"))
node_vec = {nid: np.array(v["vector"], dtype=np.float64) for nid, v in emb["nodes"].items()}

saf_nodes = json.load(open(os.path.join(ORIGIN, "safetyist.json"), encoding="utf-8"))["nodes"]
pillar_ids = set()
node_category = {}
for n in saf_nodes:
    nid = n["id"]
    m = re.match(r"saf-(beliefs|desires|intentions)-\d+", nid)
    if m:
        node_category[nid] = m.group(1)
    desc = (n.get("description") or "")
    if re.match(r"(?i)^\s*a thematic pillar\b", desc):
        pillar_ids.add(nid)

saf_ids = [nid for nid in node_vec if nid.startswith("saf-") and nid not in pillar_ids]
saf_mat = np.stack([node_vec[nid] for nid in saf_ids])
saf_mat_norm = saf_mat / np.linalg.norm(saf_mat, axis=1, keepdims=True)

category_pools = {}  # category -> (ids, normed matrix) restricted to that BDI
for cat in ("beliefs", "desires", "intentions"):
    ids = [nid for nid in saf_ids if node_category.get(nid) == cat]
    mat = np.stack([node_vec[nid] for nid in ids])
    category_pools[cat] = (ids, mat / np.linalg.norm(mat, axis=1, keepdims=True))

print(f"safetyist nodes (non-pillar): {len(saf_ids)}; by BDI: "
      f"{ {c: len(category_pools[c][0]) for c in category_pools} }")

# ---- collect eligible key_points ----
items = []
for fp in sorted(glob.glob(os.path.join(SUMMARIES, "*.json"))):
    try:
        d = json.load(open(fp, encoding="utf-8"))
    except Exception:
        continue
    ps = d.get("pov_summaries")
    if not isinstance(ps, dict):
        continue
    saf = ps.get("safetyist")
    if not isinstance(saf, dict):
        continue
    for kp in (saf.get("key_points") or []):
        if "retrieval_confidence" not in kp or not kp.get("taxonomy_node_candidates"):
            continue
        if not kp.get("attribution_text") or not kp.get("taxonomy_node_id"):
            continue
        cat_raw = (kp.get("category") or "").strip().lower()
        if cat_raw not in ("beliefs", "desires", "intentions"):
            continue
        assigned = kp["taxonomy_node_id"]
        if assigned not in node_vec:
            continue
        assigned_cat = node_category.get(assigned)
        items.append({
            "doc": os.path.basename(fp),
            "assigned": assigned,
            "assigned_cat_from_node": assigned_cat,
            "kp_category": cat_raw,
            "category_match": assigned_cat == cat_raw,
            "attribution_text": kp["attribution_text"],
            "point": kp.get("point", ""),
            "assigned_score": float(kp["retrieval_confidence"]),
            "top1_pov_score": float(kp["taxonomy_node_candidates"][0]["score"]),
            "top1_pov_id": kp["taxonomy_node_candidates"][0]["id"],
            "old_mechanism5_flag": bool(kp.get("mechanism5_flag", False)),
        })

print(f"eligible safetyist key_points: {len(items)}")
match_rate = sum(1 for it in items if it["category_match"]) / len(items)
print(f"kp.category == assigned-node BDI: {match_rate:.4f} "
      f"(ticket claims 0.993 on its own 3,484-item/317-doc frame)")

# ---- embed attribution_text (offline, local model) ----
model = SentenceTransformer("all-MiniLM-L6-v2")
texts = [it["attribution_text"] for it in items]
qvecs = model.encode(texts, normalize_embeddings=False, show_progress_bar=False, batch_size=64)

# ---- score top1 under full-POV pool (sanity check vs stored) and POV+BDI pool ----
qnorm = qvecs / np.linalg.norm(qvecs, axis=1, keepdims=True)
sim_full = qnorm @ saf_mat_norm.T  # (n_items, n_saf_nodes)

results = []
for i, it in enumerate(items):
    top1_full_idx = int(np.argmax(sim_full[i]))
    top1_full_score = float(sim_full[i, top1_full_idx])
    top1_full_id = saf_ids[top1_full_idx]

    cat = it["kp_category"]
    ids_c, mat_c = category_pools[cat]
    sim_c = qnorm[i] @ mat_c.T
    top1_bdi_idx = int(np.argmax(sim_c))
    top1_bdi_score = float(sim_c[top1_bdi_idx])
    top1_bdi_id = ids_c[top1_bdi_idx]

    it2 = dict(it)
    it2.update({
        "recomputed_top1_pov_score": round(top1_full_score, 4),
        "recomputed_top1_pov_id": top1_full_id,
        "top1_bdi_score": round(top1_bdi_score, 4),
        "top1_bdi_id": top1_bdi_id,
        "margin_pov_stored": round(it["top1_pov_score"] - it["assigned_score"], 4),
        "margin_pov_recomputed": round(top1_full_score - it["assigned_score"], 4),
        "margin_bdi": round(top1_bdi_score - it["assigned_score"], 4),
    })
    results.append(it2)

json.dump(results, open(r"C:\Users\jsnov\AppData\Local\Temp\claude\t4478_margin_recheck_full.json", "w"), indent=1)

# ---- summary stats ----
n = len(results)
flagged_pov = [r for r in results if r["margin_pov_recomputed"] > 0.06]
flagged_bdi = [r for r in results if r["margin_bdi"] > 0.06]
newly_unflagged = [r for r in flagged_pov if r["margin_bdi"] <= 0.06]
newly_flagged = [r for r in flagged_bdi if r["margin_pov_recomputed"] <= 0.06]
match_check = sum(1 for r in results if abs(r["margin_pov_stored"] - r["margin_pov_recomputed"]) < 0.01)

print(f"\nn = {n}")
print(f"instrument sanity: stored vs recomputed POV-only margin within 0.01: {match_check}/{n}")
print(f"flagged under POV-only (margin>0.06): {len(flagged_pov)} ({100*len(flagged_pov)/n:.1f}%)")
print(f"flagged under POV+BDI  (margin>0.06): {len(flagged_bdi)} ({100*len(flagged_bdi)/n:.1f}%)")
print(f"newly UNflagged by BDI narrowing: {len(newly_unflagged)}")
print(f"newly FLAGGED by BDI narrowing:   {len(newly_flagged)} (should be 0 or near-0 -- BDI pool is a subset)")

import statistics
print(f"\nmean margin, POV-only: {statistics.mean(r['margin_pov_recomputed'] for r in results):.4f}")
print(f"mean margin, POV+BDI:  {statistics.mean(r['margin_bdi'] for r in results):.4f}")

print(f"\n--- newly-flagged items (pool-restriction artifact, inspect) ---")
for r in newly_flagged[:10]:
    print(r["doc"], r["assigned"], r["kp_category"], "margin_pov", r["margin_pov_recomputed"], "margin_bdi", r["margin_bdi"])

print(f"\n--- sample of items flagged under BDI, for adjudication (first 25) ---")
for r in flagged_bdi[:25]:
    print(f"{r['doc']} | assigned={r['assigned']} | top1_bdi={r['top1_bdi_id']}@{r['top1_bdi_score']} | "
          f"assigned_score={r['assigned_score']} | margin_bdi={r['margin_bdi']} | cat_match={r['category_match']}")
