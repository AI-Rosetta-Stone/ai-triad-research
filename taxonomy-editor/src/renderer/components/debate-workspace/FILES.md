# DebateWorkspace — File Inventory

Reference inventory for the DebateWorkspace scope. Behavioral norms live in `AGENTS.md`.

## Components (`debate-workspace/`)

| File | Purpose |
|------|---------|
| `DebateWorkspace.tsx` | Root component — phase routing, toolbar, transcript, find, auto-save/compress |
| `DebateActionBar.tsx` | Action bar (input, cross-respond, synthesis), token budget indicator, phase progress |
| `StatementCard.tsx` | Transcript entry cards (statements, probing questions, fact checks) |
| `StatementBrief.tsx` / `.css` | Statement density pieces (t/701): structured Brief, read-more link, header turn symbols, collapsed-turn claim |
| `GlobalModeControl.tsx` | Toolbar display control: Text \| Why \| How, Brief \| Full, Expand all turns |
| `turnCollapse.ts` | Session-only collapse state for older turns (t/701 §8) |
| `ClarificationPanel.tsx` | Topic refinement UI — clarification questions, refined topic editor, score comparison |
| `OpeningPanel.tsx` | Opening statement controls — depth selection, error/retry bar |
| `ClaimsView.tsx` | Claims display and interaction during debates |
| `TaxonomyRefs.tsx` | Taxonomy node reference chips and coverage badges |
| `VocabularyPanel.tsx` | Domain vocabulary panel for debate context |
| `TopicCritique/` | Topic critique sub-component — radar chart, critique columns, scoring |
| `utils.ts` | Speaker labels/colors, phase constants, node navigation helpers |
| `index.ts` | Barrel export |

## State (`hooks/useDebateStore/`)

| File | Purpose |
|------|---------|
| `store.ts` | Zustand store composition — merges all slices |
| `types.ts` | Shared type definitions (DebateState, DebateSession) |
| `helpers.ts` | Shared helpers — AI call wrappers, error classification, prompt building |
| `slices/configSlice.ts` | Config state — error, retry action, daily limit, response length |
| `slices/sessionSlice.ts` | Session CRUD — create, load, save, delete, list debates |
| `slices/clarificationSlice.ts` | Clarification + opening statement orchestration |
| `slices/debateLoopSlice.ts` | Core debate loop — cross-respond, moderator, adaptive staging |
| `slices/synthesisSlice.ts` | Synthesis, probing questions, fact-checking, reflections |
| `slices/argumentNetworkSlice.ts` | QBAF argument network extraction and management |
| `slices/topicCritiqueSlice.ts` | Topic critique scoring and radar data |
