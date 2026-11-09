// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4941 (t/4773 follow-up item 4, GitHub #4474): a debate saved before the ModelPicker
// refactor (t/4773, #4478) may still carry `multi_provider`, `model_tier` and `speaker_models`
// on disk. Nothing writes those fields for new debates any more, but old sessions must still
// load and display without crashing — DebateConfigSection is the summary-card renderer that
// reads `model_tier` directly (DebateTab.tsx ~1151).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebateConfigSection } from './DebateTab';
import type { DebateSession } from '../../types/debate';

function makeLegacySession(overrides: Record<string, unknown> = {}): DebateSession {
  return {
    id: 'legacy-debate-1',
    title: 'Pre-t/4773 debate',
    phase: 'debate',
    turn_count: 4,
    debate_model: 'gemini-flash-lite-latest',
    protocol_id: 'structured',
    audience: 'general_public',
    updated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    topic: { original: 'AI governance', refined: null, final: 'AI governance' },
    active_povers: ['accelerationist', 'safetyist'],
    source_type: 'topic',
    transcript: [],
    // Legacy fields no longer written by NewDebateDialog (t/4773/#4478), but still present
    // on debates saved before that landed — and still typed/read in a few places
    // (modelConfig.ts's getSpeakerModel, sessionFingerprint.ts).
    model_tier: 'advanced',
    speaker_models: { accelerationist: 'gemini-pro', safetyist: 'gemini-flash' },
    // multi_provider was never a typed session field (it only ever existed as a
    // buildDebateCreatedData telemetry key, already removed) — included here as an
    // untyped extra key to prove an old on-disk blob with it doesn't break rendering.
    multi_provider: true,
    ...overrides,
  } as unknown as DebateSession;
}

describe('DebateConfigSection — old debates with legacy model fields still render (t/4941)', () => {
  it('renders without crashing for a session carrying multi_provider/model_tier/speaker_models', () => {
    expect(() => render(<DebateConfigSection debate={makeLegacySession()} />)).not.toThrow();
  });

  it('displays the legacy model_tier value', () => {
    render(<DebateConfigSection debate={makeLegacySession()} />);
    expect(screen.getByText('Model Tier:')).toBeInTheDocument();
    expect(screen.getByText('advanced')).toBeInTheDocument();
  });

  it('still shows model and protocol alongside the legacy tier field', () => {
    render(<DebateConfigSection debate={makeLegacySession()} />);
    expect(screen.getByText('gemini-flash-lite-latest')).toBeInTheDocument();
    expect(screen.getByText('structured')).toBeInTheDocument();
  });

  it('a current-shape session (no legacy fields) renders with no Model Tier row', () => {
    render(<DebateConfigSection debate={makeLegacySession({ model_tier: undefined, speaker_models: undefined, multi_provider: undefined })} />);
    expect(screen.queryByText('Model Tier:')).not.toBeInTheDocument();
  });
});
