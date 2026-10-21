// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4410 item D: the free-tier data-use disclosure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const bridgeGet = vi.fn();
const openSettings = vi.fn();
const record = vi.fn();
vi.mock('../../bridge/web-bridge', () => ({ bridgeGet: (...a: unknown[]) => bridgeGet(...a) }));
vi.mock('../../hooks/useSettingsDialog', () => ({
  useSettingsDialog: (sel: (s: { open: typeof openSettings }) => unknown) => sel({ open: openSettings }),
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

const { FreeTierDisclosure, FreeTierSettingsNote, FREE_TIER_DISCLOSURE_STORAGE_KEY } = await import('./FreeTierDisclosure');
const { FREE_TIER_NOTICE, FREE_TIER_SETTINGS_LINE, GEMINI_TERMS_URL } = await import('./freeTierDisclosureCopy');

const FREE = { level: 'free', serverProvidedKey: true, limits: { requestsPerMinute: 1, tokensPerDay: 1 }, allowedBackends: ['gemini'], principalName: null };

beforeEach(() => {
  vi.stubEnv('VITE_TARGET', 'web');
  localStorage.clear();
  bridgeGet.mockReset();
  openSettings.mockReset();
  record.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('FreeTierDisclosure', () => {
  it('shows to a user served by the free pool, with the terms link', async () => {
    bridgeGet.mockResolvedValue(FREE);
    render(<FreeTierDisclosure />);
    expect(await screen.findByRole('region', { name: FREE_TIER_NOTICE.title })).toHaveTextContent('Google may use what you send');
    expect(screen.getByRole('link', { name: FREE_TIER_NOTICE.terms })).toHaveAttribute('href', GEMINI_TERMS_URL);
    expect(bridgeGet).toHaveBeenCalledWith('/api/proxy/tier');
  });

  it.each([
    ['byok', { ...FREE, level: 'byok', serverProvidedKey: false }],
    ['platform', { ...FREE, level: 'platform', serverProvidedKey: false }],
    ['anonymous (no pool configured)', { ...FREE, level: 'anonymous', serverProvidedKey: false }],
  ])('does not show to a %s user', async (_name, tier) => {
    bridgeGet.mockResolvedValue(tier);
    const { container } = render(<FreeTierDisclosure />);
    await waitFor(() => expect(bridgeGet).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('"Got it" hides it for good in this browser', async () => {
    bridgeGet.mockResolvedValue(FREE);
    const { unmount } = render(<FreeTierDisclosure />);
    fireEvent.click(await screen.findByRole('button', { name: FREE_TIER_NOTICE.acknowledge }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(localStorage.getItem(FREE_TIER_DISCLOSURE_STORAGE_KEY)).toBe('ack');
    unmount();

    render(<FreeTierDisclosure />);
    await Promise.resolve();
    expect(screen.queryByRole('region')).toBeNull();
    expect(bridgeGet).toHaveBeenCalledTimes(1); // acknowledged: no tier fetch at all
  });

  it('"Add a key" acknowledges and opens Settings at API keys', async () => {
    bridgeGet.mockResolvedValue(FREE);
    render(<FreeTierDisclosure />);
    fireEvent.click(await screen.findByRole('button', { name: FREE_TIER_NOTICE.addKey }));
    expect(openSettings).toHaveBeenCalledWith('apiKeys');
    expect(localStorage.getItem(FREE_TIER_DISCLOSURE_STORAGE_KEY)).toBe('ack');
  });

  it('unreadable storage fails toward showing it, with a WARN', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    bridgeGet.mockResolvedValue(FREE);
    render(<FreeTierDisclosure />);
    expect(await screen.findByRole('region')).toBeInTheDocument();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', component: 'free-tier-disclosure' }));
    spy.mockRestore();
  });

  it('a failed tier fetch shows nothing and records a WARN', async () => {
    bridgeGet.mockRejectedValue(new Error('offline'));
    const { container } = render(<FreeTierDisclosure />);
    await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', type: 'system.error' })));
    expect(container.firstChild).toBeNull();
  });

  it('never runs outside the web build', () => {
    vi.stubEnv('VITE_TARGET', 'electron');
    render(<FreeTierDisclosure />);
    expect(bridgeGet).not.toHaveBeenCalled();
  });
});

describe('FreeTierSettingsNote (key-settings line)', () => {
  it('shows to a free-pool user even after the notice was acknowledged', async () => {
    localStorage.setItem(FREE_TIER_DISCLOSURE_STORAGE_KEY, 'ack');
    bridgeGet.mockResolvedValue(FREE);
    render(<FreeTierSettingsNote />);
    expect(await screen.findByText(FREE_TIER_SETTINGS_LINE, { exact: false })).toBeInTheDocument();
  });

  it('does not show to a user with their own key', async () => {
    bridgeGet.mockResolvedValue({ ...FREE, level: 'byok', serverProvidedKey: false });
    const { container } = render(<FreeTierSettingsNote />);
    await waitFor(() => expect(bridgeGet).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});
