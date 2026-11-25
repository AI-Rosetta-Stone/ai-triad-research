// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/517: the ref callers pass to pin a read to the shared base data rather than the caller's session
 * branch. Its value is the literal 'main' for historical reasons, but it is NOT a branch name: the
 * GitHub backend maps it to its base branch (GITHUB_BRANCH, default 'main'; t/505), so on staging a
 * pinned read reads `staging`. Use this name instead of the literal so call sites say what they mean.
 * Kept in its own small module so fileIO, nodeSourceIndex and the others can use it without importing
 * githubAPIBackend.ts.
 */
import { STORAGE_MODE } from '../config.js';

export const BASE_BRANCH_REF = 'main';

/** The branch a base-pinned read actually reads, for log lines (t/517; #5385 did this for one site).
 *  Only the GitHub backend maps the alias; the filesystem and blob backends ignore refs. */
export function baseBranchForLogs(): string {
  return STORAGE_MODE === 'github-api' ? (process.env.GITHUB_BRANCH ?? BASE_BRANCH_REF) : BASE_BRANCH_REF;
}
