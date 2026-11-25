// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/634 / t/635: can this process extract a document at all? The renderer hides the desktop
 * Document source until this says yes (t/631: a packed app's isolated parser can't load).
 *
 * Probes once per process by running the real `extractDocumentText` on a tiny built-in text
 * sample. TXT goes through the same isolated child as PDF and DOCX (t/426), so a pass means a
 * real pick can extract too. The result is cached for the process; a failure records one WARN
 * with the reason. Never throws: any failure, including a failed import, answers false.
 *
 * Lifts itself when t/631 lands, because the probe starts passing.
 */

import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

type Extractor = (bytes: Uint8Array, fileName: string) => Promise<{ text: string }>;

const PROBE_TEXT = 'probe';
const PROBE_FILE = 'probe.txt';

async function loadExtractor(): Promise<Extractor> {
  const { extractDocumentText } = await import('../../../../lib/extraction/extractDocumentText.js');
  return extractDocumentText;
}

/** Runs the probe once; `load` is injectable for tests. */
export async function probeDocumentExtraction(load: () => Promise<Extractor> = loadExtractor): Promise<boolean> {
  try {
    const extract = await load();
    const { text } = await extract(new TextEncoder().encode(PROBE_TEXT), PROBE_FILE);
    if (!text.includes(PROBE_TEXT)) throw new Error(`probe extracted unexpected text (${text.length} chars)`);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'systemHandlers', level: 'warn',
      message: `document-extraction-available: extraction probe failed, desktop Document source hidden: ${reason}`,
      error: { name: (err as Error)?.name ?? 'Error', message: reason, stack: (err as Error)?.stack },
    });
    console.warn(`[systemHandlers] WARN document extraction probe failed; Document source hidden: ${reason}`);
    return false;
  }
}

let cached: Promise<boolean> | null = null;

/** The cached answer for this process; the first call starts the probe. */
export function documentExtractionAvailable(load?: () => Promise<Extractor>): Promise<boolean> {
  if (!cached) cached = probeDocumentExtraction(load);
  return cached;
}

/** Test seam: forget the cached answer. */
export function resetDocumentExtractionProbe(): void {
  cached = null;
}
