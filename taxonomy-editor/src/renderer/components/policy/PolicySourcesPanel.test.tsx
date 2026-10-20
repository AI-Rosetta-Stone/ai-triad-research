// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336: PolicySourcesPanel shares the canonical-document grouping with SourcesPanel.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const MOCK_INDEX = vi.hoisted(() => {
  const r = (over: Record<string, unknown>) => ({
    docId: 'doc-1', title: 'AI Governance Report', dateIngested: '2025-06-01', sourceTime: '',
    stance: 'aligned', nodeId: 'acc-desires-001', pov: 'accelerationist', ...over,
  });
  return {
    'pol-001': [
      r({ docId: 'doc-1-1', canonicalDocId: 'doc-1' }),
      r({ docId: 'doc-1-2', canonicalDocId: 'doc-1' }), // the same reference, from another split part
      r({ docId: 'doc-1-2', canonicalDocId: 'doc-1', nodeId: 'acc-desires-002' }),
      r({ docId: 'doc-2', canonicalDocId: 'doc-2', title: 'Other Paper' }),
    ],
    // Older index entries without canonicalDocId still group by docId.
    'pol-002': [r({ docId: 'old-1' }), r({ docId: 'old-1', nodeId: 'acc-desires-009' })],
  };
});

vi.mock('@bridge', () => ({ api: { buildPolicySourceIndex: vi.fn().mockResolvedValue(MOCK_INDEX) } }));
const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

const { PolicySourcesPanel } = await import('./PolicySourcesPanel');

describe('PolicySourcesPanel', () => {
  it('shows one row per real document and counts a repeated reference once', async () => {
    render(<PolicySourcesPanel policyId="pol-001" />);
    await screen.findByText(/3 references across 2 documents/);
    fireEvent.click(screen.getByText('AI Governance Report'));
    expect(screen.getByText('acc-desires-001')).toBeInTheDocument();
    expect(screen.getByText('acc-desires-002')).toBeInTheDocument();
  });

  it('groups older entries without canonicalDocId by docId, with a WARN', async () => {
    render(<PolicySourcesPanel policyId="pol-002" />);
    await screen.findByText(/2 references across 1 document/);
    expect(mockRecord.mock.calls.some(c => c[0].level === 'warn' && c[0].component === 'policy-sources')).toBe(true);
  });

  it('shows the empty state for a policy with no sources', async () => {
    render(<PolicySourcesPanel policyId="pol-999" />);
    await screen.findByText('No sources reference this policy.');
  });
});
