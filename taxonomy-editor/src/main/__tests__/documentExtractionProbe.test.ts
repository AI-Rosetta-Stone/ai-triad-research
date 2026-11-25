// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/635 (t/634): the document-extraction-available probe. A pass answers true; any failure
 * (the extractor throws, its import fails, or it returns the wrong text) answers false with
 * one WARN and never throws; the probe runs once per process. The last case runs the real
 * lib extractor through its isolated child, as a dev build does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeDocumentExtraction, documentExtractionAvailable, resetDocumentExtractionProbe,
} from '../ipc/documentExtractionProbe.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDocumentExtractionProbe();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const probeWarnings = () => warn.mock.calls.filter(a => String(a[0]).includes('document extraction probe failed'));

describe('document-extraction-available probe (t/635)', () => {
  it('answers true when the extractor returns the sample', async () => {
    const extract = vi.fn(async (bytes: Uint8Array, name: string) => ({ text: new TextDecoder().decode(bytes) + ` (${name})` }));
    await expect(probeDocumentExtraction(async () => extract)).resolves.toBe(true);
    // The bytes are a Uint8Array, but from Node's TextEncoder realm, not jsdom's, so check by content.
    expect(extract).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(extract.mock.calls[0][0])).toBe('probe');
    expect(extract.mock.calls[0][1]).toBe('probe.txt');
    expect(probeWarnings()).toHaveLength(0);
  });

  it('answers false with one WARN, without throwing, when the extractor throws', async () => {
    const extract = async () => { throw new Error('Cannot find module pdfjs-dist'); };
    await expect(probeDocumentExtraction(async () => extract)).resolves.toBe(false);
    expect(probeWarnings()).toHaveLength(1);
    expect(String(probeWarnings()[0][0])).toContain('Cannot find module pdfjs-dist');
  });

  it('answers false when the extractor cannot be loaded at all', async () => {
    await expect(probeDocumentExtraction(async () => { throw new Error('import failed'); })).resolves.toBe(false);
    expect(probeWarnings()).toHaveLength(1);
  });

  it('answers false when the extractor returns text without the sample', async () => {
    await expect(probeDocumentExtraction(async () => async () => ({ text: '' }))).resolves.toBe(false);
  });

  it('probes once per process and caches the answer, including a failure', async () => {
    const load = vi.fn(async () => async () => { throw new Error('child crashed'); });
    const answers = await Promise.all([documentExtractionAvailable(load), documentExtractionAvailable(load), documentExtractionAvailable(load)]);
    expect(answers).toEqual([false, false, false]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(probeWarnings()).toHaveLength(1);
  });

  it('the real lib extractor passes the probe (dev build, isolated child)', async () => {
    await expect(probeDocumentExtraction()).resolves.toBe(true);
  }, 30000);
});
