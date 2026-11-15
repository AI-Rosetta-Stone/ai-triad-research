// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Community publication of an op-ed set drops every member's `stages` (t/171, TL p/35#12). A stage's
 * prompt carries the user's full source material, which is otherwise never public, plus raw outputs and
 * errors. The Community sanitizers are a key DENYLIST (lib/sanitize/stripSensitiveKeys.ts), and `stages`
 * can't go on it: debate diagnostics use the same key for unrelated data. So the op-ed publish paths call
 * this instead. The public share needs nothing: `projectPublicOpEd` is an allowlist.
 */
export function stripOpEdStagesForCommunity<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const set = data as Record<string, unknown>;
  if (!Array.isArray(set.opeds)) return data;
  return {
    ...set,
    opeds: set.opeds.map((m: unknown) => {
      if (!m || typeof m !== 'object') return m;
      const { stages: _stages, ...rest } = m as Record<string, unknown>;
      return rest;
    }),
  } as T;
}
