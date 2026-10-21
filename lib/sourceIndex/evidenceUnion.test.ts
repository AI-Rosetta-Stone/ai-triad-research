// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Runs every case in the shared fixture (`docs/specs/source-identity.md`
 * section 7, t/4337#60, SO e/347#2) through the TS implementation. The
 * PowerShell side runs the same fixture through
 * `scripts/AITriad/Private/EvidenceUnion.ps1` (`tests/EvidenceUnion.Tests.ps1`)
 * — both must pass every case.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evidenceKey, evidenceNearEqual, extractSummaryEvidenceLinks, mergeGroupEvidence,
  type EvidenceLink, type EvidenceUnionMember,
} from './evidenceUnion.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '../../tests/fixtures/evidence-union-cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  version: number;
  key_cases: { name: string; quote: string; expected_key: string }[];
  near_cases: { name: string; a: string; b: string; expected: boolean }[];
  link_cases: { name: string; summary: unknown; expected_links: EvidenceLink[] }[];
  union_cases: {
    name: string;
    canonical: string;
    members: { id: string; links: EvidenceLink[] }[];
    expected: Record<string, Array<EvidenceLink & { doc: string; via?: string }>>;
  }[];
};

describe(`evidence-union fixture v${fixture.version} (t/4337 section 7)`, () => {
  describe('key_cases', () => {
    for (const c of fixture.key_cases) {
      it(c.name, () => {
        expect(evidenceKey(c.quote)).toBe(c.expected_key);
      });
    }
  });

  describe('near_cases', () => {
    for (const c of fixture.near_cases) {
      it(c.name, () => {
        expect(evidenceNearEqual(c.a, c.b)).toBe(c.expected);
      });
    }
  });

  describe('link_cases', () => {
    for (const c of fixture.link_cases) {
      it(c.name, () => {
        expect(extractSummaryEvidenceLinks(c.summary as never)).toEqual(c.expected_links);
      });
    }
  });

  describe('union_cases', () => {
    for (const c of fixture.union_cases) {
      it(c.name, () => {
        const members: EvidenceUnionMember<EvidenceLink>[] = c.members.map(m => ({ id: m.id, links: m.links }));
        const result = mergeGroupEvidence(c.canonical, members);
        expect(result).toEqual(c.expected);
      });
    }
  });
});
