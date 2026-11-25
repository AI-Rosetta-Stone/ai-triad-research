// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/298: a rejected relationship must never show as if approved, and a proposed one must say it is
// unreviewed, in text (Design p/25#140).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { OrganizationEdge } from '../../bridge/types';
import { groupVisibleEdges } from './organizationEdgeGroups';

const ORG = 'org-010';
const edge = (target: string, type: OrganizationEdge['type'], status?: string): OrganizationEdge =>
  ({ source: ORG, target, type, status });

describe('groupVisibleEdges (t/298)', () => {
  it('drops rejected edges from the group and its count', () => {
    const groups = groupVisibleEdges([
      edge('doc-1', 'PUBLISHED', 'approved'),
      edge('doc-2', 'PUBLISHED', 'rejected'),
      edge('doc-3', 'PUBLISHED', 'proposed'),
    ], ORG);
    expect(groups.get('PUBLISHED')?.map(p => p.id)).toEqual(['doc-1', 'doc-3']);
  });

  it('drops a group whose only edges are rejected', () => {
    const groups = groupVisibleEdges([
      edge('eo-1', 'PUBLISHED', 'rejected'),
      edge('org-2', 'ALLIED_WITH', 'approved'),
    ], ORG);
    expect(groups.has('PUBLISHED')).toBe(false);
    expect(groups.has('ALLIED_WITH')).toBe(true);
  });

  it('marks proposed edges unreviewed; approved and missing status are unmarked', () => {
    const peers = groupVisibleEdges([
      edge('a', 'FUNDS', 'proposed'),
      edge('b', 'FUNDS', 'approved'),
      edge('c', 'FUNDS'),
      edge('d', 'FUNDS', ' Proposed '),
    ], ORG).get('FUNDS') ?? [];
    expect(peers.map(p => [p.id, p.unreviewed])).toEqual([['a', true], ['b', false], ['c', false], ['d', true]]);
  });

  it('treats a mixed-case Rejected as rejected', () => {
    expect(groupVisibleEdges([edge('x', 'OPPOSES', 'Rejected')], ORG).size).toBe(0);
  });

  it('names the peer, whichever end of the edge the org is on', () => {
    const peers = groupVisibleEdges([{ source: 'org-9', target: ORG, type: 'FUNDS', status: 'approved' }], ORG).get('FUNDS');
    expect(peers?.[0].id).toBe('org-9');
  });
});

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));
vi.mock('@bridge', () => ({
  api: {
    getOrganizationEdges: vi.fn().mockResolvedValue([
      { source: 'org-010', target: 'org-020', type: 'PUBLISHED', status: 'approved' },
      { source: 'org-010', target: 'org-030', type: 'PUBLISHED', status: 'rejected' },
      { source: 'org-010', target: 'org-040', type: 'PUBLISHED', status: 'proposed' },
    ]),
  },
}));

describe('OrganizationDetail relationships (t/298)', () => {
  it('hides the rejected edge, counts 2, and puts Unreviewed in the proposed row\'s accessible name', async () => {
    const { useOrganizationStore } = await import('../../hooks/useOrganizationStore');
    useOrganizationStore.setState({
      organizations: [
        { id: 'org-020', name: 'Approved Peer' },
        { id: 'org-030', name: 'Rejected Peer' },
        { id: 'org-040', name: 'Proposed Peer' },
      ],
    } as never);
    const { RelationshipSection } = await import('./OrganizationDetail');
    render(<RelationshipSection orgId="org-010" onSelectOrg={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approved Peer' })).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByText('Rejected Peer')).toBeNull();
    expect(screen.getByText('Published (2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Proposed Peer Unreviewed' })).toBeTruthy();
  });
});
