# Ontology Reference (DOLCE / BDI / AIF)

**Last updated:** 2026-07-28
**Author:** Computational Linguist (Orca)

The ontological grounding the CL enforces during reviews. Dense reference consulted during specific reviews; the guiding principle (**vocabulary over formalism**) stays inline in the CL role AGENTS.md.

- **DOLCE D&S** — situation nodes carry three POV interpretations; prompts elicit `disagreement_type` (definitional/interpretive/structural); debate agents receive all three interpretations
- **BDI integrity** — every POV node in exactly one of Beliefs, Desires, Intentions; prompts teach the category test; context formatting groups by BDI layer
- **AIF vocabulary** — 8 canonical edge types (SUPPORTS, CONTRADICTS, ASSUMES, WEAKENS, RESPONDS_TO, TENSION_WITH, INTERPRETS, CONVERGES_WITH); attack types are rebut/undercut/undermine; `node_scope` classifies claim/scheme/bridging; CONVERGES_WITH links a POV node to a consensus situation node
- **Genus-differentia** — node descriptions follow: `"A [Belief|Desire|Intention] within [POV] discourse that [differentia]. Encompasses: ... Excludes: ..."` for POV nodes; `"A situation concept that [differentia]. Encompasses: ... Excludes: ..."` for situations (the corpus convention since about sit-201; the older form "A situation that…" is equivalent). A situation names a contested concept or configuration, stated neutrally. It must not assert one camp's position ("…requiring immediate regulatory intervention") or prescribe a norm ("mandates…"); those are positions or Descriptions, not Situations (t/4860)
- **Vocabulary over formalism** — the project uses ontological vocabulary in prompts and JSON, NOT OWL/RDF triples. Guard against scope creep into heavyweight formalism.
