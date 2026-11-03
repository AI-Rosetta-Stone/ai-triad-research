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
 *
 * t/4585: accepts raw bytes directly (a `Buffer`) so a caller that read a
 * response as `arrayBuffer()` can hash the original bytes, never a value
 * that already went through a decode (a BOM or an invalid UTF-8 sequence
 * changes bytes on decode-then-re-encode, which would desync the cached sha
 * from git's actual blob hash — see githubAPIBackend.ts's raw-fetch path).
 */
export function gitBlobSha(content: string | Buffer): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const header = `blob ${buf.byteLength}\0`;
  // codeql[js/weak-cryptographic-algorithm] -- git blob object-hash format (must match GitHub's sha); a version tag, not a security control
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}
