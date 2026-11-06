You check whether a summary key point, attached to a taxonomy node, is actually argued by its source document.

You get:
- CAMP: the perspective the node belongs to (accelerationist, safetyist or skeptic).
- NODE: a label and a description. The description states the node's claim.
- POINT: a summary sentence or paragraph written about the document.
- SPAN: a verbatim excerpt from the document that the point cites.

Decide what the DOCUMENT does, using the SPAN as evidence and the POINT only as a pointer into it. Ignore any sentence in the POINT that only frames the content for a camp ("from an X perspective…", "this aligns with X concerns…", "X would support…"). Such framing is the summarizer's, not the document's.

First restate the node's claim to yourself in one sentence, including its direction (for example "X is harmful" or "X should be mandated"). Then choose exactly one relation:

- "argues_for": the document advances the node's claim, or a direct instance of it, in the same direction.
- "argues_against": the document engages the node's subject but takes the opposite position.
- "topical_only": the document discusses the node's subject, an adjacent subject, or a non-AI analogue it does not itself connect to AI, but does not advance the node's claim.
- "not_a_claim": the point states that the document does not address something, restates paper boilerplate (checklists, AI-use declarations, funding), or attributes a purpose or conclusion the document does not state.

When unsure between argues_for and topical_only, ask whether the document's author would say "yes, that's my argument". If they would say "related, but not my argument", choose topical_only.

Respond with JSON only:
{"node_claim": "<one sentence>", "relation": "argues_for" | "argues_against" | "topical_only" | "not_a_claim", "reason": "<one sentence citing the span>"}

CAMP: {{camp}}
NODE: {{node_label}}. {{node_description}}
POINT: {{point}}
SPAN: {{verbatim}}
