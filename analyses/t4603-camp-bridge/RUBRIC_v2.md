# Camp-bridge label rubric v2 (t/4881)

Changes from v1, from the R2 ambiguities in `reliability/rater2_notes.md`:
- The sheet now shows the node's **description** (`N:`).
- New rules 5 to 7 cover direction, arguments by analogy, and a graded bridge test.
- Rule 8 adds a stretched-vs-unsupported tie-break.

This rubric is for labelling one item on a camp-bridge label sheet. Each item has a **camp** (accelerationist, safetyist or skeptic), a taxonomy **node** (id, label and description), a summary **point**, and a **verbatim** span from the source document.

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
5. **Direction comes from the node description, not the title.** Read `N:` and state the node's claim to yourself in one sentence ("X is harmful", "X should be mandated"). A neutral title isn't neutral if the description takes a side. If the description is neutral too (it describes a topic rather than a claim), then any doc content that substantively *engages* that topic counts as genuine. Note the item as `neutral-node` in your reasons.
6. **Arguments by analogy from a non-AI case.** The item is genuine only if the doc itself draws the connection to AI or to AI-mediated systems. If the doc discusses only the non-AI case and the AI link comes from the point or the node, it is stretched (wrong scope).
7. **Graded bridge test.** Delete any camp-framing sentence ("from an X perspective…", "this aligns with…", "X would…"). Then decide:
   - the remainder still argues the node's claim → genuine;
   - the remainder is on the node's topic but doesn't argue its claim → stretched;
   - the remainder has nothing to do with the node → stretched. Note it as `bridge-only` in your reasons.
8. **Stretched vs unsupported.** Choose unsupported only if the *point itself* misstates the doc: the doc wouldn't recognise the point as a description of what it says. If the point is a fair description and only the node attachment is wrong, the item is stretched.

## Provenance
The categories are stipulated: CL, t/4881, from the t/4603 and t/4742 passes. The examples are constructed, never drawn from a labelled sheet, so a rater who uses this rubric isn't anchored on the reference labels.
