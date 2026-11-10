// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Real-debate fixture generator (t/1162).
// Runs a flash-lite debate and captures checkpoint state at each lifecycle boundary.
// Validates that synthetic fixtures match real engine output shapes.
//
// Excluded from default runs — set RUN_SLOW=1 to execute:
//   RUN_SLOW=1 npx vitest run generate-fixtures

import { describe, it, expect, afterAll, vi } from 'vitest';

// t/57: keep engine.run() off the real ai-triad-data calibration log.
vi.mock('../calibrationLogger.js', async (importOriginal) =>
  (await import('./hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DebateEngine } from '../debateEngine.js';
import type { DebateConfig, LifecycleStage } from '../debateEngine.js';
import type { DebateSession } from '../types.js';
import { createCLIAdapter } from '../aiAdapter.js';
import { resolveRepoRoot, resolveDataRoot, loadTaxonomy } from '../taxonomyLoader.js';
import type { LoadedTaxonomy } from '../taxonomyLoader.js';
import { loadFixture, loadAllFixtures } from './fixtures/index.js';
import type { FixtureName } from './fixtures/index.js';
import { FlightRecorder, setGlobalRecorder, clearGlobalRecorder } from '../../flight-recorder/index.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SLOW = !!process.env.RUN_SLOW;
const MODEL = process.env.FIXTURE_MODEL ?? 'gemini-2.0-flash-lite';

// ── Shape comparison utilities ──────────────────────────

interface ShapeNode {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined';
  keys?: Record<string, ShapeNode>;
  items?: ShapeNode;
}

function extractShape(value: unknown, depth = 0): ShapeNode {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? extractShape(value[0], depth + 1) : undefined,
    };
  }
  if (typeof value === 'object') {
    if (depth > 4) return { type: 'object' };
    const keys: Record<string, ShapeNode> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      keys[k] = extractShape(v, depth + 1);
    }
    return { type: 'object', keys };
  }
  return { type: typeof value as ShapeNode['type'] };
}

interface DriftEntry {
  path: string;
  kind: 'missing' | 'extra' | 'type-mismatch';
  detail: string;
}

function compareSyntheticToReal(
  synthetic: ShapeNode,
  real: ShapeNode,
  path: string,
  drift: DriftEntry[],
): void {
  if (synthetic.type !== real.type) {
    drift.push({
      path,
      kind: 'type-mismatch',
      detail: `synthetic=${synthetic.type}, real=${real.type}`,
    });
    return;
  }

  if (synthetic.type === 'object' && real.type === 'object' && synthetic.keys && real.keys) {
    for (const key of Object.keys(real.keys)) {
      if (!(key in synthetic.keys)) {
        drift.push({ path: `${path}.${key}`, kind: 'missing', detail: `present in real, absent from synthetic` });
      }
    }
    for (const key of Object.keys(synthetic.keys)) {
      if (!(key in real.keys)) {
        drift.push({ path: `${path}.${key}`, kind: 'extra', detail: `present in synthetic, absent from real` });
      }
    }
    for (const key of Object.keys(synthetic.keys)) {
      if (key in real.keys) {
        compareSyntheticToReal(synthetic.keys[key], real.keys[key], `${path}.${key}`, drift);
      }
    }
  }

  if (synthetic.type === 'array' && real.type === 'array' && synthetic.items && real.items) {
    compareSyntheticToReal(synthetic.items, real.items, `${path}[]`, drift);
  }
}

// ── Output directory ────────────────────────────────────

function getOutputDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sha = process.env.GIT_SHA?.slice(0, 8) ?? 'local';
  const dir = path.resolve(__dirname, 'fixtures', 'real', `${ts}_${sha}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, session: DebateSession): void {
  const filePath = path.join(dir, `checkpoint-${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

// ── Test suite ──────────────────────────────────────────

describe.runIf(SLOW)('Real-debate fixture generator', { timeout: 600_000 }, () => {
  let repoRoot: string;
  let taxonomy: LoadedTaxonomy;
  let outputDir: string;
  const captured = new Map<string, DebateSession>();
  const allDrift: { fixture: string; entries: DriftEntry[] }[] = [];

  afterAll(() => {
    clearGlobalRecorder();

    if (allDrift.length > 0) {
      const driftPath = path.join(outputDir, 'drift-report.json');
      fs.writeFileSync(driftPath, JSON.stringify(allDrift, null, 2), 'utf-8');
    }
  });

  it('resolves repo root and loads taxonomy', () => {
    repoRoot = resolveRepoRoot(__dirname);
    taxonomy = loadTaxonomy(repoRoot);

    expect(taxonomy.accelerationist.nodes.length).toBeGreaterThan(0);
    expect(taxonomy.safetyist.nodes.length).toBeGreaterThan(0);

    outputDir = getOutputDir();
  });

  it('runs a 2-round debate with flash-lite', { timeout: 300_000 }, async () => {
    const adapter = createCLIAdapter(repoRoot);
    const recorder = new FlightRecorder({ capacity: 512 });
    setGlobalRecorder(recorder);

    const config: DebateConfig = {
      topic: 'Should AI systems be required to explain their reasoning to affected individuals?',
      model: MODEL,
      rounds: 2,
      responseLength: 'brief',
      sourceType: 'freeform',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      enableClarification: false,
      enableProbing: false,
      useAdaptiveStaging: false,
      throttleMs: 500,
    };

    const engine = new DebateEngine(config, adapter, taxonomy);
    const session = await engine.run();

    expect(session.id).toBeDefined();
    expect(session.transcript.length).toBeGreaterThanOrEqual(6);
    expect(session.argument_network?.nodes.length).toBeGreaterThanOrEqual(1);

    captured.set('complete', session);
    writeFixture(outputDir, 'complete', session);
  });

  it('captures post-synthesis-p1 via resume(stopAfterStage)', { timeout: 120_000 }, async () => {
    const adapter = createCLIAdapter(repoRoot);
    const session = captured.get('complete');
    expect(session).toBeDefined();

    // Build a pre-synthesis checkpoint from the complete session: strip synthesis data
    const preSynth = structuredClone(session!);
    preSynth.transcript = preSynth.transcript.filter(
      e => !(e.type === 'concluding' && (e.metadata as Record<string, unknown> | undefined)?.['synthesis']),
    );
    delete (preSynth as Record<string, unknown>).missing_arguments;
    delete (preSynth as Record<string, unknown>).taxonomy_suggestions;

    const config: DebateConfig = {
      model: MODEL,
      topic: preSynth.topic.final,
      sourceType: 'freeform',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      stopAfterStage: 'synthesis-p1',
      throttleMs: 500,
    };

    const result = await DebateEngine.resume(preSynth, config, adapter, taxonomy);

    expect(result.id).toBeDefined();
    captured.set('post-synthesis-p1', result);
    writeFixture(outputDir, 'post-synthesis-p1', result);
  });

  it('captures post-synthesis-p2 via resume(stopAfterStage)', { timeout: 120_000 }, async () => {
    const adapter = createCLIAdapter(repoRoot);
    const session = captured.get('complete');
    expect(session).toBeDefined();

    const preSynth = structuredClone(session!);
    preSynth.transcript = preSynth.transcript.filter(
      e => !(e.type === 'concluding' && (e.metadata as Record<string, unknown> | undefined)?.['synthesis']),
    );
    delete (preSynth as Record<string, unknown>).missing_arguments;
    delete (preSynth as Record<string, unknown>).taxonomy_suggestions;

    const config: DebateConfig = {
      model: MODEL,
      topic: preSynth.topic.final,
      sourceType: 'freeform',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      stopAfterStage: 'synthesis-p2',
      throttleMs: 500,
    };

    const result = await DebateEngine.resume(preSynth, config, adapter, taxonomy);

    expect(result.id).toBeDefined();
    captured.set('post-synthesis-p2', result);
    writeFixture(outputDir, 'post-synthesis-p2', result);
  });

  it('captures post-synthesis-p3 via resume(stopAfterStage)', { timeout: 120_000 }, async () => {
    const adapter = createCLIAdapter(repoRoot);
    const session = captured.get('complete');
    expect(session).toBeDefined();

    const preSynth = structuredClone(session!);
    preSynth.transcript = preSynth.transcript.filter(
      e => !(e.type === 'concluding' && (e.metadata as Record<string, unknown> | undefined)?.['synthesis']),
    );
    delete (preSynth as Record<string, unknown>).missing_arguments;
    delete (preSynth as Record<string, unknown>).taxonomy_suggestions;

    const config: DebateConfig = {
      model: MODEL,
      topic: preSynth.topic.final,
      sourceType: 'freeform',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      stopAfterStage: 'synthesis-p3',
      throttleMs: 500,
    };

    const result = await DebateEngine.resume(preSynth, config, adapter, taxonomy);

    expect(result.id).toBeDefined();
    captured.set('post-synthesis-p3', result);
    writeFixture(outputDir, 'post-synthesis-p3', result);
  });

  it('captures pre-finalization via resume(stopAfterStage=extraction-coverage)', { timeout: 120_000 }, async () => {
    const postP3 = captured.get('post-synthesis-p3');
    expect(postP3).toBeDefined();

    const adapter = createCLIAdapter(repoRoot);
    const config: DebateConfig = {
      model: MODEL,
      topic: postP3!.topic.final,
      sourceType: 'freeform',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      stopAfterStage: 'extraction-coverage',
      throttleMs: 500,
    };

    const result = await DebateEngine.resume(structuredClone(postP3!), config, adapter, taxonomy);

    expect(result.id).toBeDefined();
    captured.set('pre-finalization', result);
    writeFixture(outputDir, 'pre-finalization', result);
  });

  // ── Shape drift detection ─────────────────────────────

  const BOUNDARY_MAP: [FixtureName, string][] = [
    ['post-synthesis-p1', 'post-synthesis-p1'],
    ['post-synthesis-p2', 'post-synthesis-p2'],
    ['post-synthesis-p3', 'post-synthesis-p3'],
    ['pre-finalization', 'pre-finalization'],
  ];

  for (const [syntheticName, capturedName] of BOUNDARY_MAP) {
    it(`shape comparison: synthetic '${syntheticName}' vs real`, () => {
      const real = captured.get(capturedName);
      if (!real) {
        console.warn(`Skipping drift check for '${capturedName}' — not captured (earlier test may have failed)`);
        return;
      }

      const synthetic = loadFixture(syntheticName);
      const syntheticShape = extractShape(synthetic);
      const realShape = extractShape(real);
      const drift: DriftEntry[] = [];

      compareSyntheticToReal(syntheticShape, realShape, '$', drift);

      allDrift.push({ fixture: syntheticName, entries: drift });

      const missing = drift.filter(d => d.kind === 'missing');
      const extra = drift.filter(d => d.kind === 'extra');
      const typeMismatch = drift.filter(d => d.kind === 'type-mismatch');

      if (extra.length > 0) {
        console.warn(`[drift] '${syntheticName}': ${extra.length} extra keys in synthetic (may be intentional):`);
        for (const e of extra) console.warn(`  ${e.path}: ${e.detail}`);
      }
      if (typeMismatch.length > 0) {
        console.warn(`[drift] '${syntheticName}': ${typeMismatch.length} type mismatches:`);
        for (const e of typeMismatch) console.warn(`  ${e.path}: ${e.detail}`);
      }

      // Fail on missing keys — synthetic fixtures are behind real engine output
      if (missing.length > 0) {
        const report = missing.map(m => `  ${m.path}: ${m.detail}`).join('\n');
        expect.fail(
          `Synthetic fixture '${syntheticName}' is missing ${missing.length} keys present in real output:\n${report}\n\n` +
          `Update the synthetic fixture to include these fields.`,
        );
      }
    });
  }
});
