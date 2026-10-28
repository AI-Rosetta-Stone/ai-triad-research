// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runNliDirectionGate, buildNliNodeProp, resolveNliScriptPath } from './nliDirectionGate.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../../flight-recorder/index.js';
import type { ArgumentNetworkNode } from '../types.js';

// Create the fn inside the factory so it's available when vi.mock is hoisted.
// Both the default and named export reference the same fn for cross-env compat.
vi.mock('child_process', () => {
  const fn = vi.fn();
  return { default: { spawnSync: fn }, spawnSync: fn };
});

import { spawnSync } from 'child_process';
const mockSpawn = vi.mocked(spawnSync);

function makeNode(
  id: string,
  primaryRef: string | null,
  text = 'some claim',
  canonical?: string,
  attribution?: string,
): ArgumentNetworkNode {
  return {
    id,
    text,
    ...(canonical !== undefined && { canonical_proposition: canonical }),
    ...(attribution !== undefined && { attribution_text_genus: attribution }),
    speaker: 'accelerationist',
    source_entry_id: 'e1',
    taxonomy_refs: [],
    turn_number: 1,
    claim_taxonomy_attribution: primaryRef
      ? { primary_ref: primaryRef, attribution_confidence: 0.7 }
      : undefined,
  } as unknown as ArgumentNetworkNode;
}

