// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4334#48 (caught live on prod): `sources-index.json` is shared,
 * pipeline-generated data — like community submissions and calibration logs,
 * the other `ref: 'main'` reads in this codebase — not per-user content.
 * Without the pin, `readFile`'s default (the request's effective session-
 * branch ref) 404s until the user's own session branch happens to include
 * the commit that added/updated the file, hiding every newer `main` file
 * from them indefinitely — exactly what the PI's real session hit.
 *
 * A separate file from `sourcesIndexReader.test.ts`: `getBackend` must be
 * mocked to actually assert the call shape (`FilesystemBackend`, which that
 * file exercises for real, has no ref/branch concept at all), and `vi.mock`
 * is file-scoped — mocking it here would silently break that file's
 * real-backend tests if done in the same module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn<[string, unknown?], Promise<string | null>>() }));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../storage/fileIO.js', () => ({ getBackend: () => ({ readFile: readFileMock }) }));

describe('sourcesIndexReader always reads ref: main (t/4334#48)', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    readFileMock.mockResolvedValue(null);
  });

  it('passes ref: "main" on every read, regardless of the caller\'s own session branch', async () => {
    const { loadSourcesIndex } = await import('../storage/sourcesIndexReader.js');
    await loadSourcesIndex();

    expect(readFileMock).toHaveBeenCalledTimes(1);
    const [, opts] = readFileMock.mock.calls[0];
    expect(opts).toMatchObject({ ref: 'main' });
  });
});
