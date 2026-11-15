# t/322 — how many taxonomy nodes should a Chat turn get?

**Today:** every live node of the POVer's camp (225 / 385 / 383) plus all 459 situations, on every
turn (`useChatStore.ts:127`, `maxNodes: 9999`, no relevance ranking).

**Usage (41 POVer turns, 26 saved chats):** BDI refs cited per turn have mean 3.0, median 2, p90 6,
max 12. Situation refs have mean 1.1, p90 3, max 4. 12 of the 41 turns cite nothing.

**Recall check (`recall_at_k.py`, local MiniLM at its pin, no AI calls; `results.json`).** For each
cited ref, I ranked it among the camp's live nodes (or all situations) by cosine similarity:

| Ranked against | BDI r@12 | BDI r@30 | BDI median rank | Sit r@4-ish (r@6) | Sit median rank |
|---|---|---|---|---|---|
| query (topic + last user message) | 15% | 28% | 85 | 10% | 44 |
| the turn's own answer text (ceiling) | 38% | 58% | 24 | 36% | 12 |

Counts: 120 rankable BDI refs and 42 situation refs.

**Reading.** Even against their own answers, cited nodes rank low. A hand sample of the worst
(answer rank > 60: 32 of 120) is mostly decorative. Examples: "Training Data Is an Ongoing Cost" on
a thread about banning abusive users, and "Phantom Dependencies" on "how do we safely accelerate
AI". With every node available, the model attaches weakly related ones. So **past citations are not
a gold set of nodes an answer needs**, and recall against them can neither validate nor refute a
cap. The query ranking is also weak for brainstorm turns (median 85 vs 24 on the answer).

**What this supports:**
- The full-taxonomy injection buys little: answers use about 3 nodes, often loosely.
- A cap of about 12 nodes plus 4 situations is consistent with use.
- A cap can't be *validated* from logs. It needs a blind answer-quality A/B (full vs cap, judged on
  grounding and relevance).
- Before any cap ships, improve the query beyond topic plus last message, for example by adding
  the previous POVer turn.

**Provenance:** the cap of 12 is **stipulated**, consistent with usage. Recall-based derivation was
attempted and is uninformative, for the reasons above.
