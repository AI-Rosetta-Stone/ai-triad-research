// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getShareProvider } from '../../navigation/shareProvider';
import type { PlaceInfo } from '../../navigation/types';

const shareOpEdSetMock = vi.fn();
const unshareOpEdSetMock = vi.fn();
vi.mock('@bridge', () => ({
  api: { shareOpEdSet: (id: string) => shareOpEdSetMock(id), unshareOpEdSet: (id: string) => unshareOpEdSetMock(id) },
}));

import './opedShareProvider'; // self-registers for 'opeds' at import time

const place = (placeKey: string): PlaceInfo => ({ tool: 'opeds', placeKey, path: '/x', label: 'x', crumbs: [] });

describe('opedShareProvider', () => {
  beforeEach(() => {
    shareOpEdSetMock.mockReset();
    unshareOpEdSetMock.mockReset();
  });

  it('returns null for the library (opeds:none)', () => {
    expect(getShareProvider(place('opeds:none'))).toBeNull();
  });

  it('resolves for an op-ed item, requires confirmation, names "op-ed"', () => {
    const provider = getShareProvider(place('opeds:set-1'));
    expect(provider).not.toBeNull();
    expect(provider!.needsConfirm).toBe(true);
    expect(provider!.contentLabel).toBe('op-ed');
  });

  it('create() mints via the same bridge call ShareOpEdControl uses, and is idempotent client-side (cached)', async () => {
    shareOpEdSetMock.mockResolvedValue({ shareId: 'abc', url: '/share/oped/abc' });
    const provider = getShareProvider(place('opeds:set-2'))!;

    const url1 = await provider.create();
    expect(url1).toContain('/share/oped/abc');
    expect(await provider.current()).toBe(url1);

    // A second create() call still goes through api.shareOpEdSet — which is itself idempotent
    // server-side (opedShareStore.ts: "an already-shared set refreshes its existing shareId").
    shareOpEdSetMock.mockResolvedValue({ shareId: 'abc', url: '/share/oped/abc' });
    const url2 = await provider.create();
    expect(url2).toBe(url1);
    expect(shareOpEdSetMock).toHaveBeenCalledTimes(2);
  });

  it('revoke() calls unshareOpEdSet and clears the cached current()', async () => {
    shareOpEdSetMock.mockResolvedValue({ shareId: 'xyz', url: '/share/oped/xyz' });
    unshareOpEdSetMock.mockResolvedValue({ ok: true });
    const provider = getShareProvider(place('opeds:set-3'))!;

    await provider.create();
    expect(await provider.current()).not.toBeNull();

    await provider.revoke!();
    expect(unshareOpEdSetMock).toHaveBeenCalledWith('set-3');
    expect(await provider.current()).toBeNull();
  });
});
