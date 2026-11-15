// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { resolveCommunityBackend, COMMUNITY_CHATS_DIR } from '../hostedBackend.js';

describe('resolveCommunityBackend (t/287)', () => {
  it('refuses to run without the hosted account URL, rather than falling back to disk', async () => {
    await expect(resolveCommunityBackend({})).rejects.toMatchObject({
      goal: expect.stringContaining('hosted community store'),
      problem: expect.stringContaining('AZURE_STORAGE_ACCOUNT_URL'),
    });
  });

  it('reads the community chats at the same logical path the server lists', () => {
    expect(COMMUNITY_CHATS_DIR).toBe('community/chats');
  });
});
