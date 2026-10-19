// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Text for an op-ed member's POV-tag scope (t/3992, t/3960). A reader must be able to tell a one-wing
// essay (Skeptic scoped to its Critical wing) from the whole camp's position (TL t/3960#3 cond 2).
// Pure: labels arrive resolved; tagLabelFor does the one registry lookup, with the id as fallback.

import type { TagMode } from '@lib/schema/povTags';
import type { PovTagRegistry } from '@lib/schema/povTags';

/** The wing name from the registry, or the tag id for a tag the registry no longer lists. */
export function tagLabelFor(pov: string, tag: string, registry: PovTagRegistry | null): string {
  return registry?.povs[pov as keyof PovTagRegistry['povs']]?.find(t => t.id === tag)?.label ?? tag;
}

/**
 * The reader's scope line, e.g. "Skeptic · Critical wing (scope; 31 not tagged Critical excluded)". The
 * exclusion count shows only for Scope: in Prioritize `excludedUntagged` is 0 by construction and would
 * read as "full coverage" (SO e/254#6 cond 3; APPLIED_TAG_COUNT_MEANING). The count includes nodes that
 * carry another wing's tag, so it never says "untagged" (t/4275).
 */
export function opedTagScopeText(campLabel: string, tagLabel: string, applied: { mode: TagMode; excludedUntagged: number }): string {
  const detail = applied.mode === 'scope' ? `scope; ${applied.excludedUntagged} not tagged ${tagLabel} excluded` : 'prioritized';
  return `${campLabel} · ${tagLabel} wing (${detail})`;
}

/** The community list badge, e.g. "Skeptic · Critical wing (Scope)". The index entry carries no counts. */
export function opedCommunityTagText(campLabel: string, tag: { label: string; mode: TagMode }): string {
  return `${campLabel} · ${tag.label} wing (${tag.mode === 'scope' ? 'Scope' : 'Prioritize'})`;
}
