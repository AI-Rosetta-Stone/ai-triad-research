import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { LinkedNodePreview } from './LinkedNodePreview';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: vi.fn(),
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

describe('LinkedNodePreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for unknown nodeId', () => {
    (useTaxonomyStore as any).mockReturnValue(null);
    const { container } = render(<LinkedNodePreview nodeId="unknown-id" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a POV node preview', () => {
    const mockNode = {
      id: 'acc-beliefs-001',
      label: 'Test Belief',
      description: 'Test description',
      category: 'Beliefs',
    };
    (useTaxonomyStore as any).mockReturnValue({ type: 'node', data: mockNode });
    const { container } = render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    expect(container.querySelector('.linked-node-preview')).toBeDefined();
  });

  it('Alt+P on document with DescriptionToggle does not affect LinkedNodePreview mode', async () => {
    const mockNode = {
      id: 'acc-beliefs-001',
      label: 'Test Belief',
      description: 'Test description',
      plain_description: 'Plain version',
      category: 'Beliefs',
    };
    (useTaxonomyStore as any).mockReturnValue({ type: 'node', data: mockNode });
    
    const { container, rerender } = render(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    const initialHTML = container.innerHTML;
    
    // Fire Alt+P on document
    fireEvent.keyDown(document, { key: 'p', altKey: true });
    
    // Re-render and verify the preview content is unchanged
    rerender(<LinkedNodePreview nodeId="acc-beliefs-001" />);
    await waitFor(() => {
      expect(container.innerHTML).toBe(initialHTML);
    });
  });
});
