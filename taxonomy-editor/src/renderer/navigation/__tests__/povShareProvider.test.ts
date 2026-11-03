// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { getShareProvider } from '../shareProvider';
import type { PlaceInfo } from '../types';
import '../povShareProvider'; // self-registers for 'taxonomy' at import time

const place = (placeKey: string): PlaceInfo => ({ tool: 'taxonomy', placeKey, path: '/x', label: 'x', crumbs: [] });

describe('povShareProvider', () => {
  it('resolves for a POV node (acc- prefix), static and no revoke/confirm', async () => {
    const provider = getShareProvider(place('taxonomy:acc-bdi-001'));
    expect(provider).not.toBeNull();
    expect(provider!.needsConfirm).toBe(false);
    expect(provider!.revoke).toBeUndefined();
    await expect(provider!.create()).resolves.toContain('/share/pov/acc-bdi-001');
    await expect(provider!.current()).resolves.toContain('/share/pov/acc-bdi-001');
  });

  it('resolves for safetyist (saf-) and skeptic (skp-) node ids', () => {
    expect(getShareProvider(place('taxonomy:saf-bdi-002'))).not.toBeNull();
    expect(getShareProvider(place('taxonomy:skp-bdi-003'))).not.toBeNull();
  });

  it('returns null for a situation node (sit- prefix) — POV v1 scope only', () => {
    expect(getShareProvider(place('taxonomy:sit-001'))).toBeNull();
  });

  it('returns null with no node selected (taxonomy:none)', () => {
    expect(getShareProvider(place('taxonomy:none'))).toBeNull();
  });
});
