// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Conformance suite for repairSnapshotMojibake (t/4394, t/4412).
 * Cases are loaded from tests/fixtures/repair-snapshot-mojibake-cases.json,
 * shared with tests/Repair-SnapshotMojibake.Tests.ps1 so both suites exercise
 * the exact same inputs and expected outputs including near-miss 'must not repair' cases.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { repairSnapshotMojibake } from './repairSnapshotMojibake.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface FixtureCase {
  id: string;
  description: string;
  input: string;
  expected_variant: string;
  expected_text: string | null;
}

interface Fixture {
  cases: FixtureCase[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../tests/fixtures/repair-snapshot-mojibake-cases.json'), 'utf8'),
);

// ── Fixture-driven conformance cases ─────────────────────────────────────────

describe('repairSnapshotMojibake — fixture cases', () => {
  for (const c of fixture.cases) {
    it(c.description, () => {
      const r = repairSnapshotMojibake(c.input);
      expect(r.variant).toBe(c.expected_variant);
      const expectedText = c.expected_text ?? c.input;
      expect(r.text).toBe(expectedText);
    });
  }
});

// ── Read-path-only contract ───────────────────────────────────────────────────

describe('repairSnapshotMojibake — read-path-only contract', () => {

  it('SHA-256 of damaged bytes diverges from repaired bytes', () => {
    // content_sha256 is computed over raw bytes as written on disk (source-identity spec 1.1).
    // Repair changes the byte sequence, so the hashes must differ -- this documents that
    // the repair must NEVER run on a hashing path.
    const damaged = 'donÆt worry about it. The riskùreward ratio matters.';
    const { text: repaired, variant } = repairSnapshotMojibake(damaged);
    expect(variant).toBe('cp1252-as-cp437');
    const sha256 = (s: string) =>
      createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
    expect(sha256(damaged)).not.toBe(sha256(repaired));
  });

  it('no non-test .ts file under lib/sourceIndex/ imports repairSnapshotMojibake', () => {
    // Hashing code in lib/sourceIndex/ must never see repaired text -- it hashes raw bytes.
    const sourceIndexDir = resolve(__dirname, '../sourceIndex');
    const files = readdirSync(sourceIndexDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    for (const file of files) {
      const src = readFileSync(resolve(sourceIndexDir, file), 'utf8');
      expect(src, `${file} must not import repairSnapshotMojibake`).not.toContain(
        'repairSnapshotMojibake',
      );
    }
  });
});
