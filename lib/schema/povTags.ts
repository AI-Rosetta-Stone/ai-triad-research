// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// POV tags (t/3955; spec research/comp-linguist/analyses/t3935-pov-tags/spec.md §2.1–2.3a; SO e/249).
//
// `pov_tags` is a TOP-LEVEL field on POV nodes only: an array of tag ids from the node's own POV in the
// registry lib/debate/soul-docs/pov-tags.json. It is curated, editor-owned data like `label`, not
// enrichment, which is why it is not under graph_attributes.
//
// ABSENCE SEMANTICS (SO e/249#6 condition 3; also stated in taxonomy-schema.json node_fields): an absent
// or empty `pov_tags` means UNTAGGED. Under a tag in SCOPE mode a node without THAT tag (untagged, or
// carrying only another tag) is EXCLUDED, so coverage
// gaps silently narrow Scope debates; t/3962 asserts coverage and t/3957 WARNs with the excluded count.
//
// `validatePovTags` is the single rule. It is called by every live path that writes tags: the tagging CLI
// (pov-tags-cli.ts, the blocking gate t/3969 shells out to), the editor's renderer schema (SO condition 2),
// the lib Zod node schema, and the warn-first data-repo hook (t/3970).
//
// CHANGING THE REGISTRY (pov-tags.json can't carry comments, so the rule lives here; t/3985, SO e/253#2):
//  - Never rename a tag in place. Add the new tag, migrate the data (t/3969 writer), THEN remove the old
//    tag. To remove a tag, strip it from the data first. Spec §2.1 has the ordering.
//  - Before a registry PR merges, show what it orphans:
//      git show origin/main:lib/debate/soul-docs/pov-tags.json > base-pov-tags.json
//      tsx lib/schema/pov-tags-cli.ts --scan-data <ai-triad-data>/taxonomy/Origin --base-registry base-pov-tags.json
//    `introduced` must be 0 (exit 0). CI runs the same scan on every PR (t/3987).

import { z } from 'zod';
import registryJson from '../debate/soul-docs/pov-tags.json' with { type: 'json' };

/** Node-id prefix → registry POV key. Situation (`sit-*`) and retired `cc-*` nodes have no POV. */
export const POV_BY_ID_PREFIX: Readonly<Record<string, string>> = {
  acc: 'accelerationist',
  saf: 'safetyist',
  skp: 'skeptic',
};

/** The three registry POV keys. A tag belongs to exactly one of them. */
export const PovNameSchema = z.enum(['accelerationist', 'safetyist', 'skeptic']);
export type PovName = z.infer<typeof PovNameSchema>;

/** Lowercase kebab-case, unique within its POV (spec §2.1). */
export const POV_TAG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Tag selection and the applied-tag record (shared by Inquiry t/3965 and op-ed t/3960) ──────────────
// One POV-scoped tag applied to ONE camp. A single object, not parallel `tag?` + `tagMode?` optionals,
// so "both or neither" holds by construction (e/249 alternative d). `pov` is explicit because a request
// has no node id to derive it from. The other camps run exactly as untagged. Defined here, not in either
// feature, so the ask and the "what ran" record mean the same thing everywhere (TL t/3960#8).

/** `scope` keeps only the camp's tagged nodes; `prioritize` keeps every node and ranks tagged ones first. */
export const TagModeSchema = z.enum(['scope', 'prioritize']);
export type TagMode = z.infer<typeof TagModeSchema>;

/** The ask: one tag for one camp. Strict, so a mistyped key fails instead of being dropped. */
export const TagSelectionSchema = z.object({
  pov: PovNameSchema,
  tag: z.string().min(1),
  mode: TagModeSchema,
}).strict();
export type TagSelection = z.infer<typeof TagSelectionSchema>;

/**
 * What the counts in an applied-tag record MEAN, per mode (SO e/254#6 cond 3). Pinned in the schema
 * itself (`.describe`), not only in the UI, because `excludedUntagged: 0` reads as "full coverage" when in
 * Prioritize it means "this mode excludes nothing". Readers show the exclusion count ONLY for Scope.
 */
export const APPLIED_TAG_COUNT_MEANING = {
  included:
    'scope: tagged nodes of the named camp used for grounding. ' +
    'prioritize: tagged nodes of the named camp that were boosted.',
  excludedUntagged:
    // Historical field name: with more than one tag per camp this is NOT only untagged nodes (t/4275).
    "scope: nodes of the named camp that don't carry the selected tag (untagged, or carrying another tag) left out of grounding. " +
    'prioritize: always 0 by construction; it means this mode excludes nothing, NOT full coverage.',
} as const;

