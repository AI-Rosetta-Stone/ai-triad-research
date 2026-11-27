// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Brief Export full-pipeline CLI (t/2837). Takes a RAW exported debate JSON
// through all four stages — extract → narrate → render → verify — and writes the
// same artifacts + audit-manifest.json as the T6 server path, with no server and
// (optionally) no model call. Consumed by PowerShell T8 local mode (-Path) and
// CI/offline. The render-only sibling `render/cli.ts` stays for --spec/--narration
// re-render; this is the whole pipeline from a debate session.
//
//   node lib/brief/cli.js --path debate.json --model gemini-3.5-flash-lite \
//     --preset conference --out ./out [--checker-model ...] [--skip-narration] \
//     [--allow-open] [--template deck.potx] [--no-framing-meta]
//
// Output contract (t/2837#3, confirming PS t/2806#6):
//   success → exit 0; stdout = EXACTLY one line of JSON = TriadDeckExport; nothing
//             else on stdout, so the T8 parse is robust. Artifacts written under --out.
//   failure → exit ≠0; stderr = one line of JSON { errorCode, message }.
//   warnings → `WARN: <msg>` lines on stderr; stdout stays clean.
// A verify-GATE failure still writes ALL artifacts (incl. audit-manifest.json)
// before exiting ≠0 (diagnosable, mirrors T6 persist-on-failure). Stage throws
// (bad --path, non-closed debate, model unreachable, render fault) may leave
// partial/no artifacts.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ActionableError, errorMessage } from '../debate/errors.js';
import { createCLIAdapter } from '../debate/aiAdapter.js';
import { resolveRepoRoot } from '../debate/taxonomyLoader.js';
import type { AIAdapter } from '../debate/aiAdapter.js';
import type { DebateSession } from '../debate/types.js';
import { runBriefPipeline, type BriefPipelineResult } from './pipeline.js';
import { codeForHardFailures } from './errorMapping.js';
import { BRIEF_ARTIFACTS } from './types.js';
import type {
  BriefPreset, ModelSource, ExportErrorCode, ExportJobState, TriadDeckExport,
} from './types.js';

const LOCATION = 'lib/brief/cli.ts';
const PRESETS: readonly BriefPreset[] = ['policymaker', 'conference', 'classroom'];
const MODEL_SOURCES: readonly ModelSource[] = ['Explicit', 'Global', 'Default'];

/** CLI error codes = the frozen wire ExportErrorCode PLUS one CLI-local code for a
 *  bad/unparseable --path (T6 never reads a file, so it is not a wire code). */
export type CliErrorCode = ExportErrorCode | 'DebateFileInvalid';

export interface CliArgs {
  path: string;
  model: string;
  modelSource: ModelSource;
  preset: BriefPreset;
  checkerModel?: string;
  checkerModelSource?: ModelSource;
  skipNarration: boolean;
  allowOpen: boolean;
  template?: string;
  framingMeta?: boolean;
  out: string;
}

function fail(problem: string, nextSteps: string[]): never {
  throw new ActionableError({
    goal: 'Run the Brief Export pipeline offline from a debate JSON',
    problem,
    location: LOCATION,
    nextSteps,
  });
}

export function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  let skipNarration = false;
  let allowOpen = false;
  let framingMeta: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-narration') { skipNarration = true; continue; }
    if (a === '--allow-open') { allowOpen = true; continue; }
    if (a === '--no-framing-meta') { framingMeta = false; continue; }
    if (a.startsWith('--')) { map.set(a.slice(2), argv[++i]); }
  }

  const inPath = map.get('path');
  const model = map.get('model');
  const out = map.get('out');
  if (!inPath || !model || !out) {
    fail('--path, --model, and --out are required', [
      'node lib/brief/cli.js --path <debate.json> --model <id> --preset <p> --out <dir>',
      'Optional: --checker-model, --skip-narration, --allow-open, --template <potx>, --no-framing-meta',
    ]);
  }

  const preset = (map.get('preset') ?? 'conference') as BriefPreset;
  if (!PRESETS.includes(preset)) fail(`Unknown preset "${preset}"`, [`Use one of: ${PRESETS.join(', ')}`]);

  const modelSource = (map.get('model-source') ?? 'Explicit') as ModelSource;
  if (!MODEL_SOURCES.includes(modelSource)) {
    fail(`Unknown model-source "${modelSource}"`, [`Use one of: ${MODEL_SOURCES.join(', ')}`]);
  }
  const checkerModelSource = map.get('checker-model-source') as ModelSource | undefined;
  if (checkerModelSource && !MODEL_SOURCES.includes(checkerModelSource)) {
    fail(`Unknown checker-model-source "${checkerModelSource}"`, [`Use one of: ${MODEL_SOURCES.join(', ')}`]);
  }

  return {
    path: inPath!,
    model: model!,
    modelSource,
    preset,
    checkerModel: map.get('checker-model'),
    checkerModelSource,
    skipNarration,
    allowOpen,
    template: map.get('template'),
    framingMeta,
    out: out!,
  };
}

// ── Error-code mapping (CLI owns this — wire/host-specific, per the pipeline split) ──
// codeForHardFailures is shared (lib/brief/errorMapping) — identical across T6, CLI,
// and Electron (t/2840). codeForThrow stays CLI-local (its 'reading' stage +
// DebateFileInvalid are CLI-only concerns).

/** Map a thrown stage fault to a code, keyed off the stage that was running. */
function codeForThrow(err: unknown, stage: ExportJobState | 'reading'): CliErrorCode {
  const msg = errorMessage(err).toLowerCase();
  if (stage === 'reading') return 'DebateFileInvalid';
  if (msg.includes('closed')) return 'DebateNotClosed'; // extract's non-closed guard
  if (stage === 'narrating' || stage === 'checking') return 'ModelUnavailable';
  return 'RenderFailure';
}

