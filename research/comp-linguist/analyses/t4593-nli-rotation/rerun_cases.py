"""t/4593: re-run stance-polarity-repro.json case_1 (controlled 2x2), case_4 and case_5
through the NOW-FIXED NLI engine (scripts/embed_taxonomy.py, post t/4572 cb1eb8c5).

Reuses the shipped _load_nli_model/_classify_pairs_nli -- never re-derives a column
order by hand. Read-only; no fixture write (this script only prints the current real
output; the fixture edit is a separate, reviewed step).
"""
import sys, json
sys.path.insert(0, r"C:\Users\jsnov\repos\ai-triad-research\scripts")
import embed_taxonomy as et

model = et._load_nli_model()
print("label order from model.config.id2label:", model._nli_label_order)

def run(label, pairs):
    print(f"\n=== {label} ===")
    results = et._classify_pairs_nli(model, pairs)
    for (a, b), r in zip(pairs, results):
        print(f"  {r}")
    return results

# ---------------- case_1 controlled 2x2 (literal fixture texts) ----------------
claim_prop = ("Treating artificial intelligence as exempt from ordinary privacy law is "
              "fallacious because established data protection principles continue to "
              "govern responsible use.")
rich_node_prop = ("Argue That AI Requires Entirely New Laws, Not Adapted Old Ones "
                   "— asserts emerging technologies are so transformative they require "
                   "entirely new legal frameworks rather than adapted existing laws.")
bare_node_prop = "AI requires entirely new legal frameworks rather than adapted existing laws."
pov_frame = lambda pov, prop: f"The {pov} position is: {prop}"

pairs_c1 = [
    (claim_prop, pov_frame("accelerationist", rich_node_prop)),  # rich_framed
    (claim_prop, rich_node_prop),                                 # rich_no_framing
    (claim_prop, pov_frame("accelerationist", bare_node_prop)),  # bare_framed
    (claim_prop, bare_node_prop),                                 # bare_no_framing
]
r1 = run("case_1 controlled_2x2 [rich_framed, rich_no_framing, bare_framed, bare_no_framing]", pairs_c1)

# ---------------- case_4: saf-beliefs-017, agency->loss ----------------
case4_verbatim = ("AI infers, summarizes, remembers, ranks, and increasingly acts across "
                   "blurred boundaries and in a non-determistic manner. That shifts AI into "
                   "a category closer to delegated action. And this delegated action "
                   "relationship creates a different risk profile and attack surface for "
                   "privacy harms.")
saf017_label = "AI Deployment Speed Erodes Organizational Visibility and Control"
saf017_core = ("A Belief within safetyist discourse that describes how the rapid adoption "
               "of AI systems undermines security governance by creating a systemic loss "
               "of visibility and control over data.")
saf017_node_prop = f"{saf017_label} — {saf017_core}"
pairs_c4 = [(case4_verbatim, pov_frame("safetyist", saf017_node_prop))]
r4 = run("case_4 (saf-beliefs-017, verbatim, framed, label-plus-Core)", pairs_c4)

# ---------------- case_5: acc-127 (matching) vs acc-047 (opposite) ----------------
case5_canonical = "Existing legal frameworks govern AI without requiring entirely new statutes."
case5_verbatim = ("AI presents new privacy challenges, but treating AI as if it lives "
                   "outside the parameters of ordinary privacy law is fallacious. The "
                   "emerging lesson from privacy regulators and enforcers is increasingly "
                   "clear: there is no AI exceptionalism. The same principles that have "
                   "long governed responsible data use still apply.")

acc127_label = "Argue That Existing Laws Already Govern AI, Requiring No New AI-Specific Statutes"
acc127_core = ("An Intention within accelerationist discourse that asserts AI is not "
               "legally exceptional — existing, technology-neutral bodies of law already "
               "reach AI's harms and capabilities, so bespoke AI-specific legislation is "
               "unnecessary.")
acc127_node_prop = f"{acc127_label} — {acc127_core}"

acc047_label = "Argue That AI Requires Entirely New Laws, Not Adapted Old Ones"
acc047_core = ("An Intention within accelerationist discourse that asserts emerging "
               "technologies are so transformative they require entirely new legal "
               "frameworks rather than adapted existing laws. Proponents use this to "
               "justify sweeping regulatory changes tailored specifically for novel AI "
               "capabilities.")
acc047_node_prop = f"{acc047_label} — {acc047_core}"

pairs_c5 = [
    (case5_canonical, pov_frame("accelerationist", acc127_node_prop)),  # acc-127, canonical
    (case5_verbatim,  pov_frame("accelerationist", acc127_node_prop)),  # acc-127, verbatim
    (case5_canonical, pov_frame("accelerationist", acc047_node_prop)),  # acc-047, canonical
    (case5_verbatim,  pov_frame("accelerationist", acc047_node_prop)),  # acc-047, verbatim
]
r5 = run("case_5 [acc-127 canonical, acc-127 verbatim, acc-047 canonical, acc-047 verbatim]", pairs_c5)

print("\n--- summary ---")
print("case_1 rich_framed:    ", r1[0])
print("case_1 rich_no_framing:", r1[1])
print("case_1 bare_framed:    ", r1[2])
print("case_1 bare_no_framing:", r1[3])
print("case_4 verbatim:       ", r4[0])
print("case_5 acc-127 canonical:", r5[0])
print("case_5 acc-127 verbatim: ", r5[1])
print("case_5 acc-047 canonical:", r5[2])
print("case_5 acc-047 verbatim: ", r5[3])