/** What the tag actually did, kept apart from the ask (SO e/252 cond 3). Filled by the generator. */
export const AppliedTagSchema = z.object({
  pov: PovNameSchema,
  tag: z.string().min(1),
  mode: TagModeSchema,
  included: z.number().int().nonnegative().describe(APPLIED_TAG_COUNT_MEANING.included),
  excludedUntagged: z.number().int().nonnegative().describe(APPLIED_TAG_COUNT_MEANING.excludedUntagged),
});
export type AppliedTag = z.infer<typeof AppliedTagSchema>;

const PovTagEntrySchema = z.object({
  id: z.string().regex(POV_TAG_ID_PATTERN, 'tag id must be lowercase kebab-case'),
  label: z.string().min(1),
  /** `<pov>.<tag>`: names lib/debate/soul-docs/<pov>.<tag>.soul.json. */
  soul_doc: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const PovTagRegistrySchema = z.object({
  version: z.number().int().positive(),
  // partialRecord: a POV with no entry has no tags (spec §2.1). Zod 4's z.record with enum keys is exhaustive.
  povs: z.partialRecord(PovNameSchema, z.array(PovTagEntrySchema)),
}).strict().superRefine((reg, ctx) => {
  for (const [pov, entries] of Object.entries(reg.povs)) {
    const seen = new Set<string>();
    for (const [i, e] of (entries ?? []).entries()) {
      if (seen.has(e.id)) ctx.addIssue({ code: 'custom', path: ['povs', pov, i, 'id'], message: `duplicate tag id "${e.id}" in ${pov}` });
      seen.add(e.id);
      if (e.soul_doc !== `${pov}.${e.id}`) {
        ctx.addIssue({ code: 'custom', path: ['povs', pov, i, 'soul_doc'], message: `soul_doc must be "${pov}.${e.id}", got "${e.soul_doc}"` });
      }
    }
  }
});

export type PovTagRegistry = z.infer<typeof PovTagRegistrySchema>;

/**
 * Canonical tag soul file name: `<pov>.<tag>.soul.json` (spec §3).
 * Single source of truth — used by both loaders, the pairing check, and diagnostics (t/3989).
 */
export function tagSoulFileName(pov: string, tag: string): string {
  return `${pov}.${tag}.soul.json`;
}

let cached: PovTagRegistry | undefined;

/** The bundled registry, validated once. Throws if the committed file is malformed. */
export function loadPovTagRegistry(): PovTagRegistry {
  if (!cached) cached = PovTagRegistrySchema.parse(registryJson);
  return cached;
}

/**
 * What kind of problem a `pov_tags` value has (t/3973):
 *  - `structural`: wrong regardless of the registry. The field on a non-POV node, a non-array, a
 *    non-string entry, a non-kebab-case id, a duplicate. Always blocking.
 *  - `unregistered`: a well-formed id the registry does not list for the node's POV. This depends on the
 *    registry's current contents, so a tag renamed or removed after nodes carry it turns those untouched
 *    nodes `unregistered`. The editor gates this kind on changed nodes only.
 */
export type PovTagProblemKind = 'structural' | 'unregistered';
export interface PovTagProblem {
  kind: PovTagProblemKind;
  message: string;
}

const structural = (message: string): PovTagProblem => ({ kind: 'structural', message });

/**
 * Every problem with a node's `pov_tags`, with its kind, or `[]` if it is valid. Pure; never throws.
 *  - absent (`undefined`/`null`) is valid for every node and means untagged;
 *  - a non-POV node (`sit-*`, `cc-*`, anything without an acc/saf/skp prefix) must not carry the field;
 *  - on a POV node the value must be an ARRAY of strings. A bare string is rejected: PowerShell unrolls a
 *    one-element array into a scalar (TL t/3955#4 cond 2), and accepting that would hide the corruption;
 *  - each id must be kebab-case, unique on the node, and registered under the node's own POV.
 */
export function validatePovTagsDetailed(nodeId: string, tags: unknown, registry: PovTagRegistry = loadPovTagRegistry()): PovTagProblem[] {
  if (tags === undefined || tags === null) return [];
  const prefix = /^([a-z]+)-/.exec(nodeId)?.[1] ?? '';
  const pov = POV_BY_ID_PREFIX[prefix];
  if (!pov) return [structural(`${nodeId}: pov_tags is only allowed on POV nodes (acc-/saf-/skp-); this node must not carry it`)];
  if (!Array.isArray(tags)) {
    return [structural(`${nodeId}: pov_tags must be an array of tag ids, got ${typeof tags}${typeof tags === 'string' ? ` "${tags}" (a one-element array unrolled to a scalar?)` : ''}`)];
  }
  const allowed = new Set((registry.povs[pov as keyof PovTagRegistry['povs']] ?? []).map((t) => t.id));
  const seen = new Set<string>();
  return tags.flatMap((t) => tagProblems(nodeId, pov, t, allowed, seen));
}

/** Every problem with a node's `pov_tags` as plain messages, or `[]` if it is valid. See
 *  {@link validatePovTagsDetailed}, which also says which problems are `unregistered`. */
export function validatePovTags(nodeId: string, tags: unknown, registry: PovTagRegistry = loadPovTagRegistry()): string[] {
  return validatePovTagsDetailed(nodeId, tags, registry).map((p) => p.message);
}

/**
 * Every problem with a single tag selected for a POV, or `[]` if it is valid: the same per-tag rule as
 * {@link validatePovTags}, for callers that name the POV explicitly instead of deriving it from a node id
 * (the Inquiry request's `tagSelection`, t/3965 SO e/252 cond 4). Pure; never throws.
 *
 * While the WHOLE registry is empty, every tag is rejected. That is expected until the tag souls land
 * (t/3956), and the message says so, so the rejection does not read as a bug. Once any POV has tags, a
 * rejection is a real mistake and carries no such note.
 */
export function validatePovTagSelection(pov: PovName, tag: string, registry: PovTagRegistry = loadPovTagRegistry()): string[] {
  const entries = registry.povs[pov] ?? [];
  const problems = tagProblems('tagSelection', pov, tag, new Set(entries.map((t) => t.id)), new Set()).map((p) => p.message);
  const registryEmpty = Object.values(registry.povs).every((e) => (e ?? []).length === 0);
  if (!registryEmpty) return problems;
  return problems.map((p) => `${p}. The tag registry ships empty until the tag souls land (t/3956), so every tag is rejected until then; this is expected, not a bug.`);
}

/** Problems with one entry of a POV node's tag array; `seen` accumulates ids to catch duplicates. */
function tagProblems(nodeId: string, pov: string, t: unknown, allowed: ReadonlySet<string>, seen: Set<string>): PovTagProblem[] {
  if (typeof t !== 'string') return [structural(`${nodeId}: pov_tags entries must be strings, got ${typeof t}`)];
  const problems: PovTagProblem[] = [];
  if (!POV_TAG_ID_PATTERN.test(t)) problems.push(structural(`${nodeId}: tag "${t}" is not lowercase kebab-case`));
  if (seen.has(t)) problems.push(structural(`${nodeId}: tag "${t}" appears more than once`));
  seen.add(t);
  if (!allowed.has(t)) {
    problems.push({
      kind: 'unregistered',
      message: allowed.size === 0
        ? `${nodeId}: tag "${t}" is not registered; ${pov} has no tags in lib/debate/soul-docs/pov-tags.json`
        : `${nodeId}: tag "${t}" is not registered for ${pov} (allowed: ${[...allowed].sort().join(', ')})`,
    });
  }
  return problems;
}

/**
 * Registry ↔ soul-file pairing (spec §2.1; CL t/3955#5: the JSON soul is the source of truth). Given the
 * registry and the file names in lib/debate/soul-docs, returns every unpaired tag: a registry tag with no
 * `<pov>.<tag>.soul.json`, or a `<pov>.<tag>.soul.json` with no registry entry. Pure; `[]` when paired.
 */
export function checkRegistrySoulPairs(registry: PovTagRegistry, soulDocFileNames: readonly string[]): string[] {
  const tagSouls = new Set(
    soulDocFileNames.map((f) => /^([a-z]+)\.([a-z0-9-]+)\.soul\.json$/.exec(f)).filter((m): m is RegExpExecArray => !!m).map((m) => `${m[1]}.${m[2]}`),
  );
  const registered = new Set(Object.entries(registry.povs).flatMap(([pov, entries]) => (entries ?? []).map((e) => `${pov}.${e.id}`)));
  const problems: string[] = [];
  for (const key of [...registered].sort()) if (!tagSouls.has(key)) problems.push(`registry tag "${key}" has no soul file ${key}.soul.json`);
  for (const key of [...tagSouls].sort()) if (!registered.has(key)) problems.push(`soul file ${key}.soul.json has no registry entry`);
  return problems;
}
