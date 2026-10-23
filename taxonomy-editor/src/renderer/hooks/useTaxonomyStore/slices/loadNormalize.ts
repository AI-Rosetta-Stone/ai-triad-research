// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The per-node normalization every POV file gets when the editor loads it. Shared by loadAll and
// reloadKeepingEdits (t/4439), so a reloaded node is prepared exactly like a loaded one before the merge
// compares it with the baseline.

import { normalizeNodeProperties } from '@lib/debate';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { stripInvalidLogicalForm } from '../../../utils/validation';
import type { PovTaxonomyFile } from '../../../types/taxonomy';

// t/3378: a per-load strip count above this is treated as systemic (not a one-off bad frame)
// and escalated from warn to error — CL's threshold from the t/3375 observability follow-up.
const LOGICAL_FORM_STRIP_SYSTEMIC_THRESHOLD = 5;

// t/3378: aggregate summary on top of the existing per-node WARN (t/3250) — the per-node
// records identify WHICH nodes were stripped; this summary makes the LOAD-WIDE blast radius
// visible so a mass strip (the t/3375 class) doesn't require counting individual log lines to notice.
function recordLogicalFormStripSummary(pov: string, strippedCount: number): void {
  if (strippedCount === 0) return;
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'taxonomy-store',
    level: strippedCount > LOGICAL_FORM_STRIP_SYSTEMIC_THRESHOLD ? 'error' : 'warn',
    message: `logical_form strip summary: ${strippedCount} frame(s) stripped on load (t/3378)`,
    data: { pov, strippedCount },
  });
}

/** Normalize a freshly read POV file's nodes in place (properties, malformed logical_form). Returns the file. */
export function normalizeLoadedPovFile(file: PovTaxonomyFile | null | undefined, pov: string): PovTaxonomyFile | null | undefined {
  if (!file?.nodes) return file;
  let stripped = 0;
  for (const node of file.nodes) {
    const rec = node as unknown as Record<string, unknown>;
    normalizeNodeProperties(rec);
    // t/3250: graceful-degrade a malformed proposed logical_form (WARN + omit, never drop the node).
    const lf = stripInvalidLogicalForm(rec);
    if (lf.removed) {
      stripped++;
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Stripped malformed node.logical_form (t/3250)', data: { pov, node_id: rec.id, issue: lf.issue } });
    }
  }
  recordLogicalFormStripSummary(pov, stripped);
  return file;
}
