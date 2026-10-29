"""t/4434: inter-rater agreement between the first rater (blind_ratings.json,
CL) and the second rater (second_rater_ratings.json, agent, per TL/PI decision
t/4434#7). Also reports each rater's statement-vs-description preference rate
after unblinding via pairs_key.json, and checks the t/3587 non-degenerate-
threshold rule (neither rater constant, else agreement alone can't be trusted).

Usage: python compute_second_rater_agreement.py
"""
import json
from collections import Counter

HERE = __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0]


def load(name):
    return json.load(open(f"{HERE}/{name}", encoding="utf-8"))


def main():
    first = load("blind_ratings.json")
    second = load("second_rater_ratings.json")
    key = {k["pair_id"]: k for k in load("pairs_key.json")}

    first_by_id = {r["pair_id"]: r["picked"] for r in first["ratings"]}
    second_by_id = {r["pair_id"]: r["picked"] for r in second["ratings"]}
    assert set(first_by_id) == set(second_by_id) == set(key), "pair_id sets must match exactly"
    n = len(first_by_id)

    agree = [pid for pid in first_by_id if first_by_id[pid] == second_by_id[pid]]
    disagree = [pid for pid in first_by_id if first_by_id[pid] != second_by_id[pid]]
    po = len(agree) / n

    labels = ["X", "Y"]
    first_dist = Counter(first_by_id.values())
    second_dist = Counter(second_by_id.values())
    pe = sum((first_dist[l] / n) * (second_dist[l] / n) for l in labels)
    kappa = (po - pe) / (1 - pe) if pe != 1 else float("nan")

    def stmt_rate(by_id):
        return sum(1 for pid, pick in by_id.items() if key[pid][f"{pick}_is"] == "statement")

    first_stmt = stmt_rate(first_by_id)
    second_stmt = stmt_rate(second_by_id)

    print(f"n = {n}")
    print(f"raw agreement: {len(agree)}/{n} = {po:.2%}")
    print(f"disagreements: {disagree}")
    print(f"first rater (X/Y) distribution: {dict(first_dist)} -- non-degenerate: {len(first_dist) > 1 and min(first_dist.values()) >= 2}")
    print(f"second rater (X/Y) distribution: {dict(second_dist)} -- non-degenerate: {len(second_dist) > 1 and min(second_dist.values()) >= 2}")
    print(f"Cohen's kappa: {kappa:.4f}")
    print(f"first rater statement-preferred: {first_stmt}/{n}")
    print(f"second rater statement-preferred: {second_stmt}/{n}")


if __name__ == "__main__":
    main()
