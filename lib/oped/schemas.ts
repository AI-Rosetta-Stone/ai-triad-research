// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { z } from 'zod';
// POV_KEYS = ['accelerationist', 'safetyist', 'skeptic'] — full strings, not short-codes.
// z.enum([...POV_KEYS]) therefore rejects 'acc'/'saf'/'skp' at parse time.
import { POV_KEYS } from '../debate/types.js';
import { ActionableError } from '../debate/errors.js';
import { TagSelectionSchema, AppliedTagSchema, validatePovTagSelection } from '../schema/povTags.js';
import type { OpEdSet } from './types.js';

export const PovKeySchema = z.enum([...POV_KEYS]);

// The PERSISTED params. `tagSelection` is declared so a stored set keeps it on re-parse (these plain
// z.objects strip undeclared fields: the t/2890 class), and is passthrough with NO registry check, so a set
// stays readable after its tag is retired. The registry check runs only at the live boundary:
// parseOpEdRequest below (t/3960; SO e/254#6).
export const OpEdParamsSchema = z.object({
  outlet: z.string().optional(),
  wordCount: z.number().int(),
  newsHook: z.string().optional(),
  thesis: z.string().optional(),
  authorBio: z.string().optional(),
  model: z.string(),
  tagSelection: TagSelectionSchema.passthrough().optional(),
  // t/203: generation tuning. Declared so a stored set keeps them; ranges are enforced (clamp + WARN) by
  // generate.ts at run time, not here, so a stored out-of-range value never makes a set unreadable.
  maxGroundingNodes: z.number().optional(),
  maxSituations: z.number().optional(),
  temperature: z.number().optional(),
  voiceOnly: z.boolean().optional(),
});

export const OpEdGroundingRefSchema = z.object({
  node_id: z.string(),       // snake_case — rejects PS PascalCase "Id"
  label: z.string(),
  category: z.string(),
  pov: PovKeySchema,         // full PovKey — rejects PS short-code "acc"/"saf"/"skp"
  relevance: z.string(),     // snake_case — rejects PS "Relevance"
  how_reflected: z.string(), // snake_case — rejects PS "HowReflected"
  document_claims: z.array(z.string()).optional(),
});

export const OpEdStageSchema = z.object({
  stage: z.string(),
  attempt: z.number().int().min(1),
  model: z.string(),
  prompt: z.string(),
  output: z.string(),
  error: z.string().optional(),
  temperature: z.number().optional(),
});

