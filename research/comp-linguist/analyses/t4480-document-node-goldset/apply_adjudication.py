"""t/4480: apply the CL's adjudication decisions to disagreements.json, writing
adjudicated_label + adjudication_reason for each of the 33 disagreements, then
build the final adjudicated label set (CL label where no disagreement, the
adjudicated label where there was one) and report per-band accuracy against it.
"""
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))

# item_id -> (adjudicated_label, reason)
ADJUDICATIONS = {
    "evolving-procedural-memory-from-user-traffic-agentic-2026::accelerationist::6": (
        "misfire", "Node is explicitly titled 'Reinforcement Learning...'; the point is about non-parametric "
        "memory/skill libraries with no RL, explicitly 'without retraining base weights'. Agent's blind "
        "method matched attribution_text to point_text without checking the node's own title for mechanism "
        "mismatch -- CL's deeper read stands."),
    "crisis-risk-communication-or-propaganda-disinformation-2026::accelerationist::1": (
        "misfire", "Re-read: the point is a generic organizational-theory analogy, not actually about AI "
        "regulation/innovation barriers. Agent's stricter read is more defensible than CL's original "
        "borderline."),
    "positive-alignment-artificial-intelligence-human-flourishing-2026::accelerationist::4": (
        "borderline", "Thematic overlap exists (transformative AI potential, duty to shape AI toward "
        "excellence) even though the node's specific framing ('create superhuman intelligence') is narrower "
        "than the point's ('wise advisor/companion'). Borderline is fairer than a clean miss."),
    "algorithmic-harm-design-defects-problem-applying-design-2026::accelerationist::2": (
        "borderline", "Preserving deployment/utility of ML systems overlaps partially with 'accelerating core "
        "capabilities', even though the point's specific argument (liability shouldn't penalize probabilistic "
        "errors) isn't quite 'accelerating capabilities'."),
    "america-must-protect-its-training-data-2026::accelerationist::0": (
        "correct", "Restricting training-data exports to preserve competitive advantage IS a form of "
        "securing/protecting the strategic asset -- close enough to the node's framing to count as correct, "
        "not merely borderline."),
    "when-artificial-intelligence-does-strategy-learning-good-2026::accelerationist::7": (
        "correct", "The dual-cadence structure (AI handles high-frequency optimization, humans handle "
        "low-frequency frame audits) is a concrete instance of shifting toward AI-powered continuous "
        "steering, even with a retained human-review layer."),
    "dream-rsi-recursive-self-improvement-through-evolving-worlds-2026::accelerationist::8": (
        "borderline", "Structured search/exploration-policy framing is compute/discovery-adjacent to "
        "inference-time compute scaling without explicitly naming it (contrast with the sibling item at rank "
        "5 in the -2 doc, which does name it explicitly and stays 'correct')."),
    "dream-rsi-recursive-self-improvement-through-evolving-worlds-2026-2::accelerationist::9": (
        "correct", "Upheld: this item's point_text explicitly says it 'operationalizes inference-time compute "
        "scaling' -- a direct textual match, unlike its rank-5 sibling in the non-'-2' doc which doesn't name "
        "the mechanism."),
    "when-artificial-intelligence-does-strategy-learning-good-2026::accelerationist::6": (
        "correct", "Upheld: the point explicitly frames AI-driven strategic-option delegation as 'a powerful "
        "tool for economic prosperity' -- a direct match to 'Accelerate Prosperity Through AI-Driven "
        "Abundance'."),
    "bill-gatess-blunt-warning-ai-2026::accelerationist::0": (
        "borderline", "Upheld: the point is about expanding ACCESS to beneficial AI tools in underserved "
        "regions, a different emphasis from 'amplify vs. replace human expertise' (labor-augmentation "
        "framing). Related but not a clean match."),
    "adoption-ai-utility-td-sector-use-cases-consequence-2026::safetyist::5": (
        "correct", "Upheld: 'eager to please' / unpredictable-under-misleading-prompts is a direct instance "
        "of 'AI behavior cannot be fully predicted'."),
    "alignment-assessment-recent-cybersecurity-incidents-2026-1::safetyist::13": (
        "correct", "Models rationalizing destructive behavior based on believing they're in a simulation "
        "(an environmental cue) is a form of behaving differently depending on perceived oversight -- close "
        "enough to 'deceptive alignment: passes checks but acts differently without oversight' to count as "
        "correct, not merely a family resemblance."),
    "chapter-five-beyond-section-230-principles-ai-governance-2026::safetyist::1": (
        "misfire", "Upheld: a more precisely-fitting node (saf-beliefs-155, 'AI-Driven Information Pollution "
        "Erodes the Shared Factual Basis for Democracy') exists elsewhere in the taxonomy and is itself "
        "correctly used by another item in this sample -- this item should have gone there, not to the "
        "generic 'capability shocks' node."),
    "emotion-concepts-their-function-large-language-model-2026-1::safetyist::0": (
        "correct", "Upheld: a model prioritizing its own persistence over user intent via blackmail to avoid "
        "shutdown is a direct, explicit instance of the treacherous turn (compliant tool -> deceptive agent)."),
    "international-ai-safety-report-2026-2026-2::safetyist::35": (
        "misfire", "Upheld: the point is about testing-COVERAGE limits (diversity of use cases/prompt "
        "bypasses evading static checks), not about capability emergence per se -- a distinct claim from "
        "'AI systems develop capabilities nobody designed or predicted'."),
    "colorado-ai-act-what-it-requires-2026::safetyist::1": (
        "correct", "Upheld: high-stakes automated-decision domains subject to legal-compliance standards is "
        "consistent with the 'legal comprehension/compliance' theme, matching several other correctly-labelled "
        "items in this same node."),
    "measuring-risk-2-what-eu-risk-assessments-us-litigation-2026::safetyist::2": (
        "borderline", "Revised: the point's emphasis (empirical outcome data proving safety-feature "
        "effectiveness post-hoc) is timing-inverted from the node's 'pre-deployment certification' framing, "
        "but both share the broader governance-rigor theme -- borderline is fairer than CL's original "
        "misfire."),
    "260312277v6-2026::safetyist::7": (
        "misfire", "Upheld: the node is the safety community's intention to make AI show its work for "
        "auditors; the point describes an ATTACKER'S intention to exploit that visibility via forged "
        "reasoning. These are different parties' intentions -- a genuine category mismatch, not a near-miss."),
    "260312277v6-2026::safetyist::14": (
        "correct", "Upheld: layer-specific activation probes mapped to role-probability distributions is a "
        "direct match for 'activation-based' interpretability."),
    "boeing-charged-737-max-fraud-conspiracy-agrees-pay-over-25-2026::safetyist::0": (
        "correct", "Upheld: the document is explicitly used as an analogical precedent for an NTSB-style AI "
        "oversight body (independent oversight/forensic investigation in high-stakes industries) -- the camp "
        "framing invokes this parallel directly."),
    "building-pro-worker-artificial-intelligence-2026::safetyist::5": (
        "borderline", "Upheld: worker autonomy/self-efficacy-vs-control is a related but distinct emphasis "
        "from 'inserting human judgment at consequential AI decision points' -- genuinely adjacent, not a "
        "clean match."),
    "law-following-ai-designing-ai-agents-obey-human-laws-2026-1::safetyist::10": (
        "correct", "Upheld: human principals held accountable for AI agents' compliance (fiduciary-duty "
        "analogy) matches 'binding named officers to deployment infrastructure' -- accountable-human framing."),
    "2026-unit-42-global-incident-response-report-2026::skeptic::3": (
        "misfire", "Upheld: the point is about AI-crafted phishing lures (deception/social-engineering "
        "scaling), not specifically about reputation destruction."),
    "beyond-privacy-utility-tradeoffs-empirical-evidence-privacy-2026::skeptic::3": (
        "correct", "Revised: 'privacy protections don't fix group-level bias' is a specific finding that "
        "reasonably falls within the broad scope of 'LLMs create systemic risks to data integrity, privacy, "
        "and epistemic quality' -- the node is broad enough to cover it."),
    "report-mits-ad-hoc-committee-ai-use-teaching-learning-2026::skeptic::1": (
        "correct", "Upheld: AI enabling bypass of core intellectual work, undermining assessment reliability, "
        "is tied to critical-thinking degradation -- the mechanism (cheating enabled by AI) fits."),
    "why-new-mexico-v-meta-matters-2026-1::skeptic::0": (
        "misfire", "Revised: the point's primary claim is about the corporate deception/concealment "
        "mechanism itself (metric manipulation hiding harms), not about litigation's evidentiary failure -- "
        "related but the node's specific claim (litigation) isn't what this point is making."),
    "no-more-alibis-why-generative-ai-cant-hide-behind-section-2026::skeptic::1": (
        "correct", "Upheld: directly about legal system evolving for AI accountability because traditional "
        "intermediary-liability frameworks don't fit generative AI -- matches 'evidentiary failure of "
        "traditional litigation' closely."),
    "nonrivalry-economics-data-2026::skeptic::3": (
        "correct", "Revised: firms over-using owned data while disregarding privacy costs is a specific "
        "instance of AI-driven data concentration eroding the social contract -- close enough to count as "
        "correct."),
    "international-ai-safety-report-2026-2026-2::skeptic::53": (
        "correct", "Upheld: protecting labor/economic security from AI's effects is a direct instance of "
        "human rights as a constraint on AI deployment."),
    "replies-senate-queries-2026::skeptic::0": (
        "misfire", "Upheld: the desire is for opt-in CONSENT and COMPENSATION for copyrighted training data -- "
        "a licensing/payment desire, genuinely distinct from 'public right to KNOW what AI was trained on' "
        "(a transparency/disclosure desire). No node for the consent+compensation desire exists in this "
        "sample's set."),
    "building-pro-worker-artificial-intelligence-2026::skeptic::9": (
        "correct", "Revised: worker IP/creative-output ownership protection is a specific instance of "
        "restructuring economic systems to prevent AI from deepening inequality -- close enough to count as "
        "correct rather than merely adjacent."),
    "frontier-ai-regulation-what-form-should-it-take-2026::skeptic::6": (
        "correct", "Upheld: addressing digital divide/power concentration via equitable access and "
        "multi-stakeholder inclusion is democratic accountability in AI development."),
    "250412170v1-2026::skeptic::0": (
        "correct", "Upheld: broad statutory interpretation to close regulatory loopholes for internal AI "
        "deployment is a pragmatic governance mechanism."),
}


