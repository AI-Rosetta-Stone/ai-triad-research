"""t/4480: compute inter-rater agreement (raw labels, pre-adjudication) between
the CL and the blind agent rater, run the t/3587 non-degenerate-threshold check,
list disagreements for adjudication, and report per-rank-band accuracy.

Reads only label_sheet_cl.json and label_sheet_agent.json. Writes no data files;
prints a report and (with --write-disagreements) writes disagreements.json for
the adjudication pass.
"""
import argparse
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = ["correct", "borderline", "misfire"]


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return json.load(fh)


def cohens_kappa(labels_a, labels_b):
    n = len(labels_a)
    po = sum(1 for a, b in zip(labels_a, labels_b) if a == b) / n
    dist_a = Counter(labels_a)
    dist_b = Counter(labels_b)
    pe = sum((dist_a[l] / n) * (dist_b[l] / n) for l in LABELS)
    kappa = (po - pe) / (1 - pe) if pe != 1 else float("nan")
    return po, pe, kappa


def rank_band(rank):
    if rank == 1:
        return "1"
    if 2 <= rank <= 5:
        return "2-5"
    if 6 <= rank <= 30:
        return "6-30"
    return ">30"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-disagreements", action="store_true")
    a = ap.parse_args()

    cl = load("label_sheet_cl.json")
    agent = load("label_sheet_agent.json")

    cl_by_id = {it["item_id"]: it for it in cl["items"]}
    agent_by_id = {it["item_id"]: it for it in agent["items"]}

    assert set(cl_by_id) == set(agent_by_id), "item_id sets differ between raters"
    ids = list(cl_by_id)
    n = len(ids)

    cl_labels = [cl_by_id[i]["label"] for i in ids]
    agent_labels = [agent_by_id[i]["label"] for i in ids]

    assert all(l in LABELS for l in cl_labels), "CL has an invalid/null label"
    assert all(l in LABELS for l in agent_labels), "agent has an invalid/null label"

    po, pe, kappa = cohens_kappa(cl_labels, agent_labels)

    print(f"n = {n}")
    print(f"CL label distribution:    {dict(Counter(cl_labels))}")
    print(f"Agent label distribution: {dict(Counter(agent_labels))}")
    print(f"Raw agreement (po): {po:.4f}")
    print(f"Expected agreement (pe): {pe:.4f}")
    print(f"Cohen's kappa: {kappa:.4f}")
    print()

    # t/3587 non-degenerate-threshold check: exclude both "raters diverging"
    # (trivially low agreement) and "raters constant" (one label dominates
    # both distributions with no real variance -- checked per rank band too,
    # since a pass could be driven entirely by the easy rank-1 cells).
    print("--- Non-degenerate-threshold check (t/3587) ---")
    cl_dist = Counter(cl_labels)
    agent_dist = Counter(agent_labels)
    cl_dominant_frac = max(cl_dist.values()) / n
    agent_dominant_frac = max(agent_dist.values()) / n
    print(f"CL dominant-label fraction:    {cl_dominant_frac:.3f} ({cl_dist.most_common(1)[0][0]})")
    print(f"Agent dominant-label fraction: {agent_dominant_frac:.3f} ({agent_dist.most_common(1)[0][0]})")

    band_counter = Counter(rank_band(cl_by_id[i]["rank"]) for i in ids)
    print(f"Items per rank band: {dict(band_counter)}")

    for band in ["1", "2-5", "6-30", ">30"]:
        band_ids = [i for i in ids if rank_band(cl_by_id[i]["rank"]) == band]
        if not band_ids:
            continue
        band_cl = [cl_by_id[i]["label"] for i in band_ids]
        band_agent = [agent_by_id[i]["label"] for i in band_ids]
        band_po, _, band_kappa = cohens_kappa(band_cl, band_agent) if len(set(band_cl + band_agent)) > 1 else (
            sum(1 for a, b in zip(band_cl, band_agent) if a == b) / len(band_ids), None, float("nan"))
        cl_correct_frac = Counter(band_cl)["correct"] / len(band_ids)
        print(f"  band {band:>5} (n={len(band_ids):3}): CL-correct-rate={cl_correct_frac:.3f}, "
              f"raw agreement={band_po:.3f}, kappa={band_kappa}")
    print()

    # Disagreements for adjudication.
    disagreements = []
    for i in ids:
        if cl_by_id[i]["label"] != agent_by_id[i]["label"]:
            disagreements.append({
                "item_id": i,
                "doc": cl_by_id[i]["doc"],
                "camp": cl_by_id[i]["camp"],
                "point_text": cl_by_id[i]["point_text"],
                "attribution_text": cl_by_id[i]["attribution_text"],
                "assigned_node": cl_by_id[i]["assigned_node"],
                "assigned_node_label": cl_by_id[i]["assigned_node_label"],
                "cell": cl_by_id[i]["cell"],
                "rank": cl_by_id[i]["rank"],
                "cl_label": cl_by_id[i]["label"],
                "cl_better_node": cl_by_id[i]["better_node"],
                "cl_cause": cl_by_id[i]["cause"],
                "agent_label": agent_by_id[i]["label"],
                "agent_better_node": agent_by_id[i]["better_node"],
                "agent_cause": agent_by_id[i]["cause"],
                "adjudicated_label": None,
                "adjudication_reason": None,
            })

    print(f"--- Disagreements: {len(disagreements)}/{n} ({len(disagreements)/n:.1%}) ---")
    disagree_matrix = Counter((d["cl_label"], d["agent_label"]) for d in disagreements)
    for (cl_l, ag_l), cnt in sorted(disagree_matrix.items(), key=lambda x: -x[1]):
        print(f"  CL={cl_l:>10} / Agent={ag_l:>10}: {cnt}")

    if a.write_disagreements:
        out_path = os.path.join(HERE, "disagreements.json")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump({"n_total": n, "n_disagreements": len(disagreements), "disagreements": disagreements},
                       fh, indent=2, ensure_ascii=False)
        print(f"\nWrote {len(disagreements)} disagreements to {out_path}")


if __name__ == "__main__":
    main()
