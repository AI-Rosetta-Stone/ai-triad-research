// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { harvestDebateTestedForSession, auditDebateTestedLag, collectSessionTaxonomyRefs, formatLagLine } from './harvestOnSave.js';
import type { HarvestableSession } from './harvestOnSave.js';
import type { PovNode } from './taxonomyTypes.js';
import type { ArgumentNetworkNode, ArgumentNetworkEdge } from './types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makePovNode(
  id: string,
  category: 'Beliefs' | 'Desires' | 'Intentions' = 'Beliefs',
): PovNode {
  return {
    id,
    label: `Label for ${id}`,
    description: `Description for ${id}`,
    pov: id.startsWith('acc') ? 'accelerationist' : id.startsWith('saf') ? 'safetyist' : 'skeptic',
    category,
    bdi_layer: category === 'Beliefs' ? 'belief' : category === 'Desires' ? 'desire' : 'intention',
    parent_id: null,
    children: [],
    situation_refs: [],
  };
}

function makeTranscriptSession(debateId: string, nodeIds: string[]): HarvestableSession {
  return {
    id: debateId,
    created_at: '2026-09-05T10:00:00Z',
    app_version: '2.0.0',
    transcript: [
      { speaker: 'accelerationist', taxonomy_refs: nodeIds },
    ],
  };
}

function makeAnSession(
  debateId: string,
  nodeId: string,
  extraEdges: ArgumentNetworkEdge[] = [],
): HarvestableSession {
  const anNode: ArgumentNetworkNode = {
    id: 'an-001',
    type: 'position',
    speaker: 'accelerationist',
    text: 'Test claim',
    taxonomy_refs: [nodeId],
    strength: 0.7,
    confidence: 0.8,
  };
  return {
    id: debateId,
    created_at: '2026-09-05T10:00:00Z',
    app_version: '2.0.0',
    argument_network: { nodes: [anNode], edges: extraEdges },
  };
}

// ── Temp data-root helpers ─────────────────────────────────────────────────

