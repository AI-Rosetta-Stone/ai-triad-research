// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationBarShareButton } from './LocationBarShareButton';
import { registerShareProvider, __resetShareProvidersForTest, type ShareProvider } from '../../navigation/shareProvider';
import type { PlaceInfo } from '../../navigation/types';

const isElectronModeMock = vi.fn(() => false);
const clipboardWriteTextMock = vi.fn();
vi.mock('@bridge', () => ({
  isElectronMode: () => isElectronModeMock(),
  api: { clipboardWriteText: (t: string) => clipboardWriteTextMock(t) },
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const place: PlaceInfo = { tool: 'opeds', placeKey: 'opeds:set-1', path: '/opeds/set-1', label: 'My op-ed', crumbs: [] };

function noConfirmProvider(overrides: Partial<ShareProvider> = {}): ShareProvider {
  return {
    label: 'Copy public link',
    needsConfirm: false,
    current: () => Promise.resolve(null),
    create: () => Promise.resolve('https://example.test/share/x'),
    ...overrides,
  };
}

describe('LocationBarShareButton', () => {
  beforeEach(() => {
    __resetShareProvidersForTest();
    isElectronModeMock.mockReturnValue(false);
    clipboardWriteTextMock.mockReset().mockResolvedValue(undefined);
  });

  it('renders nothing with no provider for the place', () => {
    const { container } = render(<LocationBarShareButton place={place} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing in Electron, even with a provider', async () => {
    isElectronModeMock.mockReturnValue(true);
    registerShareProvider('opeds', () => noConfirmProvider());
    const { container } = render(<LocationBarShareButton place={place} />);
    await waitFor(() => expect(container.querySelector('button')).toBeNull());
  });

  it('a provider with needsConfirm:false copies directly on click, no popover', async () => {
    registerShareProvider('opeds', () => noConfirmProvider());
    render(<LocationBarShareButton place={place} />);
    const btn = await screen.findByRole('button', { name: 'Copy public link' });
    await userEvent.click(btn);
    await waitFor(() => expect(clipboardWriteTextMock).toHaveBeenCalledWith('https://example.test/share/x'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a provider with needsConfirm:true shows the confirmation before the first publish', async () => {
    const create = vi.fn().mockResolvedValue('https://example.test/share/y');
    registerShareProvider('opeds', () => noConfirmProvider({ needsConfirm: true, contentLabel: 'op-ed', create }));
    render(<LocationBarShareButton place={place} />);
    const btn = await screen.findByRole('button', { name: 'Copy public link' });
    await userEvent.click(btn);

    expect(create).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Anyone with this link can view this op-ed, without signing in.');

    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clipboardWriteTextMock).toHaveBeenCalledWith('https://example.test/share/y'));
  });

  it('Cancel closes the confirmation without creating, and Esc does the same', async () => {
    const create = vi.fn();
    registerShareProvider('opeds', () => noConfirmProvider({ needsConfirm: true, contentLabel: 'op-ed', create }));
    render(<LocationBarShareButton place={place} />);
    const btn = await screen.findByRole('button', { name: 'Copy public link' });

    await userEvent.click(btn);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(btn).toHaveFocus(); // Esc/Cancel returns focus to the trigger

    await userEvent.click(btn);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('an already-shared item (current() resolves a URL) copies at once — no re-confirmation (TL point 2)', async () => {
    const create = vi.fn();
    registerShareProvider('opeds', () => noConfirmProvider({
      needsConfirm: true, contentLabel: 'op-ed', create, current: () => Promise.resolve('https://example.test/share/existing'),
    }));
    render(<LocationBarShareButton place={place} />);
    const btn = await screen.findByRole('button', { name: 'Copy public link' });
    await userEvent.click(btn);

    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(clipboardWriteTextMock).toHaveBeenCalledWith('https://example.test/share/existing'));
  });

  it('shows Un-share only when revoke is present on an already-shared item', async () => {
    registerShareProvider('opeds', () => noConfirmProvider({
      current: () => Promise.resolve('https://example.test/share/existing'),
      revoke: vi.fn().mockResolvedValue(undefined),
    }));
    render(<LocationBarShareButton place={place} />);
    await screen.findByRole('button', { name: 'Un-share' });
  });

  it('a failed clipboard write shows a visible, pre-selected fallback field — never silent (TL point 4)', async () => {
    clipboardWriteTextMock.mockRejectedValue(new Error('denied'));
    registerShareProvider('opeds', () => noConfirmProvider());
    render(<LocationBarShareButton place={place} />);
    const btn = await screen.findByRole('button', { name: 'Copy public link' });
    await userEvent.click(btn);

    const field = await screen.findByRole('textbox', { name: 'Public share link' });
    expect(field).toHaveValue('https://example.test/share/x');
    expect(screen.getByRole('button', { name: 'Copy this link' })).toBeInTheDocument();
  });
});
