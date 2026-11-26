// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725: how a rename is saved. On the web a rename of a debate that is not shaped like a Quick take goes as a
// title-only delta (PATCH with `meta: { title }` and nothing else), because that is the one write the server
// accepts for an anonymous visitor's existing Deep dive or Socratic debate (t/724#4: the debate is read-only
// except for the title); a full PUT would carry the whole non-Quick-take session and be refused. Everything
// else, Quick takes and the desktop app, keeps the full save.

import { api, isElectronMode } from '@bridge';
import type { DebateSession, DebateDelta } from '../../../types/debate';
import { isQuickTakeShaped } from '../../../bridge/anonLimit';
import { nowISO } from '@lib/debate/helpers';

export function usesTitleOnlySave(session: DebateSession, electron: boolean = isElectronMode()): boolean {
  return !electron && !isQuickTakeShaped(session);
}

/** A delta that changes the title and nothing else. */
export function titleOnlyDelta(session: DebateSession, newTitle: string): DebateDelta {
  return {
    debateId: session.id,
    baseVersion: session._saveVersion ?? 0,
    newTranscriptEntries: [],
    changedNodes: [],
    changedEdges: [],
    newMutations: [],
    meta: { title: newTitle },
  };
}

/** Save the renamed session, updating `session` in place to match what was saved. */
export async function persistRename(session: DebateSession, newTitle: string, electron: boolean = isElectronMode()): Promise<void> {
  if (usesTitleOnlySave(session, electron)) {
    const { newVersion } = await api.saveDebateDelta(titleOnlyDelta(session, newTitle));
    session.title = newTitle;
    session._saveVersion = newVersion;
    return;
  }
  session.title = newTitle;
  session.updated_at = nowISO();
  await api.saveDebateSession(session, 'renameDebate');
}
