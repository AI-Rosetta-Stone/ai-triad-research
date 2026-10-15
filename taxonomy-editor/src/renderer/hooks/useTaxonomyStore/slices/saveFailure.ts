// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Save-failure record + message, extracted out of taxonomyDataSlice.ts for its line-count
// budget (t/4197, p/775#45/#46). t/4186/t/4197: WRITE_CONFLICT and BASE_VERSION_REQUIRED
// (p/772#1, p/775#24) both keep `dirty` and never show success. The bridge
// (web-bridge/taxonomyVersions.ts) already crafts a one-line, code-specific `.problem` for each
// — reuse it via mapErrorToUserMessage rather than re-authoring the text here, so the two layers
// can't drift.

import { SAVE_CONFLICT_CODES } from '../../../bridge/taxonomyVersions';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

type FlightRecordInput = Parameters<NonNullable<ReturnType<typeof getGlobalRecorder>>['record']>[0];

export const isSaveConflict = (err: unknown): boolean =>
  (SAVE_CONFLICT_CODES as readonly string[]).includes((err as { code?: string }).code ?? '');

export function saveFailureRecord(err: unknown, saveStart: number): FlightRecordInput {
  const duration_ms = Math.round(performance.now() - saveStart);
  if (isSaveConflict(err)) return { type: 'state.error', component: 'taxonomy-store', level: 'warn', message: 'save.conflict', data: { code: (err as { code?: string }).code, duration_ms } };
  return { type: 'state.error', component: 'taxonomy-store', level: 'error', message: 'save.failed', data: { error: String(err), duration_ms }, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } };
}

export const saveErrorText = (err: unknown): string => isSaveConflict(err) ? mapErrorToUserMessage(err) : `Save failed: ${mapErrorToUserMessage(err)}`;
