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
  deriveEntityMentionContainers, isDerivedMentionContainerKey,
  resolveDocId, groupMembers, loadLegacyChunkManifest,
  type EvidenceLink, type EvidenceUnionMember, type EvidenceDoc,
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
  mention_key_cases: {
    name: string;
    canonical: string;
    summaries: { id: string; summary: unknown }[];
    expected_containers: Record<string, string>;
  }[];
  derived_key_regex: string;
  derived_key_cases: { key: string; derived: boolean }[];
  resolve_cases: { name: string; docs: Record<string, EvidenceDoc & { summary?: unknown }>; manifest: Record<string, string>; id: string; expected?: string; expected_error?: string }[];
  chunk_union_cases: {
    name: string;
    canonical: string;
    manifest: Record<string, string>;
    docs: Record<string, EvidenceDoc & { summary?: unknown; chunk_generated_at?: string; chunk_model?: string }>;
    expected: Record<string, Array<EvidenceLink & { doc: string; via?: string; chunk_of?: string; chunk_generated_at?: string; chunk_model?: string }>>;
    expected_documents: number;
    expected_extracted: Record<string, unknown[]>;
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

  // t/4419 (spec 7.7, #3688): entity-mention `via-` containers — no TS consumer yet,
  // fixture parity only.
  // t/479 (spec 6.2, 7.1, 7.4, 7.5, 7.6a; fixture v3): summary-only chunks resolve to their base and union into its group.
  describe('resolve_cases', () => {
    for (const c of fixture.resolve_cases) {
      it(c.name, () => {
        if (c.expected_error) {
          expect(() => resolveDocId(c.id, c.docs, c.manifest)).toThrow(expect.objectContaining({ code: c.expected_error }) as never);
        } else {
          expect(resolveDocId(c.id, c.docs, c.manifest)).toBe(c.expected);
        }
      });
    }
  });

  describe('chunk_union_cases', () => {
    for (const c of fixture.chunk_union_cases) {
      it(c.name, () => {
        const members = groupMembers(c.canonical, c.docs, c.manifest);
        const withLinks = (id: string) => extractSummaryEvidenceLinks(c.docs[id]?.summary as never);
        const all: EvidenceUnionMember<EvidenceLink>[] = [
          { id: c.canonical, links: withLinks(c.canonical) },
          ...members.map(m => ({
            id: m.id,
            kind: m.kind,
            viaCopy: m.viaCopy,
            chunkGeneratedAt: c.docs[m.id]?.chunk_generated_at,
            chunkModel: c.docs[m.id]?.chunk_model,
            links: withLinks(m.id),
          })),
        ];
        const merged = mergeGroupEvidence(c.canonical, all);
        expect(merged).toEqual(c.expected);
        // Extraction reads every kept fact (7.6, 7.6a): nothing is skipped on via or chunk_of.
        expect(merged).toEqual(c.expected_extracted);
        // 7.5: the group is one document, however many chunks it has.
        const documents = new Set(all.map(m => resolveDocId(m.id, c.docs, c.manifest)));
        expect(documents.size).toBe(c.expected_documents);
      });
    }
  });

  describe('mention_key_cases', () => {
    for (const c of fixture.mention_key_cases) {
      it(c.name, () => {
        const summaries = c.summaries.map(s => ({ id: s.id, summary: s.summary as never }));
        expect(deriveEntityMentionContainers(c.canonical, summaries)).toEqual(c.expected_containers);
      });
    }
  });

  describe('derived_key_cases', () => {
    for (const c of fixture.derived_key_cases) {
      it(`${c.key} -> derived=${c.derived}`, () => {
        expect(isDerivedMentionContainerKey(c.key)).toBe(c.derived);
        expect(new RegExp(fixture.derived_key_regex).test(c.key)).toBe(c.derived);
      });
    }
  });
});

// t/572: the TypeScript reader loads the one shared manifest file, and it lists the 16 legacy chunks.
describe('legacy-chunk manifest (t/572)', () => {
  it('loads docs/specs/source-identity-legacy-chunks.json into the same chunk list', () => {
    const specPath = path.resolve(here, '../../docs/specs/source-identity-legacy-chunks.json');
    const json = JSON.parse(readFileSync(specPath, 'utf-8')) as { chunks: Record<string, string> };
    const loaded = loadLegacyChunkManifest(json);
    expect(loaded).toEqual(json.chunks);
    expect(Object.keys(loaded)).toHaveLength(16);
  });

  it('refuses a file that is not a chunks map', () => {
    expect(() => loadLegacyChunkManifest({ chunks: ['x'] })).toThrow();
  });
});
