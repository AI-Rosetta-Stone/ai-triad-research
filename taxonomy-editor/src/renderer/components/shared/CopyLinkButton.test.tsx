// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyLinkButton } from './CopyLinkButton';

const getWebAppUrlMock = vi.fn();
const clipboardWriteTextMock = vi.fn();
vi.mock('@bridge', () => ({
  api: { getWebAppUrl: () => getWebAppUrlMock(), clipboardWriteText: (t: string) => clipboardWriteTextMock(t) },
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

describe('CopyLinkButton', () => {
  beforeEach(() => {
    getWebAppUrlMock.mockReset().mockResolvedValue('https://example.test');
    clipboardWriteTextMock.mockReset().mockResolvedValue(undefined);
  });

  it('copies baseUrl + hash via the shared clipboard hook', async () => {
    render(<CopyLinkButton hash="/chat/c1" />);
    const btn = await screen.findByRole('button', { name: 'Copy link' });
    await userEvent.click(btn);
    await waitFor(() => expect(clipboardWriteTextMock).toHaveBeenCalledWith('https://example.test/chat/c1'));
  });

  it('is disabled when the web app URL cannot be resolved', async () => {
    getWebAppUrlMock.mockResolvedValue(null);
    render(<CopyLinkButton hash="/chat/c1" />);
    const btn = await screen.findByRole('button', { name: 'Copy link' });
    expect(btn).toBeDisabled();
  });

  it('on a clipboard failure, shows a visible pre-selected field instead of failing silently (TL point 4)', async () => {
    clipboardWriteTextMock.mockRejectedValue(new Error('denied'));
    render(<CopyLinkButton hash="/chat/c1" />);
    const btn = await screen.findByRole('button', { name: 'Copy link' });
    await userEvent.click(btn);

    const field = await screen.findByRole('textbox', { name: 'Copy link' });
    expect(field).toHaveValue('https://example.test/chat/c1');
    expect(screen.getByRole('button', { name: 'Copy this link' })).toBeInTheDocument();
  });
});
