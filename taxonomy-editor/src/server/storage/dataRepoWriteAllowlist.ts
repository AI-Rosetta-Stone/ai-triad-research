// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/638 (incident t/629): the data-repo paths GitHubAPIBackend may commit. An ALLOWLIST, not a denylist (TL p/50#181,
 * Security p/93#84): anything not listed is refused, so a new writer has to be added here, with its reason, before it
 * can reach the public data repo. API commits ignore .gitignore, which is how flight-recorder dumps (one holding a
 * Gemini key) and users/<id>/ files reached the public repo.
 *
 * Each entry names the writer that needs it (inventory of primary-backend writes on main bccd88526, t/638#2). Paths are
 * data-repo relative, as GitHubAPIBackend.toRepoPath() produces them.
 *
 * **This file is a security control: changes need Security review** (Security p/228#32).
 *
 * Deliberately NOT listed: preferences/ (routes/preferences.ts per-user files; moving to the user-content backend). Any
 * user-generated content stays out until the PI answers whether it belongs in the public repo (TL p/50#183).
 */

import { ActionableError } from '../../../../lib/debate/errors.js';

/** A safe single path segment (no '/', no '..'). */
const SEG = '[A-Za-z0-9_-]+';

/** The taxonomy files the server writes under taxonomy/<active dir>/. The active dir is a single safe segment
 *  (default Origin); its value is not trusted to be anything more (routes/meta.ts PUT /api/taxonomy-dir/active). */
const TAXONOMY_FILES = [
  'accelerationist', 'safetyist', 'skeptic', 'situations', 'cross-cutting', // fileIO.writeTaxonomyFile, harvestStore
  'edges', // fileIO.writeEdgesFile (routes/edges.ts)
  'aggregated-cruxes', // fileIO.writeAggregatedCruxes (routes/conflicts.ts)
  'policy_actions', // routes/policyRegistry.ts recount
  'pov-tag-proposals', // routes/povTagProposals.ts review
];

const ALLOWED: ReadonlyArray<{ re: RegExp; writer: string }> = [
  { re: new RegExp(`^taxonomy/${SEG}/(?:${TAXONOMY_FILES.join('|')})\\.json$`), writer: 'taxonomy edits (writeTaxonomyFile, edges, cruxes, policy registry, POV tag proposals, harvest)' },
  { re: new RegExp(`^conflicts/${SEG}\\.json$`), writer: 'conflicts (conflictsFileIO conflicts.json; harvestStore conflict and verdict files)' },
  { re: /^taxonomy-proposal[A-Za-z0-9_.-]*\.json$/, writer: 'fileIO.saveProposal (routes/sources.ts PUT /api/proposals/:filename)' },
  // Security (p/228#34) checked the contents: metrics only, 0 id fields, 0 emails. Identity fields are dropped at promote
  // time (calibrationStore.stripIdentityFields).
  { re: /^calibration\/integration-log\.jsonl$/, writer: 'calibrationStore.appendIntegrationRecord (admin promote/reject)' },
  { re: /^calibration\/core\/(?:calibration-log|extraction-metrics)\.jsonl$/, writer: 'calibrationStore.promoteCalibrationEntries' },
  { re: /^calibration\/core\/lineage-enrichments\.json$/, writer: 'calibrationStore.promoteLineageEnrichments' },
  // Security (p/228#34), TL (p/50#185): only the field set in harvestStore.HARVEST_COMMITTED_FIELDS is written; no user text.
  { re: /^harvests\/(?:concept|manifest)-\d+\.json$/, writer: 'harvestStore.harvestQueueConcept / harvestSaveManifest (field-filtered)' },
];

export const DATA_REPO_PATH_REFUSED = 'DATA_REPO_PATH_REFUSED';

/** True when GitHubAPIBackend may commit `repoPath` to the data repo. */
export function isCommittableDataRepoPath(repoPath: string): boolean {
  if (repoPath.includes('..') || repoPath.startsWith('/') || repoPath.includes('\\')) return false;
  return ALLOWED.some(a => a.re.test(repoPath));
}

/** The class of a refused path, for logs: its first segment (or the file pattern at the root). Never the content, and
 *  never the full path, which can carry a user id. */
export function dataRepoPathClass(repoPath: string): string {
  const first = repoPath.split('/')[0] ?? '';
  if (!repoPath.includes('/')) return first.endsWith('.jsonl') ? 'root:*.jsonl' : `root:${first.replace(/[^.]*\./, '*.')}`;
  if (/^anon/i.test(first)) return 'anon*';
  return `${first}/`;
}

export function dataRepoPathRefusedError(repoPath: string, op: string): ActionableError {
  return new ActionableError({
    goal: 'Write to the data repository',
    problem: `The path class '${dataRepoPathClass(repoPath)}' is not on the data-repo write allowlist, so it was not written (t/638).`,
    location: `GitHubAPIBackend.${op}`,
    nextSteps: [
      'User content belongs in the user-content (Blob) backend, not the data repo',
      'If this is a new legitimate data-repo file, add it to storage/dataRepoWriteAllowlist.ts with its writer, reviewed by Security',
    ],
    httpStatus: 403,
    code: DATA_REPO_PATH_REFUSED,
  });
}
