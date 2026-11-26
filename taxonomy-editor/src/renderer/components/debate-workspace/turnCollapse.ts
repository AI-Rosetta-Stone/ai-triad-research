// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/701 §8 (docs/ux/debate-statement-density.md): older turns collapse to their claim.
//
// The rule (t/783 amends t/701): in a debate with more than 3 turns, the 2 newest DEBATER
// statements (opening, statement, response) start open, and so does the newest turn of any kind,
// so a just-arrived fact check or moderator note is seen. Every other turn starts collapsed: a
// fact check or moderator row does not use up an open slot. A turn the user opened or closed by
// hand keeps that choice, so when a new statement arrives the third most recent collapses unless
// the user expanded it.
//
// The hand-made choices are a reading aid for this session, not debate state: they live in
// module memory keyed by debate id, are never saved with the debate and are gone on reload.

import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** How many of the newest debater statements stay open, and the turn count above which collapsing starts. */
export const OPEN_NEWEST_TURNS = 2;
export const COLLAPSE_ABOVE_TURNS = 3;

/** Entry types that have no StatementCard: hidden housekeeping, and the probing card, which never collapses (a fact check collapses like a turn, t/764). */
const NOT_A_TURN = new Set(['clarification', 'system', 'probing']);

type TurnEntry = { id: string; type: string };

/** The entry types a debater writes. Fact checks, moderator rows, questions and the synthesis are not. */
const DEBATER_STATEMENT = new Set(['opening', 'statement', 'cross_respond']);

/** The entries that count as turns, in transcript order. */
export function turnsOf(transcript: readonly TurnEntry[] | undefined): TurnEntry[] {
  return (transcript ?? []).filter(e => !NOT_A_TURN.has(e.type)).map(e => ({ id: e.id, type: e.type }));
}

/** The ids of the entries that count as turns, in transcript order. */
export function turnIdsOf(transcript: readonly TurnEntry[] | undefined): string[] {
  return turnsOf(transcript).map(e => e.id);
}

/** Whether a turn starts collapsed, before any choice by the user. */
export function collapsedByDefault(turns: readonly TurnEntry[], entryId: string): boolean {
  if (turns.length <= COLLAPSE_ABOVE_TURNS) return false;
  if (!turns.some(t => t.id === entryId)) return false;
  if (turns[turns.length - 1].id === entryId) return false;
  const newestStatements = turns.filter(t => DEBATER_STATEMENT.has(t.type)).slice(-OPEN_NEWEST_TURNS);
  return !newestStatements.some(t => t.id === entryId);
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

export function isTurnCollapsed(debateId: string | undefined, turns: readonly TurnEntry[], entryId: string): boolean {
  const manual = debateId ? manualByDebate.get(debateId)?.get(entryId) : undefined;
  return manual ?? collapsedByDefault(turns, entryId);
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

/** The turns of a transcript. Recomputed when the array or its length changes, so a turn
 *  appended in place is still counted. */
function useTurns(transcript: readonly TurnEntry[] | undefined): TurnEntry[] {
  const length = transcript?.length ?? 0;
  return useMemo(() => turnsOf(transcript), [transcript, length]);
}

/** One card's collapsed state and its toggle. Without a debate id (a card rendered on its own)
 *  nothing is collapsed and the toggle does nothing. */
export function useTurnCollapsed(
  debateId: string | undefined, transcript: readonly TurnEntry[] | undefined, entryId: string,
): { collapsed: boolean; toggle: () => void } {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const turns = useTurns(transcript);
  const collapsed = isTurnCollapsed(debateId, turns, entryId);
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
  const turns = useTurns(transcript);
  const anyCollapsed = turns.some(t => isTurnCollapsed(debateId, turns, t.id));
  const expandAll = useCallback(() => { if (debateId) expandAllTurns(debateId, turns.map(t => t.id)); }, [debateId, turns]);
  const collapseEarlier = useCallback(() => { if (debateId) collapseEarlierTurns(debateId); }, [debateId]);
  return { available: !!debateId && turns.length > COLLAPSE_ABOVE_TURNS, anyCollapsed, expandAll, collapseEarlier };
}
