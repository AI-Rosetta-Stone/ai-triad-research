"""t/3802 confirmatory-arm read for the ADAPTIVE re-run, per the CONFIRMATORY ARM PRE-REGISTRATION in findings.md.

The first arm (t3790-confirm-20261020, measure_confirmatory_arm.py) ran fixed rounds and failed the
confound-bound check. This re-run (t3790-confirm2-adaptive-20261020, approval t/3802#9, #19, #22) ran
useAdaptiveStaging=true, pacing=moderate, so it should match the frozen cell. That is checked here, not
assumed: the arm is measured with require_cell=True, exactly like the control, and every arm debate that
fails matches_cell() is listed.

Same instrument as the pilot and the first arm: measure() from measure_pilot_vs_matched_baseline.py, no
new measurement path. Control = the pre-fix corpus (created_at before the t/3795 merge) filtered to the cell.
Primary: per-steelman-node binary adoption. Decision branches: findings.md "Decision branches".
"""
import glob, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_pilot_vs_matched_baseline import REPO_DATA, measure, wilson, matches_cell  # noqa: E402

FIX_AT = "2026-09-30T20:32:08Z"
ARM_GLOB = os.path.join(REPO_DATA, "debates", "t3790-confirm2-adaptive-20261020", "t3790a*-debate.json")
DEBATERS = ("accelerationist", "safetyist", "skeptic")


def load(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return None


def two_prop_z(k1, n1, k2, n2):
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
    return ((k1 / n1 - k2 / n2) / se) if se else float("nan")


def fisher_one_sided(k1, n1, k2, n2):
    """P(arm count >= k1) under the hypergeometric null; arm is group 1."""
    K, N = k1 + k2, n1 + n2
    comb = math.comb
    return sum(comb(K, i) * comb(N - K, n1 - i) for i in range(k1, min(K, n1) + 1)) / comb(N, n1)


def turns(files):
    out = []
    for p in files:
        d = load(p)
        if d and matches_cell(d):
            out.append(sum(1 for t in d.get("transcript", []) if t.get("speaker") in DEBATERS))
    return out


pre = [p for p in sorted(glob.glob(os.path.join(REPO_DATA, "debates", "debate-*.json")))
       if (load(p) or {}).get("created_at", "") and (load(p) or {}).get("created_at", "") < FIX_AT]
arm_files = sorted(glob.glob(ARM_GLOB))
off_cell = [os.path.basename(p) for p in arm_files if not matches_cell(load(p) or {})]

b = measure(pre, f"CONTROL: pre-fix corpus (created < {FIX_AT}) filtered to cell", require_cell=True)
print()
a = measure(arm_files, "CONFIRMATORY ARM 2 (t3790a01-a50) -- adaptive staging, pacing=moderate", require_cell=True)
print(f"  arm debates found {len(arm_files)}; off-cell (excluded) {len(off_cell)} {off_cell[:5]}")
print()

print("=== CELL MATCH: debater turns per debate ===")
for files, lbl in ((pre, "control"), (arm_files, "arm")):
    L = turns(files)
    print(f"  {lbl}: mean {sum(L) / len(L):.1f}, min {min(L)}, max {max(L)} (n={len(L)})")
print()

print("=== PRIMARY: per-steelman-node binary adoption ===")
rows = {}
for m, lbl in ((b, "control"), (a, "arm")):
    k, n = m["adopt_nodes"], m["steel"]
    lo, hi = wilson(k, n)
    rows[lbl] = (k, n, lo, hi)
    print(f"  {lbl}: {k}/{n} = {k / n:.1%}  [95% Wilson {lo:.1%}-{hi:.1%}]  "
          f"(debates in cell {m['n_cell']}, steelman nodes/debate {n / max(m['n_cell'], 1):.2f})")
(kb, nb, _, _), (ka, na, la, _) = rows["control"], rows["arm"]
rate_b = kb / nb
print(f"  two-proportion z (arm - control) = {two_prop_z(ka, na, kb, nb):.2f}; "
      f"Fisher one-sided p = {fisher_one_sided(ka, na, kb, nb):.4f}")
excl = la > rate_b
print(f"  arm CI lower bound {la:.1%} {'>' if excl else '<='} control rate {rate_b:.1%} -> "
      f"{'CI EXCLUDES the control rate (upward)' if excl else 'CI does NOT exclude the control rate'}")
print()

print("=== SECONDARIES ===")
for m, lbl in ((b, "control"), (a, "arm")):
    st = sum(m["src"].values()); sc = m["src"].get("steelmanned_camp", 0)
    cl, ch = wilson(m["conn_num"], m["conn_den"])
    print(f"  {lbl}: edge-share adoption {sc}/{st}" + (f" = {sc / st:.0%}" if st else "") +
          f" | connection {m['conn_num']}/{m['conn_den']} = {m['conn_num'] / m['conn_den']:.0%} "
          f"[{cl:.0%}-{ch:.0%}] | camp split {m['src']}")
print()
print("=== CONFOUND-BOUND (ruling #6): edges per debate ===")
for m, lbl in ((b, "control"), (a, "arm")):
    print(f"  {lbl}: {m['n_edges']} edges / {m['n_cell']} debates = {m['n_edges'] / max(m['n_cell'], 1):.2f}")
