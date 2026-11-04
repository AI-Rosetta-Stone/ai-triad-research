# Change Tiers and Decision Rights (t/4092, PI-approved 2026-10-07)

The full rules behind root `AGENTS.md` → "Change Tiers and Decision Rights". This text moved out of the root file unchanged, to cut the instruction tokens every agent loads every session. It is still binding. Read it before you choose a tier, open a consult, apply or clear `consult-hold`, approve a T2 PR or raise an ask to the PI.

**Declare the tier in the PR body's first line: `Tier: T0`, `T1` or `T2`.** A PR touching a T2 path must declare T2. That is enforced by the tier check (t/4103, advisory until promoted); until then the TL spot-checks. When the tier is otherwise unclear, choose **T1**, not a consult.

- **T0 (default):** features, fixes, refactors, tests, docs, dependency bumps, warn-only checks, and additive optional fields nothing branches on. Green CI, then auto-merge. No consult, hold or TL review.
  - An additive field is T0 only if its definition carries a point-of-use exemption note with its lapse condition. The model is `lib/ai-client/types.ts`: *"NO consumer branches on it… THE EXEMPTION LAPSES the moment a consumer branches on it."* Written-and-never-read is forensics; written-and-compared is semantic.
- **T1:** a new cross-role contract or shared type, a schema field a consumer reads, the **first branching reader of a previously exempt field**, or a new non-blocking gate. The owner plus one reviewer (Quality round-robin, `docs/review-routing.md`) approve on the PR, then auto-merge.
- **T2 (the only consult class):** making a gate blocking, a breaking schema or data-shape change, auth or secrets, writes to production or corpus data, or anything that takes more than a sprint to undo.
  - One Second Opinion round (`main.engineering-second-opinion@ai-triad-research.orca.local`), time-boxed to **2 hours**. Send the proposal, alternatives, what's at stake and the evidence; the reply is Recommendation / Key risks / Conditions / Dissent.
  - **Silence never approves.** After the time-box, the PR goes to the T2 human approver marked "SO did not review", and the approver decides knowingly. An unreachable SO backend is an infra issue for Orca Support; it neither blocks nor waives.
  - Conditions name the files they edit **and the files their logic depends on**. A new head needs re-confirmation only if it touches one of those.
  - Apply the **`consult-hold` label** (the required context `consult-hold-guard` enforces it for every merge path) and a one-line comment naming the open conditions. Human approval is required: the PI, or the TL when the SO has cleared the exact head (t/4096#58). SO dissent or no SO review → the PI. Merge pinned with `node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>` (t/4740).
- **Incident remediation is an automated check, test or platform fix.** A new prose rule needs a second occurrence, an owner and a review-by date.

**Only the PI decides:**
- spending and accounts;
- credentials and secrets policy;
- product and UX direction;
- research claims and publication;
- deleting production data;
- adding or removing roles;
- repo and branch-protection settings.

Everything else is decided by the owning role, or the TL if roles disagree, and recorded on the ticket.

**Asks to the PI** go in one daily TL digest. Each ask carries a recommendation and a default that takes effect by a stated time. **Defaults never apply to T2 approvals, anything on the PI-only list, or active security incidents.** Those wait for an explicit answer and are re-raised in each digest until answered.
