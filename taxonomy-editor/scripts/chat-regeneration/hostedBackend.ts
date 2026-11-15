// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Hosted community store for the chat regeneration tool (t/287).
 *
 * Mirrors the server's own wiring (src/server/storage/blobBackendInit.ts): the same account URL
 * and the same env-resolved container names, so the script reads and writes the store the web app
 * shows. There is no local fallback: if the hosted config is missing, the tool refuses to run
 * rather than writing to disk.
 */

import type { StorageBackend } from '../../src/server/storage/storageBackend.js';
import { userContentContainer } from '../../src/server/storage/userContentContainer.js';
import { communityContainer } from '../../src/server/storage/communityContainer.js';
import { ActionableError } from '../../../lib/debate/errors.js';

/** Logical path of the community chats directory, as the server lists it (community.ts). */
export const COMMUNITY_CHATS_DIR = 'community/chats';

/**
 * Build the hosted community backend from the environment.
 * Throws ActionableError when AZURE_STORAGE_ACCOUNT_URL is not set.
 */
export async function resolveCommunityBackend(env: NodeJS.ProcessEnv = process.env): Promise<StorageBackend> {
  const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL;
  if (!accountUrl) {
    throw new ActionableError({
      goal: 'Open the hosted community store for the chat regeneration tool',
      problem: 'AZURE_STORAGE_ACCOUNT_URL is not set, so there is no hosted store to read or write.',
      location: 'scripts/chat-regeneration/hostedBackend.ts -> resolveCommunityBackend',
      nextSteps: [
        'Run the tool with the same environment the web app uses (AZURE_STORAGE_ACCOUNT_URL and the container variables).',
        'The tool never falls back to local disk for the community store.',
      ],
    });
  }
  const { AzureBlobBackend } = await import('../../src/server/storage/azureBlobBackend.js');
  return new AzureBlobBackend({
    accountUrl,
    userContentContainer: userContentContainer(env),
    communityContainer: communityContainer(env),
  });
}
