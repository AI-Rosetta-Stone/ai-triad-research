// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * StorageBackend — abstraction over raw file I/O.
 *
 * Domain logic (fileIO.ts) delegates all disk/network I/O through this
 * interface. Two implementations:
 *   - FilesystemBackend  (Electron, local dev, current behavior)
 *   - GitHubAPIBackend   (Azure container deployment — Phase 1)
 *
 * All paths are absolute. Each method handles missing files/dirs gracefully
 * (no throws for ENOENT):
 *   - readFile   → returns null if file doesn't exist
 *   - writeFile  → auto-creates parent directories, atomic (tmp+rename)
 *   - listDir    → returns [] if directory doesn't exist
 *   - deleteFile → no-op if file doesn't exist
 *   - fileExists → returns false if file doesn't exist
 */

export interface StorageBackend {
  /** Short identity string for structured logs (e.g. 'filesystem', 'azure-blob', 'github-api'). */
  readonly backendName: string;

  /** Read a file as UTF-8. Returns null if the file does not exist.
   *  `opts.ref` pins the read to a specific ref (e.g. 'main') for shared data
   *  that lives on main rather than a per-user session branch (pipeline-
   *  generated taxonomy/source/summary data). Backends without branches
   *  ignore it.
   *  `opts.optional` signals the file may legitimately not exist — backends
   *  that log 404s can downgrade from error to debug level.
   *  `opts.consultOverlayOnPin` (t/4510): by default a pinned `opts.ref` skips
   *  the session overlay — the pin is asking for that ref's real content,
   *  same precedence as `fileExists` (t/4428#2). Pass `true` to keep
   *  consulting the overlay anyway; the one documented exception is
   *  `calibrationStore.ts`'s append-within-request flows, which pin to
   *  `'main'` while still needing to see the same request's own earlier
   *  append (which lands in the session overlay). Backends without branches
   *  ignore it. */
  readFile(filePath: string, opts?: { ref?: string; optional?: boolean; consultOverlayOnPin?: boolean }): Promise<string | null>;

  /** Write content to a file (UTF-8). Creates parent directories and uses
   *  atomic write (tmp+rename) where the backend supports it.
   *  `opts.ref` pins the write to a specific ref (e.g. 'main') for shared data
   *  that must commit straight to main rather than a per-user session branch
   *  (community submissions). Backends without branches ignore it.
   *  `opts.baseSha` (t/4187) is the version the caller last read, used as the
   *  write precondition instead of the backend's own cache-derived version —
   *  this is what actually catches a same-instance two-tabs conflict, since
   *  the cache's version is always "correct" from the server's point of view.
   *  Omitting it falls back to the backend's cache-derived version (WARN-logged
   *  where supported) — intended for direct non-route callers (pipelines,
   *  harvest writers) that have no client-loaded version to carry. Backends
   *  without version preconditions (FilesystemBackend) ignore it.
   *  Returns `{ version }` — the new version of the written content (git blob
   *  SHA for GitHubAPIBackend, real whether the write landed as a direct
   *  commit or a session-overlay entry), for the caller to hand back as the
   *  client's next write precondition (route `ETag`). FilesystemBackend and
   *  AzureBlobBackend version by `gitBlobSha(content)` too (t/4201, p/775#31)
   *  and enforce `baseSha` as a check-then-write precondition — not atomic,
   *  but sufficient for their single-node write path; Blob's own native
   *  ETag/If-Match preconditions are tracked separately (t/4191). */
  writeFile(filePath: string, content: string, opts?: { ref?: string; baseSha?: string }): Promise<{ version: string }>;

  /** List entries (files and directories) in a directory. Returns [] if the
   *  directory does not exist.
   *  `opts.ref` pins the listing to a specific ref (e.g. 'main') for shared
   *  directories that live on main rather than a per-user session branch.
   *  Backends without branches ignore it. */
  listDirectory(dirPath: string, opts?: { ref?: string }): Promise<string[]>;

  /** Delete a file. No-op if the file does not exist. */
  deleteFile(filePath: string): Promise<void>;

  /** Check whether a file or directory exists at the given path.
   *  `opts.ref` pins the check to a specific ref (e.g. 'main') for shared
   *  data that lives on main rather than a per-user session branch — same
   *  contract as `readFile`/`readBinaryFile` (t/4428). Backends without
   *  branches ignore it. */
  fileExists(filePath: string, opts?: { ref?: string }): Promise<boolean>;

  /** Read a file as a raw binary Buffer. Returns null if the file does not exist.
   *  `opts.ref` pins the read to a specific ref (e.g. 'main') for shared data
   *  that lives on main rather than a per-user session branch — same contract
   *  as `readFile` (t/4393). Backends without branches ignore it. */
  readBinaryFile(filePath: string, opts?: { ref?: string }): Promise<Buffer | null>;

  /** Write raw binary content to a file. Creates parent dirs; atomic where supported. */
  writeBinaryFile(filePath: string, content: Buffer, opts?: { ref?: string }): Promise<void>;

  /** Like readFile, but also returns the file's current version token for use
   *  as a later write's `baseSha` precondition (t/4187). Content and version
   *  are read atomically — they describe the same snapshot of the file.
   *  `version` is the GitHub blob SHA for GitHubAPIBackend. FilesystemBackend
   *  and AzureBlobBackend version by `gitBlobSha(content)` too (t/4201,
   *  p/775#31) and enforce `opts.baseSha` on `writeFile` as a check-then-write
   *  precondition — not atomic, but sufficient for their single-node write
   *  path; Blob's own native ETag/If-Match preconditions are tracked
   *  separately (t/4191). Optional so lightweight test-double StorageBackend
   *  implementations (many across the test suite) don't need a stub —
   *  callers fall back to `readFile` + `version: ''` when it's absent (see
   *  `readFileWithVersionOrFallback` in fileIO.ts). Every production backend
   *  (GitHubAPIBackend, AzureBlobBackend, FilesystemBackend) implements it. */
  readFileWithVersion?(filePath: string, opts?: { ref?: string }): Promise<{ content: string; version: string } | null>;

  /** t/4499: batched content read for many files on one ref, for callers
   *  (today: `nodeSourceIndex.ts`'s cold build) doing hundreds of small reads
   *  where per-file round trips dominate. Optional — only `GitHubAPIBackend`
   *  implements it (one GraphQL query per ~80 files replaces that many
   *  Contents-API calls); backends without a per-file round-trip cost
   *  (FilesystemBackend, AzureBlobBackend) have nothing to batch and don't
   *  implement it. `contents` holds only the paths that resolved to a real,
   *  non-truncated blob — a path missing from it (chunk failure, null or
   *  truncated blob) is the caller's job to read itself via `readFile`;
   *  `fallbackCount` is that absence count, `graphqlCost` the summed GraphQL
   *  point cost (a separate budget from REST's), for the caller to log
   *  alongside its own phase timing. Never throws. */
  readFilesBatch?(filePaths: string[], opts?: { ref?: string }): Promise<{ contents: Map<string, string>; fallbackCount: number; graphqlCost: number }>;
}
