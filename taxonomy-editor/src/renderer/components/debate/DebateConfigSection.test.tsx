// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebateConfigSection } from './DebateTab';
import type { DebateSession } from '../../types/debate';

// Minimal session — protocol_id present so the Configuration section renders (its gate).
function debateWith(overrides: Partial<DebateSession>): DebateSession {
  return { protocol_id: 'structured', ...overrides } as unknown as DebateSession;
}

describe('DebateConfigSection — well-tested exclusion overview (t/1979)', () => {
  it('shows "On" when exclude_greatest_hits is true', () => {
    render(<DebateConfigSection debate={debateWith({ exclude_greatest_hits: true })} />);
    expect(screen.getByText('Well-tested exclusion:')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('shows "Off" when exclude_greatest_hits is false', () => {
    render(<DebateConfigSection debate={debateWith({ exclude_greatest_hits: false })} />);
    expect(screen.getByText('Well-tested exclusion:')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('shows "Off" for a pre-feature debate where the field is absent', () => {
    render(<DebateConfigSection debate={debateWith({})} />);
    expect(screen.getByText('Well-tested exclusion:')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });
});

describe('DebateConfigSection — origin label (t/4678/t/4683)', () => {
  it('labels a legacy string origin as "Asked a Question", not "GUI" (t/4679 normalizeDebateOrigin)', () => {
    render(<DebateConfigSection debate={debateWith({ origin: 'inquiry' as never, inquiryJobId: 'job-1' } as never)} />);
    expect(screen.getByText('Created via:')).toBeInTheDocument();
    expect(screen.getByText('Asked a Question')).toBeInTheDocument();
  });

  it('labels a typed inquiry origin the same way', () => {
    render(<DebateConfigSection debate={debateWith({ origin: { mode: 'inquiry', inquiry_id: 'job-1' } })} />);
    expect(screen.getByText('Asked a Question')).toBeInTheDocument();
  });

  it('still labels cli/gui origins as before', () => {
    render(<DebateConfigSection debate={debateWith({ origin: { mode: 'cli' } })} />);
    expect(screen.getByText('CLI (headless runner)')).toBeInTheDocument();
  });
});
