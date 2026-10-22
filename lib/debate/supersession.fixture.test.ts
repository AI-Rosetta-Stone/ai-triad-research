// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Shared supersession cases (t/4356): tests/TaxonomySupersession.Tests.ps1 runs the same fixture through
// the PowerShell port, so the two implementations can't drift.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSupersessionIndex } from './supersession.js';
import type { PovNode } from './taxonomyTypes.js';

interface SupersessionCase {
  id: string;
  nodes: { id: string; superseded_by?: string | null }[];
  selectable: string[];
  superseded: string[];
  resolve: Record<string, string | null>;
  warn_kinds: string[];
}

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'supersession-cases.json');
const { cases } = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as { cases: SupersessionCase[] };

const warnKind = (message: string): string =>
  message.includes('cycle') ? 'cycle' : message.includes('not found') ? 'dangling' : 'chain';

describe('buildSupersessionIndex: shared fixture (t/4356)', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const warnings: string[] = [];
    const nodes = c.nodes as unknown as PovNode[];
    const { resolveNode, isSuperseded } = buildSupersessionIndex(nodes, m => warnings.push(m));

    // Selection mirrors loadTaxonomy: nodes without a (truthy) superseded_by.
    expect(nodes.filter(n => !n.superseded_by).map(n => n.id)).toEqual(c.selectable);
    expect(c.nodes.map(n => n.id).filter(id => isSuperseded(id)).sort()).toEqual([...c.superseded].sort());
    for (const [id, expected] of Object.entries(c.resolve)) {
      expect(resolveNode(id)?.id ?? null).toBe(expected);
    }
    expect([...new Set(warnings.map(warnKind))].sort()).toEqual([...c.warn_kinds].sort());
  });
});
