// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Save-failure record + message, extracted out of taxonomyDataSlice.ts for its line-count
// budget (t/4197, p/775#45/#46). t/4186/t/4197: WRITE_CONFLICT and BASE_VERSION_REQUIRED
// (p/772#1, p/775#24) both keep `dirty` and never show success. t/4221 (SO condition C3, e/302#4):
// so does VERSION_UNAVAILABLE, the 503 when the server couldn't look up the file's version (a GitHub
// outage) — fail closed, never at the cost of typed work. The bridge
// (web-bridge/taxonomyVersions.ts) already crafts a one-line, code-specific `.problem` for each
// — reuse it via mapErrorToUserMessage rather than re-authoring the text here, so the two layers
// can't drift.

import { SAVE_KEPT_CODES } from '../../../bridge/taxonomyVersions';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

type FlightRecordInput = Parameters<NonNullable<ReturnType<typeof getGlobalRecorder>>['record']>[0];

const codeOf = (err: unknown): string => (err as { code?: string }).code ?? '';

/** A save refused with one of the bridge's own codes: shown verbatim, and the edits are kept. */
export const isSaveConflict = (err: unknown): boolean => (SAVE_KEPT_CODES as readonly string[]).includes(codeOf(err));

export function saveFailureRecord(err: unknown, saveStart: number): FlightRecordInput {
  const duration_ms = Math.round(performance.now() - saveStart);
  if (codeOf(err) === 'VERSION_UNAVAILABLE') return { type: 'state.error', component: 'taxonomy-store', level: 'warn', message: 'save.version_unavailable', data: { code: 'VERSION_UNAVAILABLE', duration_ms, edits_kept: true } };
  if (isSaveConflict(err)) return { type: 'state.error', component: 'taxonomy-store', level: 'warn', message: 'save.conflict', data: { code: codeOf(err), duration_ms } };
  return { type: 'state.error', component: 'taxonomy-store', level: 'error', message: 'save.failed', data: { error: String(err), duration_ms }, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } };
}

export const saveErrorText = (err: unknown): string => isSaveConflict(err) ? mapErrorToUserMessage(err) : `Save failed: ${mapErrorToUserMessage(err)}`;
