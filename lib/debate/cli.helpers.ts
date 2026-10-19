// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Testable helpers extracted from cli.ts — seat-tags validation and soul-override resolver.
 * Imported by both cli.ts (runtime) and cli.seatTags.test.ts (tests).
 */

import fs from 'fs';
import path from 'path';
import { SoulDocumentSchema, buildSoulProvenance, compareSoulProvenance, type SoulProvenance } from './soulDocSchema.js';
import { ActionableError } from './errors.js';
import { applyBaseIdentity, resolvePoverInfo } from './soulDocLoader.js';
import type { PovInfo, SpeakerId } from './types.js';
import type { SeatTag } from './types/session.js';
import type { SoulResolverFn } from './soulDocSchema.js';
import { loadPovTagRegistry, validatePovTagSelection, type PovName } from '../schema/povTags.js';
import type { PovTagRegistry } from '../schema/povTags.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Shape accepted in CLIConfig.seatTags. Mirror of SeatTag but Exclude<SpeakerId,'user'> keyed. */
export type CLISeatTagEntry = { pov_tag: string; tag_mode: 'scope' | 'prioritize' };
export type CLISeatTags = Partial<Record<Exclude<SpeakerId, 'user'>, CLISeatTagEntry>>;
export type CLISoulOverrides = Partial<Record<Exclude<SpeakerId, 'user'>, string>>;

// ── Seat-tag validation ──────────────────────────────────────────────────────

/**
 * Validate each entry in CLIConfig.seatTags against the POV-tag registry.
 * Returns the validated record (ready to pass as engineConfig.seat_tags), or throws
 * ActionableError if any tag is unknown.
 *
 * @param seatTags - Raw seatTags from CLIConfig
 * @param registry - Registry to validate against (defaults to bundled registry)
 */
export function validateSeatTagsConfig(
  seatTags: CLISeatTags,
  registry: PovTagRegistry = loadPovTagRegistry(),
): Partial<Record<Exclude<SpeakerId, 'user'>, SeatTag>> {
  const result: Partial<Record<Exclude<SpeakerId, 'user'>, SeatTag>> = {};
  for (const [speaker, entry] of Object.entries(seatTags) as [Exclude<SpeakerId, 'user'>, CLISeatTagEntry][]) {
    const pov = speaker as PovName; // speaker ids match pov names (accelerationist/safetyist/skeptic)
    const problems = validatePovTagSelection(pov, entry.pov_tag, registry);
    if (problems.length > 0) {
      throw new ActionableError({
        goal: `Validate seatTags for seat "${speaker}"`,
        problem: `Invalid pov_tag "${entry.pov_tag}" for ${speaker}: ${problems.join('; ')}`,
        location: 'cli.helpers.validateSeatTagsConfig',
        nextSteps: [
          `Use a tag registered for ${speaker} in lib/debate/soul-docs/pov-tags.json`,
          `Valid tag modes are "scope" and "prioritize"`,
          `Run: jq '.povs.${speaker}[].id' lib/debate/soul-docs/pov-tags.json to list valid tags`,
        ],
      });
    }
    result[speaker] = { pov_tag: entry.pov_tag, tag_mode: entry.tag_mode };
  }
  return result;
}

// ── Soul-override resolver ────────────────────────────────────────────────────

export interface SoulOverrideEntry {
  soul: PovInfo;
  soulProvenance: SoulProvenance;
}

/**
 * Load each soul override file, parse and validate it, build provenance, and verify it differs
 * from the default. Returns a map of loaded overrides keyed by speaker.
 *
 * @param soulOverrides  Path map from CLIConfig.soulOverrides
 * @param repoRoot       Repository root — relative paths are resolved against this
 */
export function loadSoulOverrides(
  soulOverrides: CLISoulOverrides,
  repoRoot: string,
): Partial<Record<Exclude<SpeakerId, 'user'>, SoulOverrideEntry>> {
  const overrides: Partial<Record<Exclude<SpeakerId, 'user'>, SoulOverrideEntry>> = {};

  for (const [speaker, filePath] of Object.entries(soulOverrides) as [Exclude<SpeakerId, 'user'>, string][]) {
    const resolvedPath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(repoRoot, filePath);

    let raw: string;
    try {
      raw = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'cli-helpers',
        level: 'error',
        message: `Cannot read soul override file for seat "${speaker}": ${resolvedPath}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: `Load soul override for seat "${speaker}"`,
        problem: `Cannot read soul override file: ${resolvedPath}`,
        location: 'cli.helpers.loadSoulOverrides',
        nextSteps: [
          `Verify the file exists at: ${resolvedPath}`,
          `Check for typos in soulOverrides["${speaker}"]`,
          `Relative paths are resolved against the repo root: ${repoRoot}`,
        ],
        innerError: err,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'cli-helpers',
        level: 'error',
        message: `Invalid JSON in soul override file for seat "${speaker}": ${resolvedPath}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: `Parse soul override JSON for seat "${speaker}"`,
        problem: `Invalid JSON in ${resolvedPath}`,
        location: 'cli.helpers.loadSoulOverrides',
        nextSteps: [
          `Validate the file with a JSON linter`,
          `Check for trailing commas, unquoted keys, or missing brackets`,
        ],
        innerError: err,
      });
    }

    const parseResult = SoulDocumentSchema.safeParse(parsed);
    if (!parseResult.success) {
      const validationSummary = parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ActionableError({
        goal: `Validate soul override schema for seat "${speaker}"`,
        problem: `Schema validation failed for ${resolvedPath}: ${validationSummary}`,
        location: 'cli.helpers.loadSoulOverrides',
        nextSteps: [
          `Fix the validation errors in the soul override file`,
          `Check against SoulDocumentSchema in lib/debate/soulDocSchema.ts`,
          `Required top-level fields: pov, label, color, personality, voice, anti_patterns, value_hierarchy, epistemic_stance, boundaries`,
        ],
      });
    }

    const provenance = buildSoulProvenance(path.basename(resolvedPath), raw);
    const soul = applyBaseIdentity(parseResult.data, speaker);
    overrides[speaker] = { soul, soulProvenance: provenance };
  }

  return overrides;
}

/**
 * Build a wrapped SoulResolverFn that serves pre-loaded soul overrides for seats that have them,
 * and falls through to `baseResolver` (default: resolvePoverInfo) for all other seats.
 *
 * @param overrides      Loaded soul overrides from loadSoulOverrides()
 * @param baseResolver   Fallback resolver for non-overridden seats
 */
export function buildSoulOverrideResolver(
  overrides: Partial<Record<Exclude<SpeakerId, 'user'>, SoulOverrideEntry>>,
  baseResolver: SoulResolverFn = resolvePoverInfo,
): SoulResolverFn {
  return (speaker, tagSelection) => {
    const override = overrides[speaker as Exclude<SpeakerId, 'user'>];
    if (override) {
      return { soul: override.soul, soulProvenance: override.soulProvenance };
    }
    return baseResolver(speaker, tagSelection);
  };
}

// ── Re-export compareSoulProvenance for test convenience ────────────────────
export { compareSoulProvenance };
