// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 step 4 (t/794; server contract t/724#4, Design p/25#221 item 7). Without signing in the server accepts only
// Quick take debates, and refuses every write to a debate that is not shaped like one (checks A and B), except a
// title-only edit. So an anonymous visitor's existing Deep dive or Socratic debate is read-only: it stays fully
// readable and renamable, its continue controls are disabled, and one notice says why.

import { SignInNotice } from '../shared/SignInNotice';
import { useAuthStatus } from '../../hooks/useAuthStatus';

export const ANON_READ_ONLY_NOTICE_ID = 'debate-anon-readonly-note';
export const ANON_READ_ONLY_LINE = "This debate can't be continued without signing in. You can still read it and rename it.";

interface SessionShape {
  protocol_id?: string;
  adaptive_staging?: { step_mode?: boolean; phase_bounds_override?: { maxConfrontationRounds?: number; maxArgumentationRounds?: number; maxConcludingRounds?: number } };
}

/** The server's Quick take shape (t/724#4 check A): protocol `structured`, each phase at most 1 round, no step mode. A missing
 *  protocol or round override is not a Quick take: the server refuses it rather than defaulting. */
export function isQuickTakeShaped(session: SessionShape): boolean {
  const staging = session.adaptive_staging;
  const bounds = staging?.phase_bounds_override;
  if (session.protocol_id !== 'structured' || staging?.step_mode === true || !bounds) return false;
  return [bounds.maxConfrontationRounds, bounds.maxArgumentationRounds, bounds.maxConcludingRounds]
    .every(n => typeof n === 'number' && n <= 1);
}

/** True when an anonymous visitor may not continue this debate. Signed-in users and Quick takes never are. */
export function isAnonReadOnly(isAnonymous: boolean, session: SessionShape): boolean {
  return isAnonymous && !isQuickTakeShaped(session);
}

/** Whether the visitor is anonymous and the active debate (if any) is one they may not continue. A hook: call it
 *  unconditionally, above any early return. */
export function useAnonReadOnly(session: SessionShape | null | undefined): boolean {
  const auth = useAuthStatus();
  return !!session && isAnonReadOnly(auth?.anonymous === true, session);
}

/** Static (not an alert), shown on load, directly above the action bar. The disabled controls point at it. */
export function AnonReadOnlyNotice({ active }: { active: boolean }) {
  return active ? <div id={ANON_READ_ONLY_NOTICE_ID}><SignInNotice line={ANON_READ_ONLY_LINE} /></div> : null;
}

/** True when any reason disables the action bar's controls: a turn is generating, a send is in flight, or the debate is read-only. */
export function anyDisabled(...reasons: boolean[]): boolean {
  return reasons.some(Boolean);
}

/** The attribute that ties the disabled controls to the notice. */
export function anonReadOnlyDescribedBy(active: boolean): { 'aria-describedby'?: string } {
  return active ? { 'aria-describedby': ANON_READ_ONLY_NOTICE_ID } : {};
}