function spawnResult(stdout: object, status = 0) {
  return { stdout: JSON.stringify(stdout), stderr: '', status, error: undefined };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('buildNliNodeProp — rich node prop for NLI (t/2744#7)', () => {
  it('joins label and core description with em-dash', () => {
    expect(buildNliNodeProp('Rapid Deployment', 'Faster deployment helps society.')).toBe('Rapid Deployment — Faster deployment helps society.');
  });

  it('strips Encompasses tail from description', () => {
    const desc = 'AI accelerates progress. Encompasses: narrow AI, AGI research.';
    expect(buildNliNodeProp('AI Progress', desc)).toBe('AI Progress — AI accelerates progress.');
  });

  it('strips Excludes tail from description', () => {
    const desc = 'Regulation slows development. Excludes: safety-critical domains.';
    expect(buildNliNodeProp('Regulation Risk', desc)).toBe('Regulation Risk — Regulation slows development.');
  });

  it('falls back to label-only when description is empty', () => {
    expect(buildNliNodeProp('Bare Label', '')).toBe('Bare Label');
  });

  it('falls back to label-only when core is empty after strip', () => {
    const desc = 'Encompasses: everything, nothing.';
    expect(buildNliNodeProp('Label Only', desc)).toBe('Label Only');
  });

  it('richness arm — label-only would not match V1; label+Core does (t/2744#8)', () => {
    // Demonstrates the load-bearing contrast: stripping Encompasses produces the
    // same core text that tau_contra=1.0 was calibrated on (CL 4-variant test).
    const fullDesc = 'Existing laws are insufficient for AI. Encompasses: tort law, liability.';
    const labelOnly = 'Existing Laws Insufficient';
    const labelPlusCore = buildNliNodeProp(labelOnly, fullDesc);
    expect(labelPlusCore).toBe('Existing Laws Insufficient — Existing laws are insufficient for AI.');
    // Bare label (what a naive caller would pass) is shorter and loses the proposition
    expect(labelOnly).not.toContain('insufficient for AI');
    // Rich form preserves the asserted proposition (the inversion-catchable content)
    expect(labelPlusCore).toContain('insufficient for AI');
  });
});

describe('runNliDirectionGate — V4 direction gate, multi-field OR (t/2746, t/2744#10)', () => {
  // V5 sends up to 3 slots per claim (id__v / id__c / id__a) and applies opposes-if-ANY.
  // Default makeNode has only text set → one slot (__v). Tests with all fields use makeNode overloads.

  it('returns empty result when no nodes are attributed', () => {
    const nodes = [makeNode('AN-1', null)];
    const result = runNliDirectionGate(nodes, new Map(), 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(result.counts).toEqual({ opposes: 0, agrees: 0, unrelated: 0, unresolved: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns empty result when nodeTextById has no entry for the ref', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const result = runNliDirectionGate(nodes, new Map(), 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('demotes claim when verbatim slot returns opposes', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'AI regulation accelerates progress']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'opposes', confidence: 1.4, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.has('AN-1')).toBe(true);
    expect(result.counts.opposes).toBe(1);
    expect(result.counts.agrees).toBe(0);
  });

  it('keeps claim when verbatim slot returns unrelated', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'AI regulation accelerates progress']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.2, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.has('AN-1')).toBe(false);
    expect(result.counts.unrelated).toBe(1);
  });

  it('keeps claim when verbatim slot returns unresolved (fail-safe output)', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'AI regulation accelerates progress']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unresolved', confidence: 0.0, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(result.counts.unresolved).toBe(1);
  });

  it('keeps claim when all slots return agrees (arm-2 genuine-agreement control: no false demote)', () => {
    // GV arm-2: genuine agreement across all three fields must never manufacture a false opposes.
    const nodes = [makeNode('AN-1', 'acc-bel-001', 'AI helps everyone', 'AI is beneficial', 'AI improves welfare')];
    const nodeMap = new Map([['acc-bel-001', 'AI accelerates progress']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'agrees', confidence: 0.9, method: 'nli-deberta' },
      { id: 'AN-1__c', direction: 'agrees', confidence: 0.8, method: 'nli-deberta' },
      { id: 'AN-1__a', direction: 'agrees', confidence: 0.7, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(result.counts.agrees).toBe(1);
    expect(result.counts.opposes).toBe(0);
  });

  // ── OR rule tests (t/2744#10–#11) ──────────────────────────────────────────

  it('OR rule: verbatim→opposes fires even when canonical→unrelated', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001', 'verbatim text', 'canonical text')];
    const nodeMap = new Map([['acc-bel-001', 'node prop']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'opposes', confidence: 1.2, method: 'nli-deberta' },
      { id: 'AN-1__c', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.has('AN-1')).toBe(true);
    expect(result.counts.opposes).toBe(1);
  });

  it('OR rule: attribution→agrees (false entailment) blocked by verbatim→opposes (t/2744#11 case)', () => {
    // The empirical origin case: attribution_text over-abstracts to false entailment,
    // but verbatim/canonical both fire opposes — the OR rule catches the inversion.
    const nodes = [makeNode('AN-1', 'acc-int-047', 'verbatim contradicts node', 'canonical also contradicts', 'attribution entails — false')];
    const nodeMap = new Map([['acc-int-047', 'Existing laws are insufficient for AI']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'opposes', confidence: 4.71, method: 'nli-deberta' },
      { id: 'AN-1__c', direction: 'opposes', confidence: 1.42, method: 'nli-deberta' },
      { id: 'AN-1__a', direction: 'agrees',  confidence: 6.84, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.has('AN-1')).toBe(true);
    expect(result.counts.opposes).toBe(1);
    expect(result.counts.agrees).toBe(0);
  });

  it('OR rule: all three slots→unrelated → claim not opposing, counts as unrelated', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001', 'v text', 'c text', 'a text')];
    const nodeMap = new Map([['acc-bel-001', 'node prop']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
      { id: 'AN-1__c', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
      { id: 'AN-1__a', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(result.counts.unrelated).toBe(1);
    expect(result.counts.opposes).toBe(0);
  });

  it('OR rule: all three slots→unresolved → counts as unresolved (fail-safe)', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001', 'v text', 'c text', 'a text')];
    const nodeMap = new Map([['acc-bel-001', 'node prop']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unresolved', confidence: 0.0, method: 'nli-deberta' },
      { id: 'AN-1__c', direction: 'unresolved', confidence: 0.0, method: 'nli-deberta' },
      { id: 'AN-1__a', direction: 'unresolved', confidence: 0.0, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(result.counts.unresolved).toBe(1);
  });

  it('sends only available fields — skips undefined canonical and attribution', () => {
    // Node with only text → batch should have exactly 1 slot (__v).
    const nodes = [makeNode('AN-1', 'acc-bel-001', 'just verbatim')];
    const nodeMap = new Map([['acc-bel-001', 'node prop']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    runNliDirectionGate(nodes, nodeMap, 'acc');
    const stdin = JSON.parse(mockSpawn.mock.calls[0][2]?.input as string);
    expect(stdin).toHaveLength(1);
    expect(stdin[0].id).toBe('AN-1__v');
    expect(stdin[0].claim_prop).toBe('just verbatim');
  });

  it('sends all three slots when all fields are populated', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001', 'verbatim', 'canonical', 'attribution')];
    const nodeMap = new Map([['acc-bel-001', 'node prop']]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
      { id: 'AN-1__c', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
      { id: 'AN-1__a', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    runNliDirectionGate(nodes, nodeMap, 'acc');
    const stdin = JSON.parse(mockSpawn.mock.calls[0][2]?.input as string);
    expect(stdin).toHaveLength(3);
    const ids = stdin.map((s: { id: string }) => s.id);
    expect(ids).toContain('AN-1__v');
    expect(ids).toContain('AN-1__c');
    expect(ids).toContain('AN-1__a');
    const byId = Object.fromEntries(stdin.map((s: { id: string; claim_prop: string }) => [s.id, s.claim_prop]));
    expect(byId['AN-1__v']).toBe('verbatim');
    expect(byId['AN-1__c']).toBe('canonical');
    expect(byId['AN-1__a']).toBe('attribution');
  });

  // ── Fail-safe tests ────────────────────────────────────────────────────────

  it('returns empty result (fail-safe) when subprocess exits non-zero', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    mockSpawn.mockReturnValue({ stdout: '', stderr: 'ImportError', status: 1, error: undefined } as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
    expect(result.counts).toEqual({ opposes: 0, agrees: 0, unrelated: 0, unresolved: 0 });
  });

  it('returns empty result (fail-safe) when subprocess throws', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    mockSpawn.mockReturnValue({ stdout: '', stderr: '', status: 0, error: new Error('ENOENT') } as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
  });

  it('returns empty result (fail-safe) when subprocess output is malformed JSON', () => {
    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    mockSpawn.mockReturnValue({ stdout: 'not json', stderr: '', status: 0, error: undefined } as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.size).toBe(0);
  });

  it('handles mixed batch — demotes only the opposes claim, counts all (claim-level)', () => {
    const nodes = [
      makeNode('AN-1', 'acc-bel-001', 'AI is beneficial'),
      makeNode('AN-2', 'acc-bel-002', 'AI is dangerous'),
    ];
    const nodeMap = new Map([
      ['acc-bel-001', 'AI accelerates progress'],
      ['acc-bel-002', 'AI reduces risk'],
    ]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'agrees',  confidence: 0.8, method: 'nli-deberta' },
      { id: 'AN-2__v', direction: 'opposes', confidence: 1.3, method: 'nli-deberta' },
    ]) as any);

    const result = runNliDirectionGate(nodes, nodeMap, 'acc');
    expect(result.opposingIds.has('AN-1')).toBe(false);
    expect(result.opposingIds.has('AN-2')).toBe(true);
    expect(result.counts).toEqual({ opposes: 1, agrees: 1, unrelated: 0, unresolved: 0 });
  });

  it('passes claim_pov, node_pov, and rich node_prop to each slot', () => {
    const desc = 'AI cannot be regulated. Encompasses: AI safety, AGI policy.';
    const nodes = [makeNode('AN-1', 'saf-bel-001', 'safety first')];
    const nodeMap = new Map([['saf-bel-001', buildNliNodeProp('Unregulatable AI', desc)]]);
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    runNliDirectionGate(nodes, nodeMap, 'safetyist');

    const callArgs = mockSpawn.mock.calls[0];
    const stdin = callArgs[2]?.input as string;
    const parsed = JSON.parse(stdin);
    expect(parsed[0].claim_pov).toBe('safetyist');
    expect(parsed[0].node_pov).toBe('safetyist');
    // Rich node_prop: label+Core with Encompasses stripped
    expect(parsed[0].node_prop).toBe('Unregulatable AI — AI cannot be regulated.');
    expect(parsed[0].node_prop).not.toContain('Encompasses');
  });
});

// ── Script path resolution (t/4596, 2nd occurrence of the t/1721 class) ─────

describe('resolveNliScriptPath — depth-agnostic repo-root walk (t/4596)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds the script from a source-style start dir (lib/debate/claimExtractionPipeline)', () => {
    const root = path.resolve('/repo');
    const start = path.join(root, 'lib', 'debate', 'claimExtractionPipeline');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === path.join(root, 'scripts', 'nli_classify.py'));
    expect(resolveNliScriptPath(start)).toBe(path.join(root, 'scripts', 'nli_classify.py'));
  });

  it('finds the script from an Electron dist/main-style start dir, any nesting depth', () => {
    const root = path.resolve('/repo');
    const start = path.join(root, 'dist', 'main', 'lib', 'debate', 'claimExtractionPipeline');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === path.join(root, 'scripts', 'nli_classify.py'));
    expect(resolveNliScriptPath(start)).toBe(path.join(root, 'scripts', 'nli_classify.py'));
  });

  it('finds the script from a server dist/server-style start dir (diagnosis: 4 levels up, not the old hardcoded 3)', () => {
    const root = path.resolve('/app');
    const start = path.join(root, 'dist', 'server', 'lib', 'debate', 'claimExtractionPipeline');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === path.join(root, 'scripts', 'nli_classify.py'));
    expect(resolveNliScriptPath(start)).toBe(path.join(root, 'scripts', 'nli_classify.py'));
  });

  it('returns undefined when the script is not found anywhere up to the filesystem root', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(resolveNliScriptPath(path.resolve('/a/b/c/d'))).toBeUndefined();
  });
});

// ── Gate behaviour when the script is unavailable (t/4596) ──────────────────

describe('runNliDirectionGate — script unavailable (t/4596)', () => {
  const ORIGINAL_ENV = process.env.NLI_CLASSIFY_SCRIPT;
  const ORIGINAL_REASON_ENV = process.env.NLI_CLASSIFY_SCRIPT_DISABLED_REASON;

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_ENV === undefined) delete process.env.NLI_CLASSIFY_SCRIPT;
    else process.env.NLI_CLASSIFY_SCRIPT = ORIGINAL_ENV;
    if (ORIGINAL_REASON_ENV === undefined) delete process.env.NLI_CLASSIFY_SCRIPT_DISABLED_REASON;
    else process.env.NLI_CLASSIFY_SCRIPT_DISABLED_REASON = ORIGINAL_REASON_ENV;
    clearGlobalRecorder();
  });

  it('WARNs and returns empty (no subprocess spawned) when the script cannot be found', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);

    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    const result = runNliDirectionGate(nodes, nodeMap, 'acc');

    expect(result.opposingIds.size).toBe(0);
    expect(result.counts).toEqual({ opposes: 0, agrees: 0, unrelated: 0, unresolved: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].message).toContain('gate skipped');
    expect(record.mock.calls[0][0].message).toContain('not found');
  });

  it('honors NLI_CLASSIFY_SCRIPT="" as an explicit disable, with a distinct logged reason', () => {
    process.env.NLI_CLASSIFY_SCRIPT = '';
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);

    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    const result = runNliDirectionGate(nodes, nodeMap, 'acc');

    expect(result.opposingIds.size).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0].message).toContain('disabled via NLI_CLASSIFY_SCRIPT');
  });

  it('lets ops name the disable reason via NLI_CLASSIFY_SCRIPT_DISABLED_REASON (CL ask, p/49#584)', () => {
    process.env.NLI_CLASSIFY_SCRIPT = '';
    process.env.NLI_CLASSIFY_SCRIPT_DISABLED_REASON = 'disabled on hosted pending t/4593 recalibration';
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);

    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    runNliDirectionGate(nodes, nodeMap, 'acc');

    expect(record.mock.calls[0][0].message).toContain('disabled on hosted pending t/4593 recalibration');
  });

  it('honors NLI_CLASSIFY_SCRIPT as an explicit path override, bypassing the directory walk entirely', () => {
    process.env.NLI_CLASSIFY_SCRIPT = path.join('custom', 'nli_classify.py');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // walk would fail — override must skip it
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    const nodes = [makeNode('AN-1', 'acc-bel-001')];
    const nodeMap = new Map([['acc-bel-001', 'some node text']]);
    runNliDirectionGate(nodes, nodeMap, 'acc');

    expect(mockSpawn).toHaveBeenCalledWith(
      'python3',
      [path.join('custom', 'nli_classify.py')],
      expect.objectContaining({ cwd: 'custom' }),
    );
  });
});

