// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/631: the packed-extract gate. The positive run needs a packed desktop build (the DevOps packed-extract CI job runs
// it against app.asar). Here we check what can be checked without one:
//  - the failure path: with no packed layout, the check must exit non-zero, so a missing or broken packed app can
//    never pass the job;
//  - the required fixtures are good files: each extracts from source as its own format. Otherwise a broken fixture
//    would fail the job and look like a packaging fault;
//  - the gate needs BOTH formats (TL t/631#24): a packed app whose DOCX path fails must not pass on the PDF alone.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocumentText } from './extractDocumentText.js';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'packed-extract-check.cjs');
const fixtures = join(here, 'packed-fixtures');

/** A fake packed layout whose extractor is `source`, at the path the gate imports. Returns the resources dir. */
function fakePackedApp(source: string): string {
  const resources = mkdtempSync(join(tmpdir(), 'fake-packed-app-'));
  const dir = join(resources, 'app.asar', 'dist', 'main', 'lib', 'extraction');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(resources, 'app.asar', 'dist', 'main', 'lib', 'extraction', 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'extractDocumentText.js'), source);
  return resources;
}

function runGate(resources: string) {
  return spawnSync(process.execPath, [script, resources, fixtures], { encoding: 'utf8' });
}

// A stand-in extractor: reports the format from the file name, and throws for the names in FAIL.
const stubExtractor = (fail: string[]) => `
const FAIL = ${JSON.stringify(fail)};
export async function extractDocumentText(bytes, name) {
  if (name.includes('image-only')) throw Object.assign(new Error('no text'), { code: 'EMPTY_DOCUMENT' });
  if (FAIL.some((f) => name.endsWith(f))) throw Object.assign(new Error('parser missing'), { code: 'EXTRACTION_FAILED' });
  return { format: name.endsWith('.docx') ? 'docx' : 'pdf', text: 'some extracted words' };
}
`;

describe('packed-extract-check gate (t/631)', () => {
  it('fails (non-zero) when there is no packed app.asar to extract from', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-packed-app-'));
    try {
      const run = runGate(empty);
      expect(run.status).not.toBe(0);
      expect(run.stdout).toMatch(/FATAL/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('passes when both the PDF and the DOCX extract, printing each format by name', () => {
    const resources = fakePackedApp(stubExtractor([]));
    try {
      const run = runGate(resources);
      expect(run.stdout).toMatch(/t276-fixture-text\.pdf: OK format=pdf words=\d+/);
      expect(run.stdout).toMatch(/t276-fixture-text\.docx: OK format=docx words=\d+/);
      expect(run.stdout).toMatch(/t276-fixture-image-only\.pdf: THREW code=EMPTY_DOCUMENT/); // expected, not a failure
      expect(run.status).toBe(0);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  it.each([
    ['the DOCX does not extract (PDF alone must not pass)', ['.docx']],
    ['the PDF does not extract', ['text.pdf']],
  ])('fails when %s', (_label, fail) => {
    const resources = fakePackedApp(stubExtractor(fail));
    try {
      const run = runGate(resources);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/THREW code=EXTRACTION_FAILED/);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  it('fails when a required fixture comes back as the wrong format', () => {
    const wrong = `export async function extractDocumentText(bytes, name) {
      if (name.includes('image-only')) throw Object.assign(new Error('no text'), { code: 'EMPTY_DOCUMENT' });
      return { format: 'txt', text: 'words' };
    }`;
    const resources = fakePackedApp(wrong);
    try {
      const run = runGate(resources);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/WRONG expected format=docx/);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});

describe('packed-extract fixtures are good files (t/631)', () => {
  it.each([
    ['t276-fixture-text.pdf', 'pdf'],
    ['t276-fixture-text.docx', 'docx'],
  ])('%s extracts from source as %s, with text', async (name, format) => {
    const result = await extractDocumentText(new Uint8Array(readFileSync(join(fixtures, name))), name);
    expect(result.format).toBe(format);
    expect(result.text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(50);
  });
});
