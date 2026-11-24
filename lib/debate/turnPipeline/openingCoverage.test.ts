// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3777 prevention test: every field of OpeningPipelineInput must appear at
// both construction sites (engine CLI and renderer desktop) unless explicitly
// exempted. A new field added to the interface without updating both callers
// causes a test failure immediately, rather than silently diverging like
// draftModel (t/3774) and briefMaxRetries (t/3775) did.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Per-field exemption table. Required: engineRequired + rendererRequired.
// Update a field here when an intentional asymmetry is added to the interface.
// Remove a bug-exemption entry when the corresponding ticket is fixed.
const FIELD_EXEMPTIONS: Record<string, { engineRequired: boolean; rendererRequired: boolean; note: string }> = {
  repairHints: {
    engineRequired: false,
    rendererRequired: false,
    note: 'intentional: set internally by runOpeningPipelineWithRepair on retry; neither caller sets it',
  },
  briefMaxTokens: {
    engineRequired: false,
    rendererRequired: false,
    note: 'intentional: provider defaults suffice; only needed for a model-specific token cap',
  },
  stageMaxTokens: {
    engineRequired: false,
    rendererRequired: false,
    note: 'intentional: provider defaults suffice; only needed for a model-specific token cap on plan/draft/cite stages (mirrors briefMaxTokens, t/4121)',
  },
  stageTemperatures: {
    engineRequired: true,
    rendererRequired: false,
    note: 'intentional asymmetry: renderer resolves temperature via per-model registry at a higher level',
  },
  briefTimeoutMs: {
    engineRequired: true,
    rendererRequired: false,
    note: 'intentional asymmetry: t/3521 moved the timeout floor into runOpeningPipelineWithRepair; renderer omits',
  },
  stageTimeoutMs: {
    engineRequired: false,
    rendererRequired: true,
    note: 'intentional asymmetry: engine delegates to adapter callback; renderer must compute and pass explicitly',
  },
  draftModel: {
    engineRequired: true,
    rendererRequired: false,
    note: 'BUG t/3774: renderer omits stage_models?.draft — remove this exemption when fixed',
  },
  briefMaxRetries: {
    engineRequired: true,
    rendererRequired: false,
    note: 'intentional: engine.config.briefMaxRetries never populated in production (only in tests); both paths use pipeline default (3). t/3775 closed as phantom gap.',
  },
  soul: {
    engineRequired: false,
    rendererRequired: true,
    note: 'BUG t/4007: engine wiring pending. Renderer side landed (t/3975). Remove this exemption when t/4007 lands',
  },
  opponentSouls: {
    engineRequired: false,
    rendererRequired: true,
    note: 'BUG t/4007: engine wiring pending. Renderer side landed (t/3975). Remove this exemption when t/4007 lands',
  },
};

function extractFields(source: string): string[] {
  const match = source.match(/export interface OpeningPipelineInput \{([\s\S]*?)\n\}/);
  if (!match) throw new Error('OpeningPipelineInput interface not found in source');
  const fields: string[] = [];
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s+(\w+)\??:/);
    if (m) fields.push(m[1]);
  }
  return fields;
}

const interfaceSource = readFileSync(path.join(__dirname, 'opening.ts'), 'utf8');
const engineSource = readFileSync(
  path.join(__dirname, '../debateEngine/phases/opening.ts'),
  'utf8',
);
const rendererSource = readFileSync(
  path.join(REPO_ROOT, 'taxonomy-editor/src/renderer/hooks/useDebateStore/slices/clarificationSlice.ts'),
  'utf8',
);

const fields = extractFields(interfaceSource);

describe('OpeningPipelineInput construction coverage — t/3777 prevention', () => {
  it('extracts at least 20 fields from OpeningPipelineInput (sanity check)', () => {
    expect(fields.length).toBeGreaterThanOrEqual(20);
  });

  for (const field of fields) {
    const exemption = FIELD_EXEMPTIONS[field] ?? { engineRequired: true, rendererRequired: true };

    if (exemption.engineRequired) {
      it(`engine: field "${field}" present in debateEngine/phases/opening.ts`, () => {
        expect(engineSource, `Field "${field}" missing from engine — update engine or add to FIELD_EXEMPTIONS`).toContain(field);
      });
    }

    if (exemption.rendererRequired) {
      it(`renderer: field "${field}" present in clarificationSlice.ts`, () => {
        expect(rendererSource, `Field "${field}" missing from renderer — update renderer or add to FIELD_EXEMPTIONS`).toContain(field);
      });
    }
  }
});
