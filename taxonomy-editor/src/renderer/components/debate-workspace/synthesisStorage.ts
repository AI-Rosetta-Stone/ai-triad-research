// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809: the synthesis panel's small bits of browser-side state: the open-question checkboxes and
// the collapse choice, in localStorage keyed by debate id (the debate model has no field for
// them; the store is Rosetta Stone's). A blocked or corrupt store is recorded and the default is
// used, so the panel never fails because of it.

import { getGlobalRecorder } from '@lib/flight-recorder/index';

function read(key: string, what: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'SynthesisPanel', level: 'error', message: `${what} unreadable; using the default`,
      error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack },
    });
    return null;
  }
}

function write(key: string, value: string, what: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'SynthesisPanel', level: 'error', message: `${what} not saved`,
      error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack },
    });
  }
}

const questionsKey = (debateId: string): string => `synthesisV2.questions.${debateId}`;
const collapsedKey = (debateId: string): string => `synthesisV2.collapsed.${debateId}`;

export function readCheckedQuestions(debateId: string): Set<string> {
  const raw = read(questionsKey(debateId), 'open-question state');
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'SynthesisPanel', level: 'error', message: 'open-question state corrupt; starting unchecked',
      error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack },
    });
    return new Set();
  }
}

export function writeCheckedQuestions(debateId: string, checked: Set<string>): void {
  write(questionsKey(debateId), JSON.stringify([...checked]), 'open-question state');
}

/** Default expanded (spec §12); only an explicit '1' means collapsed. */
export function readCollapsed(debateId: string): boolean {
  return read(collapsedKey(debateId), 'synthesis collapse state') === '1';
}

export function writeCollapsed(debateId: string, collapsed: boolean): void {
  write(collapsedKey(debateId), collapsed ? '1' : '0', 'synthesis collapse state');
}