// ── Interpreter resolution (t/4596#2 — Diagnostics' ENOENT finding) ──────────

describe('runNliDirectionGate — interpreter resolution (t/4596)', () => {
  const ORIGINAL_SCRIPT_ENV = process.env.NLI_CLASSIFY_SCRIPT;
  const ORIGINAL_PYTHON_ENV = process.env.NLI_PYTHON_INTERPRETER;

  beforeEach(() => {
    process.env.NLI_CLASSIFY_SCRIPT = path.join('custom', 'nli_classify.py'); // skip the real fs walk
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_SCRIPT_ENV === undefined) delete process.env.NLI_CLASSIFY_SCRIPT;
    else process.env.NLI_CLASSIFY_SCRIPT = ORIGINAL_SCRIPT_ENV;
    if (ORIGINAL_PYTHON_ENV === undefined) delete process.env.NLI_PYTHON_INTERPRETER;
    else process.env.NLI_PYTHON_INTERPRETER = ORIGINAL_PYTHON_ENV;
  });

  it('tries python3 first by default', () => {
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);
    runNliDirectionGate([makeNode('AN-1', 'acc-bel-001')], new Map([['acc-bel-001', 'node text']]), 'acc');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('python3');
  });

  it('falls back to python when python3 ENOENTs (the hosted-prod failure Diagnostics found)', () => {
    const enoent = Object.assign(new Error('spawnSync python3 ENOENT'), { code: 'ENOENT' });
    mockSpawn
      .mockReturnValueOnce({ stdout: '', stderr: '', status: null, error: enoent } as any)
      .mockReturnValueOnce(spawnResult([
        { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
      ]) as any);

    const result = runNliDirectionGate([makeNode('AN-1', 'acc-bel-001')], new Map([['acc-bel-001', 'node text']]), 'acc');

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0][0]).toBe('python3');
    expect(mockSpawn.mock.calls[1][0]).toBe('python');
    expect(result.counts.unrelated).toBe(1);
  });

  it('does NOT retry with another interpreter on a real failure (bad script / missing deps) — only on ENOENT', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    mockSpawn.mockReturnValue({ stdout: '', stderr: 'ModuleNotFoundError: sentence_transformers', status: 1, error: undefined } as any);

    runNliDirectionGate([makeNode('AN-1', 'acc-bel-001')], new Map([['acc-bel-001', 'node text']]), 'acc');

    expect(mockSpawn).toHaveBeenCalledTimes(1); // no retry — a real failure, not "interpreter not found"
    expect(record.mock.calls[0][0].message).toContain('ModuleNotFoundError');
    clearGlobalRecorder();
  });

  it('honors NLI_PYTHON_INTERPRETER as an explicit override, skipping the python3/python chain', () => {
    process.env.NLI_PYTHON_INTERPRETER = 'py';
    mockSpawn.mockReturnValue(spawnResult([
      { id: 'AN-1__v', direction: 'unrelated', confidence: 0.1, method: 'nli-deberta' },
    ]) as any);

    runNliDirectionGate([makeNode('AN-1', 'acc-bel-001')], new Map([['acc-bel-001', 'node text']]), 'acc');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('py');
  });
});
