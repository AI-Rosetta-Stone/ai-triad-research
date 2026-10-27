// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Browser-safe companion to soulDocLoader.ts (t/3979).
// Uses import.meta.glob — Vite/vitest only. Do NOT import from Node paths (CLI, main, server).
// Node paths use soulDocLoader.ts instead.

import { ActionableError } from './errors.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { POVER_INFO } from './poverInfo.js';
import { SoulDocumentSchema, buildSoulProvenance } from './soulDocSchema.js';
import type { SoulProvenance } from './soulDocSchema.js';
import { tagSoulFileName } from '../schema/povTags.js';

/** Readability brand: marks provenance from the Vite/browser path (import.meta.glob). Not a transitive guard — see t/3980. */
export type SoulProvenanceBrowser = SoulProvenance & { readonly __runtime: 'browser' };
import type { TagSelection } from './types/session.js';
import type { PovInfo, SpeakerId } from './types.js';

// import.meta.glob with ?raw loads raw file text at Vite/vitest build time.
// *.soul.json matches both base souls (accelerationist.soul.json) and tag souls (skeptic.critical.soul.json).
// Raw strings are used for hashing (parity with soulDocLoader — t/4007 condition #3).
const ALL_SOUL_RAW = import.meta.glob<string>(
  './soul-docs/*.soul.json',
  { eager: true, query: '?raw', import: 'default' },
);

function getTagSoulFromRegistry(pov: string, tag: string): { soul: PovInfo; raw: string } {
  const key = `./soul-docs/${tagSoulFileName(pov, tag)}`;
  const raw = ALL_SOUL_RAW[key];
  if (raw === undefined) {
    throw new ActionableError({
      goal: `Load tag soul for ${pov}:${tag}`,
      problem: `Tag soul not found in registry: ${key}`,
      location: 'tagSoulRegistry.ts › getTagSoulFromRegistry',
      nextSteps: [`Add the soul file at lib/debate/soul-docs/${tagSoulFileName(pov, tag)} and rebuild.`],
    });
  }
  try {
    const soul = SoulDocumentSchema.parse(JSON.parse(raw)) as unknown as PovInfo;
    return { soul, raw };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'tagSoulRegistry',
      level: 'error',
      message: `Tag soul schema validation failed for ${pov}:${tag}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw new ActionableError({
      goal: `Parse tag soul for ${pov}:${tag}`,
      problem: `Schema validation failed: ${String(err)}`,
      location: 'tagSoulRegistry.ts › getTagSoulFromRegistry',
      nextSteps: [`Check the soul file at lib/debate/soul-docs/${tagSoulFileName(pov, tag)} against SoulDocumentSchema.`],
      innerError: err,
    });
  }
}

/**
 * Browser-safe soul resolver. Returns the active soul and its content provenance.
 * Renderer (Electron + web build) imports from here; CLI imports from soulDocLoader.ts.
 */
export function resolvePoverInfo(
  speaker: Exclude<SpeakerId, 'user'>,
  tagSelection?: TagSelection,
): { soul: PovInfo; soulProvenance: SoulProvenanceBrowser | undefined } {
  if (!tagSelection) {
    const soul = POVER_INFO[speaker];
    const baseKey = `./soul-docs/${speaker}.soul.json`;
    const raw = ALL_SOUL_RAW[baseKey];
    if (raw === undefined) {
      getGlobalRecorder()?.record({
        type: 'system.info',
        component: 'tagSoulRegistry',
        level: 'warn',
        message: `Soul provenance unavailable for ${speaker} — raw soul file not in Vite glob bundle. soul_provenance will be absent for this seat.`,
      });
      return { soul, soulProvenance: undefined };
    }
    return {
      soul,
      soulProvenance: buildSoulProvenance(`${speaker}.soul.json`, raw) as SoulProvenanceBrowser,
    };
  }
  const { soul: tagSoul, raw } = getTagSoulFromRegistry(speaker, tagSelection.tag);
  const baseSoul = POVER_INFO[speaker];
  // Enforce base identity fields — tag souls override personality/voice but not label or pov (t/3988).
  const soul: PovInfo = { ...tagSoul, label: baseSoul.label, pov: baseSoul.pov };
  return {
    soul,
    soulProvenance: buildSoulProvenance(tagSoulFileName(speaker, tagSelection.tag), raw) as SoulProvenanceBrowser,
  };
}
