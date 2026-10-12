import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    setApiKey: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@bridge', () => ({ api: mockApi }));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

import { ApiKeyDialog } from './ApiKeyDialog';

describe('ApiKeyDialog', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog with heading and input', () => {
    render(<ApiKeyDialog onClose={onClose} />);
    expect(screen.getByText('Configure API Key')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('AIza...')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('disables Save when input is empty', () => {
    render(<ApiKeyDialog onClose={onClose} />);
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('saves key and calls onClose on success', async () => {
    const user = userEvent.setup();
    render(<ApiKeyDialog onClose={onClose} />);

    await user.type(screen.getByPlaceholderText('AIza...'), 'AIzaSyTest123');
    await user.click(screen.getByText('Save'));

    expect(mockApi.setApiKey).toHaveBeenCalledWith('AIzaSyTest123');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows error message when save fails', async () => {
    mockApi.setApiKey.mockRejectedValueOnce(new Error('Network error'));
    const user = userEvent.setup();
    render(<ApiKeyDialog onClose={onClose} />);

    await user.type(screen.getByPlaceholderText('AIza...'), 'bad-key');
    await user.click(screen.getByText('Save'));

    expect(screen.getByText(/Network error/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<ApiKeyDialog onClose={onClose} />);
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when clicking the overlay', async () => {
    const user = userEvent.setup();
    const { container } = render(<ApiKeyDialog onClose={onClose} />);
    const overlay = container.querySelector('.dialog-overlay')!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not claim at-rest encryption unconditionally, and links to the protection doc', async () => {
    const user = userEvent.setup();
    render(<ApiKeyDialog onClose={onClose} />);
    expect(screen.queryByText(/stored encrypted on this machine/)).not.toBeInTheDocument();

    await user.click(screen.getByText('how is my API key protected?'));
    expect(mockApi.openExternal).toHaveBeenCalledWith(
      'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/security/api-key-protection.md',
    );
  });
});
