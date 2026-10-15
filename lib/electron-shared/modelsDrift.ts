// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// `npm run models:drift` (t/4159): has ai-models.json drifted from the vendors' live model catalogs?
//
// Runs the t/3553 refresh as a DRY RUN in catalog-only mode: vendor /models listings only, never a completion and
// never Claude's paid candidate probe, and nothing is written. Drift is anything a real refresh would act on: a
// refusal (a code-referenced model is gone, a partial catalog, ...), a proposal to move a default/tier/chain, or a
// registered model the vendor no longer lists at all (t/4199). Models a refresh would merely curate away (older in
// their family, or filtered out by type) are reported as info, not drift, so a new vendor release isn't an alert.
//
// Exit codes: 0 no drift · 1 drift (report printed) · 2 nothing could be checked (every backend skipped).
// A backend without a key is skipped with a WARN. Keys come from the environment and are never printed: any key
// value that turns up in an error message is redacted before output.
//
// Known blind spot (t/4159#9): a model the vendor still lists but that rejects our request shape (Haiku 5.5's
// `temperature` 400) is not drift by this definition; only a live call finds it.

import path from 'path';
import { fileURLToPath } from 'url';
import { refreshAIModels, type RefreshResult } from './modelDiscovery.js';
import { BACKEND_KEY_ENV_VARS, resolveGenericFallbackKey } from '../ai-client/apiKeyFallback.js';

/** The vendor-catalog backends the refresh discovers. Ollama is local, not a vendor, and is always skipped. */
export const DRIFT_BACKENDS = ['gemini', 'claude', 'groq', 'deepseek'] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** A backend's key from the environment: its own variable(s), then the gemini-only AI_API_KEY fallback. */
export function envLoadApiKey(backend: string, env: Env = process.env): string | null {
  for (const name of BACKEND_KEY_ENV_VARS[backend] ?? []) {
    const value = env[name];
    if (value) return value;
  }
  return resolveGenericFallbackKey(backend, env) ?? null;
}

/** Replace every *_API_KEY value present in `env` with *** (defence in depth: provider errors can echo input). */
export function redactKeys(text: string, env: Env = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (name.endsWith('_API_KEY') && value && value.length >= 8) out = out.split(value).join('***');
  }
  return out;
}

export interface DriftReport {
  skipped: { backend: string; reason: string }[];
  allSkipped: boolean;
  drift: string[];
  info: string[];
}

/** The useful line of a backend error: an ActionableError's `Error:` (problem) line, else the first non-empty line. */
function reasonOf(s: string | undefined): string {
  const lines = (s ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const problem = lines.find(l => l.startsWith('Error:'));
  return (problem ? problem.slice('Error:'.length).trim() : lines[0]) || 'not discovered';
}

/** Classify a dry-run, catalog-only refresh result. Pure. */
export function assessDrift(result: RefreshResult): DriftReport {
  const skipped = DRIFT_BACKENDS
    .filter(b => !result[b].ok)
    .map(b => ({ backend: b, reason: reasonOf(result[b].error) }));
  const drift: string[] = [];
  if (result.refusal) drift.push(`refresh refused (${result.refusal.reason}): ${result.configWarning ?? ''}`.trim());
  else if (result.proposal && result.proposal.changes.length > 0) {
    drift.push(`a refresh would change ${result.proposal.changes.length} slot(s): ${result.proposal.changes.map(c => `${c.slot} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; ')}`);
  }
  const delisted = result.delistedModels ?? [];
  if (delisted.length > 0) drift.push(`registered model(s) the vendor no longer lists: ${delisted.join(', ')}`);
  const info = (result.pinnedCandidates ?? []).map(p => `newer model in a pinned family: ${p.newerInFamily} (pinned ${p.pinned})`);
  const curated = (result.removedModels ?? []).filter(id => !delisted.includes(id));
  if (curated.length > 0) info.push(`a refresh would also curate away (still listed; superseded in their family or filtered by type): ${curated.join(', ')}`);
  return { skipped, allSkipped: skipped.length === DRIFT_BACKENDS.length, drift, info };
}

export interface DriftRunDeps {
  repoRoot: string;
  env?: Env;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** Run the check and print the report. Returns the exit code. */
export async function runModelsDrift(deps: DriftRunDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const say = (out: (l: string) => void, l: string) => out(redactKeys(l, env));

  const result = await refreshAIModels(
    { loadApiKey: (b) => envLoadApiKey(b, env), repoRoot: deps.repoRoot },
    { dryRun: true, catalogOnly: true, skipBackends: ['ollama'] },
  );
  const report = assessDrift(result);
  for (const s of report.skipped) say(warn, `WARN models:drift: ${s.backend} not checked: ${s.reason}`);
  if (report.allSkipped) {
    say(warn, 'WARN models:drift: no backend could be checked (no keys, or every catalog read failed); nothing was compared');
    return 2;
  }
  for (const i of report.info) say(log, `models:drift: info: ${i}`);
  const checked = DRIFT_BACKENDS.filter(b => result[b].ok);
  if (report.drift.length === 0) {
    say(log, `models:drift: no drift (${checked.join(', ')} checked against their live catalogs)`);
    return 0;
  }
  say(log, `models:drift: DRIFT found (${checked.join(', ')} checked):`);
  for (const d of report.drift) say(log, `  - ${d}`);
  say(log, 'Run the Settings refresh (or refreshAIModels) to review the proposal, then npm run verify:config.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  runModelsDrift({ repoRoot }).then(code => { process.exitCode = code; }, (err: unknown) => {
    console.error(redactKeys(err instanceof Error ? err.message : String(err)));
    process.exitCode = 3;
  });
}
