# Camp-bridge label rubric (t/4881)

This rubric is for labelling one item on a camp-bridge label sheet. Each item has a **camp** (accelerationist, safetyist or skeptic), a taxonomy **node** (id and label), a summary **point**, and a **verbatim** span from the source document.

The question is: **does the source document, as the verbatim span and point show it, argue for this node's claim, in the node's direction?** Whether the summary is accurate is a separate question.

## Labels

**genuine.** The document advances the node's claim, or a direct instance of it, in the same direction. An accurate summary is needed but is not enough.
- *Example (constructed):* the node is "Open-weight releases erode closed-model pricing power", and the doc says "open-weight releases drove API prices toward marginal cost". That is genuine.

**stretched.** The point fairly represents something the document says, but attaching it to this node takes a step the document doesn't take. All of these count as stretched:
- **Topic match only.** The doc discusses the node's subject but doesn't advance its claim. *Example:* a benchmark paper that measures code maintainability, mapped to "Scoring AI bugs to prioritise critical safety fixes".
- **Polarity inversion.** The doc argues *against* the node's claim. *Example:* an essay defending a liability shield, mapped to a node that says the shield is harmful. Note the inversion in your free-text column if there is one.
- **Bridge inference.** The point adds a camp reading the doc doesn't make ("from an X perspective…", "this aligns with X concerns…"). If you delete that sentence and the rest no longer supports the node, the item is stretched.
- **Wrong scope.** The doc's claim is about something adjacent: a non-AI system for an AI node, a hardware bias for a re-identification node, and so on.

**unsupported.** The point is not a fair representation of the document.
- A **non-claim**: "the document does not propose / articulate / engage with…".
- Paper **boilerplate** treated as a position (checklist answers, AI-use declarations, funding statements).
- A **misread**: the point attributes a purpose or conclusion the doc doesn't state. *Example:* calling routine wet-lab validation "biosecurity screening".

## Rules for hard cases
1. **Node null or missing.** Judge against the camp alone: would a reader of that camp's position recognise this as the doc arguing *their* view? If not, the item is stretched.
2. **Overstated but correct direction** ("demonstrates", "proves" for a doc that "shows"): genuine, unless the overstatement *is* the node's claim.
3. **Verbatim absent from the snapshot (`V[N]`).** That is usually a formatting artifact, so judge from the point. It only counts against the item if the point's content also can't be found.
4. **When you're torn between genuine and stretched,** ask: would the document's author agree that the doc argues for this node? If they would say "related, but that isn't my argument", label it stretched.

## Provenance
The categories are stipulated: CL, t/4881, from the t/4603 and t/4742 passes. The examples are constructed, never drawn from a labelled sheet, so a rater who uses this rubric isn't anchored on the reference labels.
