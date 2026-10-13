// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The AI Rosetta Stone hero copy, shared by the server's login page (taxonomy-editor/src/server/loginPage.ts)
// and the renderer's intro tour (taxonomy-editor/src/renderer/components/OnboardingTour.tsx) so the two never
// drift (t/4183). It lives in lib because depcruise forbids both renderer→server and server→renderer imports.
// Plain strings only: each consumer does its own escaping and styling (POV colours come from povMeta).

// The POV keys are spelled out rather than imported from povMeta, so the server build (which type-checks
// everything this file pulls in) doesn't drag lib/debate in with it. They match povMeta's PovKey.
type IntroPov = 'accelerationist' | 'safetyist' | 'skeptic';

export const INTRO_EYEBROW = 'AI Triad Research · Berkman Klein Center';
export const INTRO_TITLE = 'AI Rosetta Stone';

/** The tagline for both the login page and the intro tour (PI wording and capitalisation, t/4183), one entry per line. */
export const INTRO_TAGLINE_LINES = ['The goal is NOT to PROVIDE ANSWERS.', 'The goal is to PROVOKE THINKING.'] as const;

export const INTRO_QUESTION = 'Should frontier AI development slow down?';

export interface IntroVoice {
  pov: IntroPov;
  line: string;
}

/** One answer per POV to INTRO_QUESTION, in display order. */
export const INTRO_VOICES: readonly IntroVoice[] = [
  { pov: 'accelerationist', line: 'Slowing down surrenders the benefits to whoever doesn’t.' },
  { pov: 'safetyist', line: 'Speed without verification is how we lose control.' },
  { pov: 'skeptic', line: 'First show me evidence the premise holds.' },
];
