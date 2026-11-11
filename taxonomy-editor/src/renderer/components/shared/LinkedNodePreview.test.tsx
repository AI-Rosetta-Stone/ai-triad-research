// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinkedNodePreview } from './LinkedNodePreview';
import * as useTaxonomyStoreModule from '../../hooks/useTaxonomyStore';
import * as flightRecorderModule from '@lib/flight-recorder/index';

describe('LinkedNodePreview', () => {
  const mockNode = {
    id: 'acc-beliefs-001',
    label: 'Test Belief',
    category: 'beliefs',
    description: 'Formal description of the belief',
    plain_description: 'Plain language explanation',
    graph_attributes: {},
  };

  const mockLookupPinnedData = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(useTaxonomyStoreModule, 'useTaxonomyStore').mockImplementation(() => mockLookupPinnedData);
  });

  it('renders nothing when node is not found', () => {
    mockLookupPinnedData.mockReturnValue(null);
    const { container } = render(<LinkedNodePreview nodeId="unknown-id" />);
    expect(container.firstChild).toBeNull();
  });

  it('defaults to plain mode', () => {
    mockLookupPinnedData.mockReturnValue({ type: 'pov', pov: 'acc', node: mockNode });
    render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    expect(screen.getByText('Plain language explanation')).toBeInTheDocument();
  });

  it('toggles to formal mode when toggle button clicked', async () => {
    mockLookupPinnedData.mockReturnValue({ type: 'pov', pov: 'acc', node: mockNode });
    const { rerender } = render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    
    expect(screen.getByText('Plain language explanation')).toBeInTheDocument();
    
    const formalButton = screen.getByRole('radio', { name: /formal/i });
    fireEvent.click(formalButton);
    
    await waitFor(() => {
      expect(screen.getByText('Formal description of the belief')).toBeInTheDocument();
    });
  });

  it('shows formal description when node has no plain_description', () => {
    const nodeWithoutPlain = { ...mockNode, plain_description: null };
    mockLookupPinnedData.mockReturnValue({ type: 'pov', pov: 'acc', node: nodeWithoutPlain });
    render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    
    expect(screen.getByText('Formal description of the belief')).toBeInTheDocument();
    const plainButton = screen.getByRole('radio', { name: /plain/i });
    expect(plainButton.textContent).toContain('…');
  });

  it('toggles mode with button click (no global Alt+P shortcut)', async () => {
    mockLookupPinnedData.mockReturnValue({ type: 'pov', pov: 'acc', node: mockNode });
    const user = userEvent.setup();
    render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    
    expect(screen.getByText('Plain language explanation')).toBeInTheDocument();
    
    const formalButton = screen.getByRole('radio', { name: /formal/i });
    await user.click(formalButton);
    
    await waitFor(() => {
      expect(screen.getByText('Formal description of the belief')).toBeInTheDocument();
    });
    
    const plainButton = screen.getByRole('radio', { name: /plain/i });
    await user.click(plainButton);
    
    await waitFor(() => {
      expect(screen.getByText('Plain language explanation')).toBeInTheDocument();
    });
  });

  it('never reads or writes to global localStorage', () => {
    const localStorageSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    
    mockLookupPinnedData.mockReturnValue({ type: 'pov', pov: 'acc', node: mockNode });
    render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    
    expect(localStorageSpy).not.toHaveBeenCalled();
    
    const formalButton = screen.getByRole('radio', { name: /formal/i });
    fireEvent.click(formalButton);
    
    expect(setItemSpy).not.toHaveBeenCalled();
    
    localStorageSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it('logs WARN when node has no plain_description and falls back to formal', () => {
    const recordSpy = vi.fn();
    vi.spyOn(flightRecorderModule, 'getGlobalRecorder').mockReturnValue({ record: recordSpy } as any);
    
    const nodeWithoutPlain = { ...mockNode, plain_description: null };
    mockLookupPinnedData.mockReturnValue({ type: 'pov', pov: 'acc', node: nodeWithoutPlain });
    render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system.error',
        component: 'LinkedNodePreview',
        level: 'warn',
        message: expect.stringContaining('acc-beliefs-001'),
      })
    );
  });

  it('renders conflict data correctly', () => {
    const conflictData = {
      type: 'conflict',
      conflict: {
        status: 'open',
        claim_label: 'Test Conflict',
        description: 'Conflict description',
        instances: [{ id: '1' }, { id: '2' }],
      },
    };
    mockLookupPinnedData.mockReturnValue(conflictData);
    render(<LinkedNodePreview nodeId="conflict-1" />);
    
    expect(screen.getByText('Conflict')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Test Conflict')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders policy data correctly', () => {
    const policyData = {
      type: 'policy',
      policy: {
        action: 'Implement AI regulations',
        description: 'Policy to regulate AI development',
      },
      referencingNodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
    };
    mockLookupPinnedData.mockReturnValue(policyData);
    render(<LinkedNodePreview nodeId="pol-001" />);
    
    expect(screen.getByText('Policy')).toBeInTheDocument();
    expect(screen.getByText('Implement AI regulations')).toBeInTheDocument();
    expect(screen.getByText('3 nodes')).toBeInTheDocument();
  });
});