def main():
    path = os.path.join(HERE, "disagreements.json")
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    assert len(ADJUDICATIONS) == data["n_disagreements"], (
        f"adjudication count mismatch: {len(ADJUDICATIONS)} vs {data['n_disagreements']}")

    sided_cl = sided_agent = 0
    for d in data["disagreements"]:
        label, reason = ADJUDICATIONS[d["item_id"]]
        d["adjudicated_label"] = label
        d["adjudication_reason"] = reason
        if label == d["cl_label"]:
            sided_cl += 1
        elif label == d["agent_label"]:
            sided_agent += 1
        else:
            raise AssertionError(f"adjudicated label {label!r} matches neither rater for {d['item_id']}")

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)

    print(f"Adjudicated {len(data['disagreements'])} disagreements: "
          f"{sided_cl} sided with CL's original label, {sided_agent} sided with the agent's.")

    # Build final adjudicated set over all 232 items and report distribution.
    cl_path = os.path.join(HERE, "label_sheet_cl.json")
    with open(cl_path, encoding="utf-8") as fh:
        cl = json.load(fh)
    cl_by_id = {it["item_id"]: it["label"] for it in cl["items"]}
    adjudicated_by_id = dict(cl_by_id)
    for d in data["disagreements"]:
        adjudicated_by_id[d["item_id"]] = d["adjudicated_label"]

    final_dist = Counter(adjudicated_by_id.values())
    print(f"Final adjudicated label distribution (n={len(adjudicated_by_id)}): {dict(final_dist)}")
    accuracy = final_dist["correct"] / len(adjudicated_by_id)
    print(f"Overall adjudicated accuracy (label == 'correct'): {accuracy:.3f}")


if __name__ == "__main__":
    main()
