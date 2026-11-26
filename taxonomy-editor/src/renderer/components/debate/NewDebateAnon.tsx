// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// New debate dialog, anonymous visitors (t/725 for t/723, Design t/725#3 and p/25#221). Without signing in the server
// accepts Quick take debates only (t/724#4), so Deep dive and Socratic are visible but not selectable, and the
// rounds, protocol and step mode in Customise are fixed. Model, temperature and tags stay live. Signed-in users
// see none of this.

import { SignInNotice } from '../shared/SignInNotice';

export const ANON_PRESET_LINE = 'Without signing in, you can run Quick take debates.';
export const ANON_CUSTOMISE_LINE = 'Without signing in, debates are Quick take only, so rounds and protocol are fixed.';
/** Shown in place of a locked preset's time estimate. */
export const ANON_PRESET_LOCKED_TIME = 'Sign in to use';

/** A preset an anonymous visitor can't use: everything but Quick take. */
export function isAnonLockedPreset(isAnonymous: boolean, presetId: string): boolean {
  return isAnonymous && presetId !== 'quick';
}

/** The line under the preset cards, with the two sign-in links (Design: the t/678 notice). */
export function AnonPresetNote() {
  return <SignInNotice line={ANON_PRESET_LINE} />;
}

/** The line at the top of Customise's Format & pacing section. Static text, so the disabled controls below can point at it. */
export function AnonCustomiseNote() {
  return <p className="ndd-settings-field-hint" id="ndd-anon-customise-note">{ANON_CUSTOMISE_LINE}</p>;
}

/** Props that make a Customise control read-only but still focusable (aria-disabled, never `disabled`). */
export function anonLockedProps(isAnonymous: boolean): { 'aria-disabled'?: true; 'aria-describedby'?: string } {
  return isAnonymous ? { 'aria-disabled': true, 'aria-describedby': 'ndd-anon-customise-note' } : {};
}
