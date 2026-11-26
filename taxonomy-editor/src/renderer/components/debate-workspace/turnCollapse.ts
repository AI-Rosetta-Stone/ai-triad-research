// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/701 §8 (docs/ux/debate-statement-density.md): older turns collapse to their claim.
//
// The rule: in a debate with more than 3 turns, every turn except the 2 most recent starts
// collapsed. A turn the user opened or closed by hand keeps that choice, so when a new turn
// arrives the third most recent collapses unless the user expanded it.
//
// The hand-made choices are a reading aid for this session, not debate state: they live in
// module memory keyed by debate id, are never saved with the debate and are gone on reload.

import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** How many of the newest turns stay open, and the turn count above which collapsing starts. */
export const OPEN_NEWEST_TURNS = 2;
export const COLLAPSE_ABOVE_TURNS = 3;

/** Entry types that have no StatementCard: hidden housekeeping, and the two card kinds that never collapse. */
const NOT_A_TURN = new Set(['clarification', 'system', 'probing', 'fact-check']);

type TurnEntry = { id: string; type: string };

/** The ids of the entries that count as turns, in transcript order. */
export function turnIdsOf(transcript: readonly TurnEntry[] | undefined): string[] {
  return (transcript ?? []).filter(e => !NOT_A_TURN.has(e.type)).map(e => e.id);
}

/** Whether a turn starts collapsed, before any choice by the user. */
export function collapsedByDefault(turnIds: readonly string[], entryId: string): boolean {
  if (turnIds.length <= COLLAPSE_ABOVE_TURNS) return false;
  const i = turnIds.indexOf(entryId);
  return i >= 0 && i < turnIds.length - OPEN_NEWEST_TURNS;
}

// debate id → (entry id → collapsed?) for the turns the user set by hand.
const manualByDebate = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getVersion(): number { return version; }

export function isTurnCollapsed(debateId: string | undefined, turnIds: readonly string[], entryId: string): boolean {
  const manual = debateId ? manualByDebate.get(debateId)?.get(entryId) : undefined;
  return manual ?? collapsedByDefault(turnIds, entryId);
}

export function setTurnCollapsed(debateId: string, entryId: string, collapsed: boolean): void {
  let manual = manualByDebate.get(debateId);
  if (!manual) { manual = new Map(); manualByDebate.set(debateId, manual); }
  manual.set(entryId, collapsed);
  emit();
}

/** "Expand all turns": every turn open, as if the user had opened each one. */
export function expandAllTurns(debateId: string, turnIds: readonly string[]): void {
  manualByDebate.set(debateId, new Map(turnIds.map(id => [id, false])));
  emit();
}

/** "Collapse earlier turns": forget the hand-made choices, so the default rule applies again. */
export function collapseEarlierTurns(debateId: string): void {
  manualByDebate.delete(debateId);
  emit();
}

/** Test hook: forget every debate's choices. */
export function resetTurnCollapse(): void {
  manualByDebate.clear();
  emit();
}

/** The turn ids of a transcript. Recomputed when the array or its length changes, so a turn
 *  appended in place is still counted. */
function useTurnIds(transcript: readonly TurnEntry[] | undefined): string[] {
  const length = transcript?.length ?? 0;
  return useMemo(() => turnIdsOf(transcript), [transcript, length]);
}

/** One card's collapsed state and its toggle. Without a debate id (a card rendered on its own)
 *  nothing is collapsed and the toggle does nothing. */
export function useTurnCollapsed(
  debateId: string | undefined, transcript: readonly TurnEntry[] | undefined, entryId: string,
): { collapsed: boolean; toggle: () => void } {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const turnIds = useTurnIds(transcript);
  const collapsed = isTurnCollapsed(debateId, turnIds, entryId);
  const toggle = useCallback(() => {
    if (debateId) setTurnCollapsed(debateId, entryId, !collapsed);
  }, [debateId, entryId, collapsed]);
  return { collapsed, toggle };
}

/** The toolbar control: whether there is anything to collapse, and whether any turn is collapsed now. */
export function useTurnCollapseControls(
  debateId: string | undefined, transcript: readonly TurnEntry[] | undefined,
): { available: boolean; anyCollapsed: boolean; expandAll: () => void; collapseEarlier: () => void } {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const turnIds = useTurnIds(transcript);
  const anyCollapsed = turnIds.some(id => isTurnCollapsed(debateId, turnIds, id));
  const expandAll = useCallback(() => { if (debateId) expandAllTurns(debateId, turnIds); }, [debateId, turnIds]);
  const collapseEarlier = useCallback(() => { if (debateId) collapseEarlierTurns(debateId); }, [debateId]);
  return { available: !!debateId && turnIds.length > COLLAPSE_ABOVE_TURNS, anyCollapsed, expandAll, collapseEarlier };
}