export const OpEdMemberSchema = z.object({
  pov: PovKeySchema,
  status: z.enum(['complete', 'failed', 'cancelled']),
  // Content fields are optional with defaults so failed/cancelled members
  // (which may have these absent in persisted legacy data) pass the parse.
  // After .default(), the inferred type is still string/number — matches OpEdMember.
  headline: z.string().optional().default(''),
  subtitle: z.string().optional().default(''),
  body: z.string().optional().default(''),
  byline: z.string().optional().default(''),
  disclosure: z.string().optional().default(''),
  rhetorical_meta: z.string().optional().default(''),
  wordCount: z.number().int().optional().default(0),
  grounding: z.array(OpEdGroundingRefSchema),
  claims: z.array(z.object({ text: z.string(), paragraph: z.number().int() })).optional(),
  // t/3960: what the tag did for this member, and which soul file voiced it. Declared against the strip
  // class; no registry check (read-tolerant). `soul` is internal: excluded from the public share.
  tag: AppliedTagSchema.passthrough().optional(),
  // t/4007: `hash` is the canonical field ("fnv1a64:" + 16 hex). Pre-t/4007 entries have `sha` (SHA-256, no prefix).
  // Schema normalises both: strips "lib/debate/soul-docs/" prefix from file; maps sha→hash when hash absent.
  soul: z.object({ file: z.string(), hash: z.string().optional(), sha: z.string().optional() })
    .transform(v => ({
      file: v.file.replace(/^lib\/debate\/soul-docs\//, ''),
      hash: v.hash ?? v.sha,
    })).optional(),
  // t/171: per-stage raw prompt/output for the How panel. Declared so the strip class can't drop it on save
  // (finalizeOpedSet parses before writing). `stage` stays a plain string: an older reader must never reject
  // a whole set over a stage name a newer generator added.
  stages: z.array(OpEdStageSchema).optional(),
});

export const OpEdSetSchema = z.object({
  schema_version: z.literal(1),
  set_id: z.string(),
  topic: z.string(),
  params: OpEdParamsSchema,
  created_at: z.string(),
  opeds: z.array(OpEdMemberSchema),
  // Source provenance (t/2898) — optional/additive so re-parse doesn't strip them
  // (same strip-gap class fixed for document_claims in t/2890). Absent on legacy sets.
  source_mode: z.enum(['topic', 'url', 'document']).optional(),
  source_url: z.string().optional(),
  source_name: z.string().optional(),
  source_key_claims_count: z.number().int().optional(),
});

/**
 * The LIVE-boundary check on a generate request's tag (t/3960; SO e/254#6, mirroring Inquiry's e/252 cond
 * 4). The server route and the IPC handler call `parseOpEdRequest` before starting generation, so an unknown
 * tag is rejected rather than the set running untagged. Only `povs` and `params.tagSelection` are checked
 * here; every other field passes through untouched (their validation stays with the callers).
 */
const OpEdRequestTagSchema = z
  .object({
    povs: z.array(PovKeySchema).min(1),
    params: z.object({ tagSelection: TagSelectionSchema.optional() }).passthrough(),
  })
  .passthrough()
  .superRefine((req, ctx) => {
    const sel = req.params.tagSelection;
    if (!sel) return;
    for (const message of validatePovTagSelection(sel.pov, sel.tag)) {
      ctx.addIssue({ code: 'custom', path: ['params', 'tagSelection', 'tag'], message });
    }
    if (!req.povs.includes(sel.pov)) {
      ctx.addIssue({
        code: 'custom',
        path: ['params', 'tagSelection', 'pov'],
        message: `tagSelection.pov "${sel.pov}" is not one of the requested povs (${req.povs.join(', ')}), so the tag would apply to no member`,
      });
    }
  });

/**
 * Validate a generate request's `povs` and `params.tagSelection` at the live boundary. Returns the request
 * unchanged when valid; throws an ActionableError listing every problem otherwise.
 */
export function parseOpEdRequest<T>(raw: T): T {
  const result = OpEdRequestTagSchema.safeParse(raw);
  if (result.success) return raw;
  const problems = result.error.issues.map((i) => `${i.path.join('.') || '(request)'}: ${i.message}`);
  throw new ActionableError({
    goal: 'Start an op-ed generation request',
    problem: `The request is invalid: ${problems.join('; ')}`,
    location: 'lib/oped/schemas.ts — parseOpEdRequest',
    nextSteps: [
      'Choose a tag registered for that POV in lib/debate/soul-docs/pov-tags.json, and include that POV in povs.',
      'Or omit tagSelection to generate an untagged set.',
    ],
  });
}

/**
 * Parse and validate a raw (unknown) value as an OpEdSet.
 * Throws ActionableError naming the first offending field if validation fails.
 * Use at persist sites (opedIO, opedStore) to catch shape violations at write time.
 */
export function parseOpEdSet(raw: unknown): OpEdSet {
  const result = OpEdSetSchema.safeParse(raw);
  if (result.success) return result.data as unknown as OpEdSet;
  const first = result.error.issues[0];
  const field = first?.path.join('.') ?? '(unknown)';
  const fieldMessage = first?.message ?? 'schema mismatch';
  throw new ActionableError({
    goal: 'Persist an op-ed set to storage',
    problem: `OpEdSet validation failed on field "${field}": ${fieldMessage}`,
    location: 'lib/oped/schemas.ts — parseOpEdSet',
    nextSteps: [
      'Check that the op-ed was generated by the TS core (lib/oped/generate.ts) or a conforming PS path.',
      'If data came from an older PS run, verify pov is a full PovKey (not a short-code) and grounding fields use snake_case.',
    ],
  });
}