function makeTempDataRoot(nodes: PovNode[]): { repoRoot: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-test-'));
  const taxonomyDir = path.join(tmpDir, 'data', 'taxonomy', 'Origin');
  fs.mkdirSync(taxonomyDir, { recursive: true });

  const acc = nodes.filter(n => n.id.startsWith('acc'));
  const saf = nodes.filter(n => n.id.startsWith('saf'));
  const skp = nodes.filter(n => n.id.startsWith('skp'));

  fs.writeFileSync(path.join(taxonomyDir, 'accelerationist.json'), JSON.stringify({ pov: 'accelerationist', nodes: acc }, null, 2));
  fs.writeFileSync(path.join(taxonomyDir, 'safetyist.json'), JSON.stringify({ pov: 'safetyist', nodes: saf }, null, 2));
  fs.writeFileSync(path.join(taxonomyDir, 'skeptic.json'), JSON.stringify({ pov: 'skeptic', nodes: skp }, null, 2));

  // Write a minimal .aitriad.json so resolveDataRoot finds the data dir
  fs.writeFileSync(path.join(tmpDir, '.aitriad.json'), JSON.stringify({ data_root: './data' }));

  return {
    repoRoot: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function readHarvestedNode(repoRoot: string, filename: string, nodeId: string): PovNode | undefined {
  const filePath = path.join(repoRoot, 'data', 'taxonomy', 'Origin', filename);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { nodes: PovNode[] };
  return data.nodes.find(n => n.id === nodeId);
}

// ── Tests ─────────────────────────────────────────────────────────────────

// Isolate from the real data root — AI_TRIAD_DATA_ROOT takes priority over
// .aitriad.json in resolveDataRoot, so unset it during tests that write
// a temp .aitriad.json (t/3330 env-override root cause).
let _savedEnvRoot: string | undefined;
beforeEach(() => {
  _savedEnvRoot = process.env['AI_TRIAD_DATA_ROOT'];
  delete process.env['AI_TRIAD_DATA_ROOT'];
});
afterEach(() => {
  if (_savedEnvRoot !== undefined) {
    process.env['AI_TRIAD_DATA_ROOT'] = _savedEnvRoot;
  } else {
    delete process.env['AI_TRIAD_DATA_ROOT'];
  }
});

describe('harvestDebateTestedForSession', () => {
  it('returns skipped=no-id for sessions without an id', () => {
    const { repoRoot, cleanup } = makeTempDataRoot([makePovNode('acc-beliefs-001')]);
    try {
      const result = harvestDebateTestedForSession({}, repoRoot);
      expect(result.skipped).toBe('no-id');
      expect(result.entriesCreated).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('creates cited entry for transcript-only session', () => {
    const node = makePovNode('acc-beliefs-001');
    const { repoRoot, cleanup } = makeTempDataRoot([node]);
    try {
      const session = makeTranscriptSession('debate-001', ['acc-beliefs-001']);
      const result = harvestDebateTestedForSession(session, repoRoot);

      expect(result.skipped).toBeNull();
      expect(result.entriesCreated).toBe(1);
      expect(result.nodesUpdated).toContain('acc-beliefs-001');

      const updated = readHarvestedNode(repoRoot, 'accelerationist.json', 'acc-beliefs-001');
      expect(updated?.graph_attributes?.debate_tested?.tier).toBe('cited');
      expect(updated?.graph_attributes?.debate_tested?.record).toHaveLength(1);
      expect(updated?.graph_attributes?.debate_tested?.record[0].debate_id).toBe('debate-001');
      expect(updated?.graph_attributes?.debate_tested?.record[0].verdict).toBe('cited');
    } finally {
      cleanup();
    }
  });

  it('creates debate_tested record for AN session', () => {
    const node = makePovNode('acc-beliefs-002');
    const { repoRoot, cleanup } = makeTempDataRoot([node]);
    try {
      const session = makeAnSession('debate-002', 'acc-beliefs-002');
      const result = harvestDebateTestedForSession(session, repoRoot);

      expect(result.skipped).toBeNull();
      expect(result.entriesCreated).toBe(1);

      const updated = readHarvestedNode(repoRoot, 'accelerationist.json', 'acc-beliefs-002');
      expect(updated?.graph_attributes?.debate_tested).toBeDefined();
      expect(updated?.graph_attributes?.debate_tested?.record[0].debate_id).toBe('debate-002');
    } finally {
      cleanup();
    }
  });

  it('is idempotent — calling twice for same session yields entriesCreated=0 on second call', () => {
    const node = makePovNode('acc-beliefs-003');
    const { repoRoot, cleanup } = makeTempDataRoot([node]);
    try {
      const session = makeTranscriptSession('debate-003', ['acc-beliefs-003']);
      const first = harvestDebateTestedForSession(session, repoRoot);
      expect(first.entriesCreated).toBe(1);

      const second = harvestDebateTestedForSession(session, repoRoot);
      expect(second.entriesCreated).toBe(0);
      expect(second.skipped).toBeNull();

      // Tier should still be correct
      const updated = readHarvestedNode(repoRoot, 'accelerationist.json', 'acc-beliefs-003');
      expect(updated?.graph_attributes?.debate_tested?.record).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('only writes dirty taxonomy files (safetyist node → only safetyist.json updated)', () => {
    const nodes = [makePovNode('acc-beliefs-010'), makePovNode('saf-beliefs-010')];
    const { repoRoot, cleanup } = makeTempDataRoot(nodes);
    try {
      const accStatBefore = fs.statSync(path.join(repoRoot, 'data', 'taxonomy', 'Origin', 'accelerationist.json')).mtimeMs;
      const session = makeTranscriptSession('debate-010', ['saf-beliefs-010']);
      harvestDebateTestedForSession(session, repoRoot);

      const accStatAfter = fs.statSync(path.join(repoRoot, 'data', 'taxonomy', 'Origin', 'accelerationist.json')).mtimeMs;
      expect(accStatAfter).toBe(accStatBefore);

      const safNode = readHarvestedNode(repoRoot, 'safetyist.json', 'saf-beliefs-010');
      expect(safNode?.graph_attributes?.debate_tested?.tier).toBe('cited');
    } finally {
      cleanup();
    }
  });

  it('skips sit-* and cc-* nodes (non-BDI) from transcript refs', () => {
    const node = makePovNode('acc-beliefs-020');
    const { repoRoot, cleanup } = makeTempDataRoot([node]);
    try {
      const session: HarvestableSession = {
        id: 'debate-020',
        created_at: '2026-09-05T10:00:00Z',
        transcript: [{ taxonomy_refs: ['sit-001', 'cc-001', 'acc-beliefs-020'] }],
      };
      const result = harvestDebateTestedForSession(session, repoRoot);
      // sit-* and cc-* don't match ^(acc|saf|skp)- so they're filtered before BDI check
      expect(result.nodesUpdated).toEqual(['acc-beliefs-020']);
    } finally {
      cleanup();
    }
  });

  it('returns entriesCreated=0 and no file writes when session has no taxonomy refs', () => {
    const node = makePovNode('acc-beliefs-030');
    const { repoRoot, cleanup } = makeTempDataRoot([node]);
    try {
      const session: HarvestableSession = {
        id: 'debate-030',
        transcript: [{ speaker: 'acc', taxonomy_refs: [] }],
      };
      const result = harvestDebateTestedForSession(session, repoRoot);
      expect(result.entriesCreated).toBe(0);
      expect(result.nodesUpdated).toHaveLength(0);
      expect(result.skipped).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('harvests transcript-only refs in AN sessions (t/3331 gap fix)', () => {
    // anNode references acc-beliefs-040; transcript also references saf-beliefs-040 which is NOT in the AN.
    // Before the fix, saf-beliefs-040 would be silently dropped. After the fix it gets a cited entry.
    const nodes = [makePovNode('acc-beliefs-040'), makePovNode('saf-beliefs-040')];
    const { repoRoot, cleanup } = makeTempDataRoot(nodes);
    try {
      const anNode: ArgumentNetworkNode = {
        id: 'an-040',
        type: 'position',
        speaker: 'accelerationist',
        text: 'AN claim',
        taxonomy_refs: ['acc-beliefs-040'],
        strength: 0.7,
        confidence: 0.8,
      };
      const session: HarvestableSession = {
        id: 'debate-040',
        created_at: '2026-09-05T10:00:00Z',
        argument_network: { nodes: [anNode], edges: [] },
        transcript: [{ taxonomy_refs: ['acc-beliefs-040', 'saf-beliefs-040'] }],
      };
      const result = harvestDebateTestedForSession(session, repoRoot);
      // Both AN ref and transcript-only ref must be harvested
      expect(result.nodesUpdated).toContain('acc-beliefs-040');
      expect(result.nodesUpdated).toContain('saf-beliefs-040');
      expect(result.entriesCreated).toBe(2);

      const safNode = readHarvestedNode(repoRoot, 'safetyist.json', 'saf-beliefs-040');
      expect(safNode?.graph_attributes?.debate_tested?.tier).toBe('cited');
      expect(safNode?.graph_attributes?.debate_tested?.record[0].debate_id).toBe('debate-040');
    } finally {
      cleanup();
    }
  });
});

describe('collectSessionTaxonomyRefs', () => {
  it('returns union of AN and transcript refs, deduped', () => {
    const session: HarvestableSession = {
      id: 'test',
      argument_network: { nodes: [{ id: 'n1', type: 'position', speaker: 'acc', text: 't',
        taxonomy_refs: ['acc-beliefs-500', 'saf-beliefs-500'], strength: 0.5, confidence: 0.5 }] },
      transcript: [{ taxonomy_refs: ['saf-beliefs-500', 'skp-beliefs-500'] }],
    };
    const refs = collectSessionTaxonomyRefs(session);
    expect(refs).toHaveLength(3);
    expect(refs).toContain('acc-beliefs-500');
    expect(refs).toContain('saf-beliefs-500');
    expect(refs).toContain('skp-beliefs-500');
  });

  it('filters non-POV refs (sit-*, cc-*, pol-*)', () => {
    const session: HarvestableSession = {
      id: 'test',
      transcript: [{ taxonomy_refs: ['sit-001', 'cc-001', 'pol-001', 'acc-beliefs-501'] }],
    };
    const refs = collectSessionTaxonomyRefs(session);
    expect(refs).toEqual(['acc-beliefs-501']);
  });
});

describe('auditDebateTestedLag', () => {
  it('returns lag=0 when all cited nodes have debate_tested records', () => {
    const node = makePovNode('acc-beliefs-100');
    node.graph_attributes = {
      debate_tested: {
        tier: 'cited', sort_key: 1, engagements: 1, challenges: 0,
        held: 0, weakened: 0, revisions: [], last_tested: '2026-09-05',
        description_hash: 'abc', record: [{ debate_id: 'd-1', date: '2026-09-05',
          pipeline_version: 'test', verdict: 'cited',
          strongest_attack_encountered: null,
          claim_outcomes: { thrived: 0, survived: 0, died: 0 }, concession: null }],
      },
    };
    const nodeMap = new Map([['acc-beliefs-100', node]]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-test-'));
    try {
      const session: HarvestableSession = {
        id: 'd-1',
        transcript: [{ taxonomy_refs: ['acc-beliefs-100'] }],
      };
      fs.writeFileSync(path.join(tmpDir, 'debate-d-1.json'), JSON.stringify(session));
      const result = auditDebateTestedLag(nodeMap, tmpDir);
      expect(result.lag).toBe(0);
      expect(result.harvested).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns lagNodeIds for nodes cited in debates but lacking debate_tested', () => {
    const node = makePovNode('acc-beliefs-101');
    const nodeMap = new Map([['acc-beliefs-101', node]]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-test-'));
    try {
      const session: HarvestableSession = {
        id: 'd-2',
        transcript: [{ taxonomy_refs: ['acc-beliefs-101'] }],
      };
      fs.writeFileSync(path.join(tmpDir, 'debate-d-2.json'), JSON.stringify(session));
      const result = auditDebateTestedLag(nodeMap, tmpDir);
      expect(result.lag).toBe(1);
      expect(result.lagNodeIds).toContain('acc-beliefs-101');
      expect(result.harvested).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns lag=0 and total=0 when debates dir is empty', () => {
    const nodeMap = new Map([['acc-beliefs-200', makePovNode('acc-beliefs-200')]]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-test-'));
    try {
      const result = auditDebateTestedLag(nodeMap, tmpDir);
      expect(result.total).toBe(0);
      expect(result.lag).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips sessions without an id in lag audit', () => {
    const node = makePovNode('acc-beliefs-300');
    const nodeMap = new Map([['acc-beliefs-300', node]]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-test-'));
    try {
      // debate-undefined.json: no id field
      fs.writeFileSync(path.join(tmpDir, 'debate-undefined.json'),
        JSON.stringify({ transcript: [{ taxonomy_refs: ['acc-beliefs-300'] }] }));
      const result = auditDebateTestedLag(nodeMap, tmpDir);
      expect(result.total).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('formatLagLine (t/709)', () => {
  const zero = { total: 0, harvested: 0, lag: 0 };

  it('reports "not evaluated (no input)" when 0 session files were read, never "Lag: 0"', () => {
    const line = formatLagLine(0, zero);
    expect(line).toBe('  Lag: not evaluated (no input)');
    expect(line).not.toContain('Lag: 0');
  });

  it('keeps the counts line when files were read, including a real Lag: 0', () => {
    expect(formatLagLine(308, zero)).toBe('  Cited nodes (BDI): 0  |  Harvested: 0  |  Lag: 0');
    expect(formatLagLine(3, { total: 9, harvested: 7, lag: 2 })).toBe('  Cited nodes (BDI): 9  |  Harvested: 7  |  Lag: 2');
  });
});
