// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * t/521: the desktop `load-doc-titles` loader must not hand an identifier-only title (an arXiv
 * number such as `1703.06856v3`) to the debate model. It uses usableTitle (t/492), so such a
 * document is left out and a real title still passes through. Drives the real handler; the
 * sources root is a per-test temp dir.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sourcesRoot: '',
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn); } },
}));

vi.mock('../fileIO.js', () => ({
  getDataRootPath: () => h.sourcesRoot,
  discoverSources: () => [],
  loadSummary: () => null,
  loadSnapshot: () => null,
  resolveSourceDocument: () => null,
  loadDataConfig: () => ({ sources_root: h.sourcesRoot }),
  PROJECT_ROOT: h.sourcesRoot,
}));

import { registerSourceHandlers } from '../ipc/sourceHandlers.js';

function writeDoc(id: string, meta: Record<string, unknown>): void {
  const dir = path.join(h.sourcesRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
}

beforeEach(() => {
  h.handlers.clear();
  h.sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctitles-'));
  registerSourceHandlers();
});
afterEach(() => { fs.rmSync(h.sourcesRoot, { recursive: true, force: true }); });

describe('load-doc-titles: identifier-only titles are not titles (t/521)', () => {
  it('leaves out a document whose title is a bare arXiv id, and keeps a real title', () => {
    writeDoc('arxiv-1703-06856', { title: '1703.06856v3', url: 'https://arxiv.org/abs/1703.06856' });
    writeDoc('report-2024', { title: 'Frontier AI Safety Report', url: 'https://example.org/r' });
    const titles = (h.handlers.get('load-doc-titles') as () => Record<string, { title: string }> | undefined)();
    expect(titles).toBeDefined();
    expect(titles).not.toHaveProperty('arxiv-1703-06856');
    expect(titles?.['report-2024']?.title).toBe('Frontier AI Safety Report');
  });

  it('leaves out a document whose title equals its own doc id', () => {
    writeDoc('same-as-id', { title: 'same-as-id' });
    const titles = (h.handlers.get('load-doc-titles') as () => Record<string, { title: string }> | undefined)();
    expect(titles ?? {}).not.toHaveProperty('same-as-id');
  });
});
