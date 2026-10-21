"""Check a re-run debate against the plan's frozen first_debate_gate (PI condition, t/3802#9).

  python first_debate_gate.py <plan.json> <slug>
Exit 0 = gate passes; 1 = gate fails (STOP the batch and report).
"""
import json, os, sys

plan = json.load(open(sys.argv[1], encoding="utf-8"))
slug = sys.argv[2]
gate = plan["first_debate_gate"]
d = json.load(open(os.path.join(plan["output_dir"], f"{slug}-debate.json"), encoding="utf-8"))

staging = d.get("adaptive_staging") or {}
turns = sum(1 for t in d.get("transcript", []) if t.get("speaker") in ("accelerationist", "safetyist", "skeptic"))

an = d.get("argument_network") or {}
nodes = {n.get("id"): n for n in an.get("nodes") or [] if isinstance(n, dict)}
steel = {k: v for k, v in nodes.items() if v.get("steelman_of")}


def turn(n):
    try:
        return int(n.get("turn_number"))
    except (TypeError, ValueError):
        return None


later_inbound = 0
for e in an.get("edges") or []:
    if not isinstance(e, dict) or e.get("target") not in steel:
        continue
    s, t = nodes.get(e.get("source")), steel[e["target"]]
    if s and turn(s) is not None and turn(t) is not None and turn(s) > turn(t):
        later_inbound += 1

checks = {
    "staging_pacing == %s" % gate["staging_pacing"]: staging.get("pacing") == gate["staging_pacing"],
    "debater turns in [%d, %d]" % (gate["debater_turns_min"], gate["debater_turns_max"]):
        gate["debater_turns_min"] <= turns <= gate["debater_turns_max"],
}
print(f"{slug}: adaptive_staging={ {k: staging.get(k) for k in ('enabled', 'pacing')} }, debater turns={turns}, "
      f"steelman nodes={len(steel)}, later-inbound edges={later_inbound} "
      f"(control 0.72/debate; failed arm 0.14), total edges={len(an.get('edges') or [])}")
for name, ok in checks.items():
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
sys.exit(0 if all(checks.values()) else 1)
