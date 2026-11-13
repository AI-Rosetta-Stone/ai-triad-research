// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/196#37 / p/239#4: a copy of a community debate opens as a My debate. Its exclusion
// row is not the owner's run config, so it is hidden. The community config section no
// longer shows a Model row, because debate_model is off the community allowlist.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebateConfigSection, CommunityConfigSection } from './DebateTab';
import type { DebateSession } from '../../types/debate';

function makeDebate(overrides: Record<string, unknown> = {}): DebateSession {
  return {
    id: 'debate-1',
    title: 'Config rows',
    phase: 'debate',
    audience: 'general_public',
    debate_model: 'gemini-flash-lite-latest',
    protocol_id: 'structured',
    exclude_greatest_hits: true,
    transcript: [],
    ...overrides,
  } as unknown as DebateSession;
}

describe('DebateConfigSection — exclusion row and copies (t/196#37)', () => {
  it('shows the Well-tested exclusion row for an uncopied debate', () => {
    render(<DebateConfigSection debate={makeDebate()} />);
    expect(screen.getByText('Well-tested exclusion:')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('hides the Well-tested exclusion row for a copy (copied_from_community set)', () => {
    render(<DebateConfigSection debate={makeDebate({ copied_from_community: 'community-abc' })} />);
    expect(screen.queryByText('Well-tested exclusion:')).toBeNull();
  });
});

describe('CommunityConfigSection — no Model row (t/196#37)', () => {
  it('shows Audience and no Model row when debate_model is absent (community allowlist)', () => {
    const { debate_model: _omit, ...rest } = makeDebate();
    void _omit;
    render(<CommunityConfigSection full={rest as unknown as DebateSession} />);
    expect(screen.getByText('Audience:')).toBeInTheDocument();
    expect(screen.queryByText('Model:')).toBeNull();
  });

  it('never renders a Model row even if debate_model is present on the object', () => {
    render(<CommunityConfigSection full={makeDebate()} />);
    expect(screen.queryByText('Model:')).toBeNull();
    expect(screen.queryByText('gemini-flash-lite-latest')).toBeNull();
  });
});
