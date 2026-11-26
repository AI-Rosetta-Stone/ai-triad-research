// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/631: the isolated parser's store must be found from the child's own location, in the source tree (pnpm) and in a
// packed app (no lib/node_modules, the packages sit next to the app's code). These tests build both layouts on disk.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parserStoreRootFor } from './isolatedParse.js';

function pkg(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
}

describe('parserStoreRootFor (t/631)', () => {
  it('packed layout: finds the node_modules next to the app code, not lib/node_modules', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'parser-packed-')));
    try {
      // app.asar.unpacked/node_modules/pdfjs-dist, and the child at app.asar.unpacked/dist/main/lib/isolated/child.mjs
      pkg(join(root, 'node_modules'), 'pdfjs-dist');
      const child = join(root, 'dist', 'main', 'lib', 'isolated', 'child.mjs');
      mkdirSync(join(root, 'dist', 'main', 'lib', 'isolated'), { recursive: true });
      writeFileSync(child, '');
      expect(parserStoreRootFor(child)).toBe(join(root, 'node_modules'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('source tree (pnpm): finds the .pnpm store that the real package lives in', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'parser-pnpm-')));
    try {
      const store = join(root, 'node_modules', '.pnpm');
      pkg(join(store, 'pdfjs-dist@6.5.438', 'node_modules'), 'pdfjs-dist');
      const libNm = join(root, 'lib', 'node_modules');
      mkdirSync(libNm, { recursive: true });
      // lib/node_modules/pdfjs-dist links to the store, as pnpm does
      symlinkSync(join(store, 'pdfjs-dist@6.5.438', 'node_modules', 'pdfjs-dist'), join(libNm, 'pdfjs-dist'), 'junction');
      const child = join(root, 'lib', 'extraction', 'isolated', 'child.mjs');
      mkdirSync(join(root, 'lib', 'extraction', 'isolated'), { recursive: true });
      writeFileSync(child, '');
      expect(parserStoreRootFor(child)).toBe(store);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// t/631: a packed app's module path is under app.asar; the child must be forked from app.asar.unpacked instead.
describe('unpackedPath mapping (t/631)', () => {
  it('maps a packed app.asar path to app.asar.unpacked and leaves other paths alone', async () => {
    const mod = await import('./isolatedParse.js');
    expect(mod.unpackedPathForTest('C:\\r\\resources\\app.asar\\dist\\main\\lib\\isolated\\child.mjs'))
      .toBe('C:\\r\\resources\\app.asar.unpacked\\dist\\main\\lib\\isolated\\child.mjs');
    expect(mod.unpackedPathForTest('/src/lib/extraction/isolated/child.mjs')).toBe('/src/lib/extraction/isolated/child.mjs');
    expect(mod.unpackedPathForTest('/r/app.asar.unpacked/dist/child.mjs')).toBe('/r/app.asar.unpacked/dist/child.mjs');
  });
});
