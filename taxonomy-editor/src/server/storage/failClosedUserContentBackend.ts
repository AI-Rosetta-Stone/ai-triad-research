// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/639 (incident t/629): the user-content backend a hosted profile gets when Azure Blob is unset or failed validation.
 *
 * Before this, `getUserContentBackend()` fell back to the primary backend, which on hosted is GitHubAPIBackend, so
 * user-private content (flight-recorder dumps, `users/<id>/...`, anonymous sessions) was committed to the PUBLIC data
 * repo. A hosted profile now refuses every user-content operation with a 503 instead: nothing reaches GitHub, and the
 * caller sees an actionable error. Taxonomy reads and writes, which use the primary backend, are unaffected; /readyz
 * already reports 503 in this state (blobBackendBoot). Chosen over refusing to boot so the read-only taxonomy keeps
 * serving while Blob is fixed (t/639#1 left the choice to ServerStorage).
 */

import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import type { StorageBackend } from './storageBackend.js';

export const USER_CONTENT_STORE_UNAVAILABLE = 'USER_CONTENT_STORE_UNAVAILABLE';

/** True in a hosted profile: production, or running as an Azure Container App. */
export function isHostedProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || !!env.CONTAINER_APP_NAME;
}

/** SO (p/269#14): fail closed. A hosted profile keeps the user-content fallback ONLY for a backend that is positively
 *  local (FilesystemBackend, backendName 'filesystem'). Anything else, including a future wrapper around
 *  GitHubAPIBackend that hides commitOverlay, is treated as possibly remote and refused. */
export function isPositivelyLocalBackend(b: StorageBackend): boolean {
  return b.backendName === 'filesystem';
}

export class FailClosedUserContentBackend implements StorageBackend {
  readonly backendName = 'fail-closed-user-content';

  constructor(private readonly reason: string) {}

  private refuse(op: string, filePath: string): never {
    // Logs the operation and the reason only, never the path's content; the path names which user-content class it was.
    log.storage.warn({ op, path: filePath, reason: this.reason },
      'user content refused: hosted profile without a working Blob backend; nothing is written to GitHub (t/639)');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'storage', level: 'warn',
      message: `user content ${op} refused (no Blob backend in a hosted profile): ${this.reason}`,
      data: { op, reason: this.reason },
    });
    throw new ActionableError({
      goal: 'Read or save your content',
      problem: 'User content storage is unavailable on this server right now, so nothing was read or saved.',
      location: `FailClosedUserContentBackend.${op}`,
      nextSteps: [
        'Retry later',
        'Operators: set AZURE_STORAGE_ACCOUNT_URL and the container variables, then restart (see /readyz)',
      ],
      httpStatus: 503,
      code: USER_CONTENT_STORE_UNAVAILABLE,
    });
  }

  async readFile(filePath: string): Promise<string | null> { return this.refuse('readFile', filePath); }
  async writeFile(filePath: string): Promise<{ version: string }> { return this.refuse('writeFile', filePath); }
  async writeFileIfAbsent(filePath: string): Promise<never> { return this.refuse('writeFileIfAbsent', filePath); }
  async listDirectory(dirPath: string): Promise<string[]> { return this.refuse('listDirectory', dirPath); }
  async deleteFile(filePath: string): Promise<void> { return this.refuse('deleteFile', filePath); }
  async fileExists(filePath: string): Promise<boolean> { return this.refuse('fileExists', filePath); }
  async readBinaryFile(filePath: string): Promise<Buffer | null> { return this.refuse('readBinaryFile', filePath); }
  async writeBinaryFile(filePath: string): Promise<void> { return this.refuse('writeBinaryFile', filePath); }
  async readFileWithVersion(filePath: string): Promise<{ content: string; version: string } | null> { return this.refuse('readFileWithVersion', filePath); }
}
