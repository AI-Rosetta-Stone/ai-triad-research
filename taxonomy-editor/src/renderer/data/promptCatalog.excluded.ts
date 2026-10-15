// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Prompt-catalog exclusion allowlist (t/2834).
 *
 * The registry lint (`__tests__/promptCatalog.lint.test.ts`) fails when a discovered
 * prompt-builder (`lib/debate/prompts/*`, `renderer/prompts/*`) or `.prompt` file is neither
 * referenced by `PROMPT_CATALOG` nor listed here. This file is the single, greppable place an
 * intentional exclusion lives — co-located with the catalog + gate (Gate Co-Location).
 *
 * **Every entry needs a `reason`** — an exemption without a reason is how allowlists rot.
 * Seeded from CL's curation ruling (t/2835#1): the 14 INTERNAL debate builders that are
 * opening/version variants, repair micro-prompts, or classifier/gate helpers — conceptually
 * covered by an already-exposed prompt, so they carry the marker instead of a catalog entry.
 */

export interface PromptExclusion {
  /** Exported builder fn name (or `.prompt` basename) that is intentionally NOT catalogued. */
  name: string;
  /** Why it's excluded — required. Keeps the allowlist auditable. */
  reason: string;
}

export const PROMPT_CATALOG_EXCLUDED: PromptExclusion[] = [
  // ── CL INTERNAL (t/2835#1): opening-stage variants — the opening is already represented
  //    top-level by the catalogued `openingStatementPrompt`; these are its per-stage specializations.
  { name: 'planOpeningStagePrompt', reason: 'Opening-stage variant of planStagePrompt; opening is represented by the catalogued openingStatementPrompt (CL t/2835#1).' },
  { name: 'briefOpeningStagePrompt', reason: 'Opening-stage variant of briefStagePrompt; opening is represented by the catalogued openingStatementPrompt (CL t/2835#1).' },
  { name: 'draftOpeningStagePrompt', reason: 'Opening-stage variant of draftStagePrompt; opening is represented by the catalogued openingStatementPrompt (CL t/2835#1).' },
  { name: 'citeOpeningStagePrompt', reason: 'Opening-stage variant of citeStagePrompt; opening is represented by the catalogued openingStatementPrompt (CL t/2835#1).' },
  // ── CL INTERNAL: version / user-seed variants of an already-exposed stage.
  { name: 'briefStagePromptV2', reason: 'A/B version variant of the catalogued briefStagePrompt (CL t/2835#1).' },
  { name: 'draftFromSelectedClaimsPrompt', reason: 'User-seeded-claims variant of the catalogued draftStagePrompt (CL t/2835#1).' },
  // ── CL INTERNAL: repair / classifier / gate helpers — not user-inspected turn prompts.
  { name: 'dolceComplianceRetryPrompt', reason: 'DOLCE-compliance repair micro-prompt (CL t/2835#1).' },
  { name: 'entailmentRepairPrompt', reason: 'Entailment repair micro-prompt (CL t/2835#1).' },
  { name: 'readabilityEditPassPrompt', reason: 'Post-draft readability repair pass: rewrites an already-generated debate turn to the audience reading-grade target while preserving the argument, debate moves, and voice. A mechanical copy-edit transform, not a turn-authoring prompt the reader inspects — INTERNAL, same class as the dolce/entailment repair passes. (CL t/2835#1)' },
  { name: 'classifyCounterfactualTypePrompt', reason: 'Classifier helper, not a user-facing turn prompt (CL t/2835#1).' },
  { name: 'coverageCheckPrompt', reason: 'Coverage gate helper, not a user-facing turn prompt (CL t/2835#1).' },
  { name: 'elementDecompositionPrompt', reason: 'Statement→information-elements helper (CL t/2835#1).' },
  { name: 'cruxRefreshPrompt', reason: 'Mid-debate crux-maintenance micro-prompt (CL t/2835#1).' },
  { name: 'consensusSituationPrompt', reason: 'Niche convergence→enrichment sub-prompt (CL t/2835#1).' },
  { name: 'crossCuttingNodePrompt', reason: 'Niche convergence→enrichment sub-prompt (CL t/2835#1).' },

  // ── Inquiry pipeline (t/3580): backend-only evaluator-model prompt, not user-inspected.
  //    Produces a structured InquiryResult via a single LLM call in the inquiry synthesis pass;
  //    no UX entry point in taxonomy-editor. Will get a catalog entry once the inquiry UX ships.
  { name: 'inquirySynthesisPrompt', reason: 'Backend-only evaluator prompt for the inquiry synthesis pass (t/3580). Not exposed in taxonomy-editor UI.' },

  // ── CL INTERNAL (t/2859): trivial UI utility, not a user-inspected content prompt.
  //    vernacularPrompt + aphorismPrompt ruled EXPOSE (now catalogued); this is the one
  //    permanent INTERNAL exclusion replacing the provisional t/2859 block.
  { name: 'generateDebateTitlePrompt', reason: 'Trivial UI utility — distils a debate topic into a <60-char title; no tunable substance, no data sources, no version. Utility micro-prompt class (CL ruling t/2859).' },
];
