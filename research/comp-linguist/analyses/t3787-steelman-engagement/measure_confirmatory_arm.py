"""t/3802 confirmatory-arm read, per the CONFIRMATORY ARM PRE-REGISTRATION in findings.md (#2619).

Same instrument as the pilot: imports measure() from measure_pilot_vs_matched_baseline.py, no new
measurement path. Arms:
  * control = the PRE-FIX corpus filtered to the frozen cell. "Pre-fix" = created_at before the t/3795
    merge (67953c6d, 2026-09-30T20:32:08Z), the last of the three wiring surfaces. The pilot's
    "120 most recent by mtime" window is NOT reused: that window now includes post-fix production
    debates, which would contaminate the control.
  * arm = debates/t3790-confirm-20261020/ (50 debates, PI-approved batch t/3802#6).
Primary: per-steelman-node binary adoption (>=1 later inbound edge from the node's own steelmanned
camp). Decision: CONFIRM if the arm's 95% Wilson CI excludes the control rate (upward).
"""
import glob, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_pilot_vs_matched_baseline import REPO_DATA, measure, wilson, matches_cell  # noqa: E402

FIX_AT = "2026-09-30T20:32:08Z"
ARM_GLOB = os.path.join(REPO_DATA, "debates", "t3790-confirm-20261020", "t3790c*-debate.json")


def created(path):
    try:
        return json.load(open(path, encoding="utf-8")).get("created_at") or ""
    except (OSError, ValueError):
        return ""


def two_prop_z(k1, n1, k2, n2):
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
    return ((k1 / n1 - k2 / n2) / se) if se else float("nan")


def fisher_one_sided(k1, n1, k2, n2):
    """P(arm count >= k1) under the hypergeometric null; arm is group 1."""
    K, N = k1 + k2, n1 + n2
    comb = math.comb
    return sum(comb(K, i) * comb(N - K, n1 - i) for i in range(k1, min(K, n1) + 1)) / comb(N, n1)


pre = [p for p in sorted(glob.glob(os.path.join(REPO_DATA, "debates", "debate-*.json")))
       if created(p) and created(p) < FIX_AT]
arm_files = sorted(glob.glob(ARM_GLOB))

b = measure(pre, f"CONTROL: pre-fix corpus (created < {FIX_AT}) filtered to cell", require_cell=True)
print()
# CELL MISMATCH (found 2026-10-20, after the run): the CLI applies pacing only with
# useAdaptiveStaging=true, and neither the pilot's recipe nor this arm's set it. So the arm and the
# pilot ran FIXED ROUNDS, no adaptive staging, and record no adaptive_staging block (pacing reads None),
# while the control cell is adaptive_staging.pacing=moderate. matches_cell() therefore rejects every
# arm debate. As in the pilot read, the arm is measured with require_cell=False; the four other cell
# dimensions are asserted below, and the staging mismatch is reported, not hidden.
a = measure(arm_files, "CONFIRMATORY ARM (t3790c01-c50) -- fixed rounds, NO adaptive staging", require_cell=False)
a["n_cell"] = len(arm_files)
mism = []
for p in arm_files:
    d = json.load(open(p, encoding="utf-8"))
    if (d.get("debate_model"), d.get("protocol_id"), d.get("audience"), len(d.get("active_povers") or [])) != \
            ("gemini-3.5-flash-lite", "structured", "policymakers", 3):
        mism.append(os.path.basename(p))
print(f"  model/protocol/audience/povs mismatches in arm: {len(mism)} {mism[:5]}")
print()

print("=== STAGING / LENGTH (the unmatched dimension) ===")
def lengths(files, cell):
    out = []
    for p in files:
        try: d = json.load(open(p, encoding="utf-8"))
        except (OSError, ValueError): continue
        if cell and not matches_cell(d): continue
        out.append(sum(1 for t in d.get("transcript", []) if t.get("speaker") in
                       ("accelerationist", "safetyist", "skeptic")))
    return out
for files, cell, lbl in ((pre, True, "control"), (arm_files, False, "arm")):
    L = lengths(files, cell)
    print(f"  {lbl}: debater turns per debate mean {sum(L) / len(L):.1f}, min {min(L)}, max {max(L)} (n={len(L)})")
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
