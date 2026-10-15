// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import crypto from 'crypto';

/**
 * t/4187: git blob SHA-1 of UTF-8 file content — the same hash GitHub's
 * Contents/Trees API reports as a file's `sha` (git's object-hash format:
 * `sha1("blob " + byteLength + "\0" + content)`).
 *
 * Shared by GitHubAPIBackend (verifying a disk-cached file against its own
 * manifest entry) and, since t/4201 (p/775#31), by FilesystemBackend and
 * AzureBlobBackend as their write-precondition version: they have no
 * server-assigned SHA of their own, so they version local content by its
 * git blob hash instead.
 */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  const header = `blob ${buf.byteLength}\0`;
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}
