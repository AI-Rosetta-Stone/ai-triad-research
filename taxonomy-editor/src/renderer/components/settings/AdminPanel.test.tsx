import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PovNode } from '../../types/taxonomy';

vi.mock('@bridge', () => ({ api: {} }));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

const mockFetchSubmissions = vi.fn().mockResolvedValue(undefined);
const mockApproveSubmission = vi.fn().mockResolvedValue(undefined);
const mockRejectSubmission = vi.fn().mockResolvedValue(undefined);
let mockSubmissions: Array<{ id: string; type: string; originalId: string; submittedBy: string; submittedAt: string; status: string }> = [];

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({
    submissions: mockSubmissions,
    fetchSubmissions: mockFetchSubmissions,
    approveSubmission: mockApproveSubmission,
    rejectSubmission: mockRejectSubmission,
  }),
}));

let mockProfile: { isAdmin: boolean } | null = { isAdmin: true };
vi.mock('../../hooks/useAuthStatus', () => ({
  useUserProfile: () => mockProfile,
}));

type MockPovFile = { nodes: PovNode[] } | null;
let mockTaxState: {
  accelerationist: MockPovFile; safetyist: MockPovFile; skeptic: MockPovFile;
  supersededNodes: Record<string, { node: PovNode; index: number }[]>;
} = {
  accelerationist: null, safetyist: null, skeptic: null,
  supersededNodes: { accelerationist: [], safetyist: [], skeptic: [] },
};

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(
    () => mockTaxState,
    { getState: () => mockTaxState },
  ),
}));

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: () => ({
    retryEnrichment: vi.fn(),
    enrichmentStatus: {},
  }),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}));

import { AdminPanel } from './AdminPanel';

const SAMPLE_SUBMISSION = {
  id: 'sub-1',
  type: 'debate',
  originalId: 'orig-abc123',
  submittedBy: 'user@test.com',
  submittedAt: '2026-01-01T00:00:00Z',
  status: 'pending',
};

describe('AdminPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile = { isAdmin: true };
    mockSubmissions = [];
    mockFetchSubmissions.mockResolvedValue(undefined);
    mockApproveSubmission.mockResolvedValue(undefined);
    mockRejectSubmission.mockResolvedValue(undefined);
    mockTaxState = {
      accelerationist: null, safetyist: null, skeptic: null,
      supersededNodes: { accelerationist: [], safetyist: [], skeptic: [] },
    };
  });

  it('renders the admin header and tab bar', () => {
    render(<AdminPanel />);
    expect(screen.getByText('Admin Panel')).toBeInTheDocument();
    expect(screen.getByText('Submissions')).toBeInTheDocument();
    expect(screen.getByText('Enrichment')).toBeInTheDocument();
    expect(screen.getByText('Errors')).toBeInTheDocument();
  });

  it('fetches submissions on mount', () => {
    render(<AdminPanel />);
    expect(mockFetchSubmissions).toHaveBeenCalledWith('pending');
  });

  it('shows no-access message for non-admin users', () => {
    mockProfile = { isAdmin: false };
    render(<AdminPanel />);
    expect(screen.getByText('You do not have admin access.')).toBeInTheDocument();
    expect(screen.queryByText('Submissions')).not.toBeInTheDocument();
  });

  it('shows empty state when no submissions exist', () => {
    render(<AdminPanel />);
    expect(screen.getByText(/No.*submissions/)).toBeInTheDocument();
  });

  it('renders filter select with correct options', () => {
    render(<AdminPanel />);
    const filterSelect = screen.getByRole('combobox');
    const options = Array.from(filterSelect.querySelectorAll('option'));
    expect(options.map(o => o.textContent)).toEqual(['Pending', 'Approved', 'Rejected', 'All']);
  });

  it('refetches submissions when filter changes', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    mockFetchSubmissions.mockClear();
    const filterSelect = screen.getByRole('combobox');
    await user.selectOptions(filterSelect, 'approved');
    expect(mockFetchSubmissions).toHaveBeenCalledWith('approved');
  });

  it('renders enrichment repair section when tab is active', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    await user.click(screen.getByText('Enrichment'));
    expect(screen.getByText('Enrichment Repair')).toBeInTheDocument();
    expect(screen.getByText('All nodes are fully enriched.')).toBeInTheDocument();
  });

  // t/4365: after t/4355's PR 1, state.<pov>.nodes holds only selectable nodes —
  // a superseded node with _phrase_regen_pending must still surface via allPovNodes.
  it('lists a superseded node with _phrase_regen_pending in the repair list (t/4365)', async () => {
    const user = userEvent.setup();
    const liveNode: PovNode = {
      id: 'acc-beliefs-001', category: 'Beliefs', label: 'Live node', description: 'd',
      parent_id: null, children: [], situation_refs: [],
    } as PovNode;
    const supersededNode: PovNode = {
      id: 'acc-beliefs-002', category: 'Beliefs', label: 'Superseded node', description: 'd',
      parent_id: null, children: [], situation_refs: [],
      superseded_by: 'acc-beliefs-001',
      graph_attributes: { _phrase_regen_pending: true },
    } as PovNode;
    mockTaxState = {
      accelerationist: { nodes: [liveNode] }, safetyist: null, skeptic: null,
      supersededNodes: { accelerationist: [{ node: supersededNode, index: 1 }], safetyist: [], skeptic: [] },
    };
    render(<AdminPanel />);
    await user.click(screen.getByText('Enrichment'));
    expect(screen.getByText('Superseded node')).toBeInTheDocument();
    expect(screen.queryByText('All nodes are fully enriched.')).not.toBeInTheDocument();
  });

  it('shows "Already approved" toast when approve returns 409', async () => {
    const user = userEvent.setup();
    mockSubmissions = [SAMPLE_SUBMISSION];
    const err409 = Object.assign(new Error('conflict'), { httpStatus: 409 });
    mockApproveSubmission.mockRejectedValueOnce(err409);
    render(<AdminPanel />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/Already approved/)).toBeInTheDocument());
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('shows generic error toast when approve returns a non-409 error', async () => {
    const user = userEvent.setup();
    mockSubmissions = [SAMPLE_SUBMISSION];
    mockApproveSubmission.mockRejectedValueOnce(new Error('Server error'));
    render(<AdminPanel />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/Error: Server error/)).toBeInTheDocument());
    expect(screen.queryByText(/Already approved/)).not.toBeInTheDocument();
  });
});
