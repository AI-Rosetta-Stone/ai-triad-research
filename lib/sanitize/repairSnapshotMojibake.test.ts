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
import { computeSourceContentHash } from '../sourceIndex/types.js';

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

  it('computeSourceContentHash returns different hashes for damaged vs repaired text', () => {
    // content_sha256 is computed over raw bytes as written on disk (source-identity spec 1.1).
    // Repair changes the byte sequence, so the hashes must differ -- this documents that
    // the repair must NEVER run on a hashing path. 8 words x 13 = 104, over MIN_HASH_BODY_WORDS (100),
    // so the real hash function returns a digest rather than null.
    const damaged = 'donÆt worry about it. The riskùreward ratio matters. '.repeat(13);
    const { text: repaired, variant } = repairSnapshotMojibake(damaged);
    expect(variant).toBe('cp1252-as-cp437');
    const sha256Digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const damagedHash = computeSourceContentHash(damaged, sha256Digest);
    const repairedHash = computeSourceContentHash(repaired, sha256Digest);
    expect(damagedHash).not.toBeNull();
    expect(repairedHash).not.toBeNull();
    expect(damagedHash).not.toBe(repairedHash);
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