function emitError(code: CliErrorCode, message: string): void {
  process.stderr.write(JSON.stringify({ errorCode: code, message }) + '\n');
}

/** A guard adapter used under --skip-narration: no model is contacted, so an
 *  actual call is a bug, not a silent no-op. */
const skipNarrationGuardAdapter: AIAdapter = {
  generateText: async () => {
    throw new ActionableError({
      goal: 'Produce narration text',
      problem: 'The model adapter was invoked under --skip-narration (deterministic mode)',
      location: LOCATION,
      nextSteps: ['Remove --skip-narration to narrate with a model, or report this as a bug'],
    });
  },
  // t/3614: required AIAdapter member. This guard throws before any model/floor logic runs,
  // so an empty registry is correct and conspicuous (never consulted on this path).
  registry: { backends: [], models: [] },
};

/** Tool versions recorded in the manifest. Best-effort; the gate records, not validates. */
function toolVersions(repoRoot: string): Record<string, string> {
  let appVersion = 'unknown';
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(repoRoot, 'taxonomy-editor/package.json'), 'utf8'),
    ) as { version?: string };
    if (pkg.version) appVersion = pkg.version;
  } catch { /* fall back to 'unknown' */ }
  return { 'brief-cli': appVersion, node: process.version };
}

export interface RunResult { exitCode: number }

export async function runCli(argv: string[]): Promise<RunResult> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    // Arg errors are user errors, not a wire code — surface the actionable message.
    process.stderr.write((err instanceof ActionableError ? err.message : String(err)) + '\n');
    return { exitCode: 2 };
  }

  // ── read + parse the debate JSON (bad/unparseable → DebateFileInvalid) ──
  let session: DebateSession;
  try {
    const raw = await readFile(args.path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('debate JSON is not an object');
    session = parsed as DebateSession;
  } catch (err) {
    emitError('DebateFileInvalid', `Cannot read/parse debate JSON at ${args.path}: ${errorMessage(err)}`);
    return { exitCode: 1 };
  }

  let template: Uint8Array | undefined;
  if (args.template) {
    try {
      template = await readFile(args.template);
    } catch (err) {
      emitError('RenderFailure', `Cannot read --template ${args.template}: ${errorMessage(err)}`);
      return { exitCode: 1 };
    }
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(__dirname);
  const adapter = args.skipNarration ? skipNarrationGuardAdapter : createCLIAdapter(repoRoot);

  // ── run the shared pipeline; track the stage for precise throw-mapping ──
  let stage: ExportJobState = 'extracting';
  let result: BriefPipelineResult;
  try {
    result = await runBriefPipeline(
      {
        session,
        preset: args.preset,
        modelId: args.model,
        modelSource: args.modelSource,
        checkerModelId: args.checkerModel,
        checkerModelSource: args.checkerModelSource,
        skipNarration: args.skipNarration,
        template,
        framingMeta: args.framingMeta,
        allowOpen: args.allowOpen,
        toolVersions: toolVersions(repoRoot),
        timestamp: new Date().toISOString(),
      },
      adapter,
      s => { stage = s; },
    );
  } catch (err) {
    emitError(codeForThrow(err, stage), errorMessage(err));
    return { exitCode: 1 };
  }

  // ── write all artifacts under --out (incl. manifest, even on gate failure) ──
  await mkdir(args.out, { recursive: true });
  for (const a of result.artifacts) {
    const dest = join(args.out, a.name);
    if (a.bytes !== undefined) await writeFile(dest, a.bytes);
    else await writeFile(dest, a.text ?? '');
  }

  // ── warnings → stderr WARN lines; stdout stays clean ──
  for (const w of result.warnings) process.stderr.write(`WARN: ${w}\n`);

  // ── verify-gate failure: artifacts written, exit ≠0 with the mapped code ──
  if (result.hardFailures.length > 0) {
    emitError(
      codeForHardFailures(result.hardFailures),
      `Export verify gate failed: ${result.hardFailures.join('; ')}`,
    );
    return { exitCode: 1 };
  }

  // ── success: one line of TriadDeckExport JSON on stdout ──
  const passthru: TriadDeckExport = {
    debateId: result.manifest.debate_id,
    title: result.spec.meta.title,
    preset: args.preset,
    model: args.model,
    modelSource: args.modelSource,
    checkerModel: args.checkerModel,
    path: join(args.out, BRIEF_ARTIFACTS.pptx),
    specPath: join(args.out, BRIEF_ARTIFACTS.deckSpec),
    manifestPath: join(args.out, BRIEF_ARTIFACTS.manifest),
    traceCoveragePct: result.manifest.trace_coverage_pct,
    verdicts: result.manifest.verdict_counts,
    warnings: result.warnings,
  };
  process.stdout.write(JSON.stringify(passthru) + '\n');
  return { exitCode: 0 };
}

// Executed directly (not imported): run over process.argv and set the exit code.
// Compare RESOLVED PATHS, not a hand-built file:// string. The old string compare
// (`import.meta.url === "file://" + argv[1]`) silently failed on Windows — Node emits
// `file:///C:/…` (three slashes) but the template produced `file://C:/…` (two) — so
// the guard was never true and the CLI exited 0 with no output (t/2868).
const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then(r => { process.exitCode = r.exitCode; })
    .catch((e: unknown) => {
      // Last-resort: an unmapped fault. Emit a generic wire-shaped error line.
      process.stderr.write(JSON.stringify({ errorCode: 'RenderFailure', message: String(e) }) + '\n');
      process.exitCode = 1;
    });
}
