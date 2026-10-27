// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  resolveEntityName,
  normalizeName,
  ENTITY_RESOLUTION_MIN_COSINE,
  ENTITY_RESOLUTION_MARGIN,
  type ApprovedEntityView,
} from './nameResolver.js';
import { nameVectorOf, computeEntityVectorSourceHash, type EntityVectorRecord } from './entityVectors.js';

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Two entities sharing the exact alias "Chris" — the canonical alias-collision fixture.
const CHRIS_OLAH: ApprovedEntityView = { id: 'ent-010', name: 'Chris Olah', aliases: ['Chris', 'Olah'], description: '' };
const CHRIS_MANNING: ApprovedEntityView = { id: 'ent-011', name: 'Chris Manning', aliases: ['Chris', 'Manning'], description: '' };
const BENGIO: ApprovedEntityView = { id: 'ent-001', name: 'Yoshua Bengio', aliases: ['Bengio'], description: '' };
const ANTHROPIC: ApprovedEntityView = { id: 'org-001', name: 'Anthropic', aliases: ['Anthropic PBC'], description: '' };

// A trivial v1 vector store keyed by entity id (flat number[]).
function vectorStore(map: Record<string, number[]>): (id: string) => number[] | undefined {
  return (id) => map[id];
}
// A v2 vector store — per-entity { name_vector, description_vector? } record (t/3121 back-compat).
function vectorStoreV2(map: Record<string, EntityVectorRecord>): (id: string) => EntityVectorRecord | undefined {
  return (id) => map[id];
}
const noVectors = (): number[] | undefined => undefined;

// t/4458: the recorded-hash side of the staleness guard. `freshHashes` computes each listed
// entity's CURRENT fingerprint, so none of it reads as stale — the sensible default for every
// pre-existing test below, which is about the alias/cosine ladder, not staleness itself.
function freshHashes(entities: ApprovedEntityView[]): (id: string) => string | undefined {
  const byId = new Map(entities.map((e) => [e.id, computeEntityVectorSourceHash(e.name, e.aliases, e.description, sha256Hex)]));
  return (id) => byId.get(id);
}
const noHashes = (): string | undefined => undefined;

describe('normalizeName', () => {
  it('case-folds, trims, and collapses interior whitespace runs', () => {
    expect(normalizeName('  Yoshua   BENGIO ')).toBe('yoshua bengio');
  });

  it('collapses tabs / newlines / NBSP as whitespace', () => {
    expect(normalizeName('Frontier\tModel Forum')).toBe('frontier model forum');
  });

  it('is idempotent', () => {
    const once = normalizeName('  EU  AI   Act ');
    expect(normalizeName(once)).toBe(once);
  });

  it('does NOT fold diacritics (refusal discipline — no over-matching)', () => {
    expect(normalizeName('Kwaśniewski')).not.toBe('kwasniewski');
  });

  it('returns empty for whitespace-only input', () => {
    expect(normalizeName('   \t \n ')).toBe('');
  });
});

describe('resolveEntityName — alias-first', () => {
  it('resolves a unique alias hit via alias', () => {
    const r = resolveEntityName({ name: 'Bengio' }, [BENGIO, ANTHROPIC], noVectors, noHashes, sha256Hex);
    expect(r).toEqual({ status: 'resolved', ref: { kind: 'entity', id: 'ent-001' }, via: 'alias' });
  });

  it('resolves a unique canonical-name hit via alias', () => {
    const r = resolveEntityName({ name: 'Yoshua Bengio' }, [BENGIO], noVectors, noHashes, sha256Hex);
    expect(r.status).toBe('resolved');
    expect(r.via).toBe('alias');
    expect(r.ref).toEqual({ kind: 'entity', id: 'ent-001' });
  });

  it('matches case- and whitespace-variant aliases (normalized both sides)', () => {
    const r = resolveEntityName({ name: '  yoshua   bengio ' }, [BENGIO], noVectors, noHashes, sha256Hex);
    expect(r.status).toBe('resolved');
    expect(r.ref).toEqual({ kind: 'entity', id: 'ent-001' });
  });

  it('produces an organization ref for an org-* id', () => {
    const r = resolveEntityName({ name: 'Anthropic' }, [ANTHROPIC], noVectors, noHashes, sha256Hex);
    expect(r).toEqual({ status: 'resolved', ref: { kind: 'organization', id: 'org-001' }, via: 'alias' });
  });

  it('does not match entities absent from the approved array (caller filters status)', () => {
    // Resolver only ever considers what it is handed — a proposed/deprecated record the
    // caller withheld is simply not present, so this is unresolved.
    const r = resolveEntityName({ name: 'Bengio' }, [ANTHROPIC], noVectors, noHashes, sha256Hex);
    expect(r.status).toBe('unresolved');
  });
});

describe('resolveEntityName — refusal', () => {
  it('returns unresolved on no alias hit (curation gap, no open-NN)', () => {
    const entities = [BENGIO, ANTHROPIC];
    const r = resolveEntityName(
      { name: 'Some Unknown Person', contextVector: [1, 0, 0] },
      entities,
      vectorStore({ 'ent-001': [1, 0, 0], 'org-001': [1, 0, 0] }),
      freshHashes(entities),
      sha256Hex,
    );
    expect(r.status).toBe('unresolved');
  });

  it('returns unresolved on an empty/whitespace query', () => {
    expect(resolveEntityName({ name: '   ' }, [BENGIO], noVectors, noHashes, sha256Hex).status).toBe('unresolved');
  });
});

describe('resolveEntityName — embedding tie-break among alias collisions', () => {
  const collided = [CHRIS_OLAH, CHRIS_MANNING];

  it('breaks a collision when the top candidate clears floor and margin', () => {
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectorStore({ 'ent-010': [1, 0, 0], 'ent-011': [0, 1, 0] }), // 1.0 vs 0.0
      freshHashes(collided),
      sha256Hex,
    );
    expect(r.status).toBe('resolved');
    expect(r.via).toBe('embedding');
    expect(r.ref).toEqual({ kind: 'entity', id: 'ent-010' });
    expect(r.score).toBeCloseTo(1, 5);
  });

  it('breaks a v2-record collision using name_vector, tolerating a missing description_vector (t/3121)', () => {
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectorStoreV2({
        // ent-010's DESCRIPTION vector points away ([0,0,1]); only name_vector must be scored.
        'ent-010': { name_vector: [1, 0, 0], description_vector: [0, 0, 1] },
        'ent-011': { name_vector: [0, 1, 0] }, // description_vector absent — must be tolerated
      }),
      freshHashes(collided),
      sha256Hex,
    );
    expect(r.status).toBe('resolved');
    expect(r.via).toBe('embedding');
    expect(r.ref).toEqual({ kind: 'entity', id: 'ent-010' });
    expect(r.score).toBeCloseTo(1, 5); // scored name_vector [1,0,0], NOT description_vector [0,0,1]
  });

  it('refuses (ambiguous) when separation is below the margin', () => {
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 1, 0] },
      collided,
      vectorStore({ 'ent-010': [1, 1, 0], 'ent-011': [1, 0.9, 0] }), // ~1.0 vs ~0.999
      freshHashes(collided),
      sha256Hex,
    );
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toEqual([
      { kind: 'entity', id: 'ent-010' },
      { kind: 'entity', id: 'ent-011' },
    ]);
  });

  it('refuses when the top candidate is below the cosine floor', () => {
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectorStore({ 'ent-010': [0.5, 1, 0], 'ent-011': [0, 1, 0] }), // ~0.447 vs 0.0
      freshHashes(collided),
      sha256Hex,
    );
    expect(r.status).toBe('ambiguous');
  });

  it('refuses when no context vector is supplied to break the collision', () => {
    const r = resolveEntityName({ name: 'Chris' }, collided, noVectors, freshHashes(collided), sha256Hex);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
  });

  it('refuses when a colliding candidate has no vector (cannot assert separation)', () => {
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectorStore({ 'ent-010': [1, 0, 0] }), // ent-011 missing → not all scoreable
      freshHashes(collided),
      sha256Hex,
    );
    expect(r.status).toBe('ambiguous');
  });

  it('honors caller-supplied threshold overrides', () => {
    // With a very low floor and zero margin, a weak-but-separated top resolves.
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectorStore({ 'ent-010': [0.5, 1, 0], 'ent-011': [0, 1, 0] }),
      freshHashes(collided),
      sha256Hex,
      { minCosine: 0.1, margin: 0 },
    );
    expect(r.status).toBe('resolved');
    expect(r.ref).toEqual({ kind: 'entity', id: 'ent-010' });
  });
});

// t/4458: a stale or unhashed vector must be skipped exactly like a missing one — never scored,
// never trusted — and the caller-observable reason (unhashed vs. stale) must be right.
describe('resolveEntityName — stale/unhashed vector guard (t/4458)', () => {
  const collided = [CHRIS_OLAH, CHRIS_MANNING];
  const vectors = vectorStore({ 'ent-010': [1, 0, 0], 'ent-011': [0, 1, 0] }); // would resolve if trusted

  it('skips a candidate with NO recorded hash at all ("unhashed"), refusing like a missing vector', () => {
    const skipped: { id: string; reason: string }[] = [];
    const getSrcHash = (id: string) => (id === 'ent-010' ? undefined : freshHashes(collided)(id));
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectors,
      getSrcHash,
      sha256Hex,
      { onStaleVectorSkipped: (id, reason) => skipped.push({ id, reason }) },
    );
    expect(r.status).toBe('ambiguous'); // ent-010 unscoreable -> not all candidates scoreable
    expect(skipped).toEqual([{ id: 'ent-010', reason: 'unhashed' }]);
  });

  it('skips a candidate whose recorded hash no longer matches its current name/aliases/description ("stale")', () => {
    const skipped: { id: string; reason: string }[] = [];
    // ent-010 has a recorded hash, but it's for a DIFFERENT name — as if it was renamed and not re-embedded.
    const staleEntity: ApprovedEntityView = { ...CHRIS_OLAH, name: 'Chris Olah (renamed)' };
    const getSrcHash = freshHashes([CHRIS_OLAH, CHRIS_MANNING]); // recorded for the OLD name
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      [staleEntity, CHRIS_MANNING],
      vectors,
      getSrcHash,
      sha256Hex,
      { onStaleVectorSkipped: (id, reason) => skipped.push({ id, reason }) },
    );
    expect(r.status).toBe('ambiguous');
    expect(skipped).toEqual([{ id: 'ent-010', reason: 'stale' }]);
  });

  it('resolves normally when every recorded hash matches the current record (the common case)', () => {
    const skipped: unknown[] = [];
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectors,
      freshHashes(collided),
      sha256Hex,
      { onStaleVectorSkipped: (...args) => skipped.push(args) },
    );
    expect(r.status).toBe('resolved');
    expect(r.ref).toEqual({ kind: 'entity', id: 'ent-010' });
    expect(skipped).toEqual([]);
  });

  it('a description-only edit makes the (unchanged) name vector read as stale — the known, accepted over-skip (CL t/4458#2 note 3)', () => {
    const recordedFor = { ...CHRIS_OLAH, description: 'original description' };
    const getSrcHash = freshHashes([recordedFor, CHRIS_MANNING]);
    const editedDescriptionOnly: ApprovedEntityView = { ...CHRIS_OLAH, description: 'a materially different description' };
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      [editedDescriptionOnly, CHRIS_MANNING],
      vectors, // the NAME vector is unchanged and still correct
      getSrcHash,
      sha256Hex,
    );
    // Fails CLOSED: an unnecessary refusal, never a wrong link.
    expect(r.status).toBe('ambiguous');
  });

  it('does not call onStaleVectorSkipped for an entity with no vector at all (that is the pre-existing, unrelated path)', () => {
    const skipped: unknown[] = [];
    const r = resolveEntityName(
      { name: 'Chris', contextVector: [1, 0, 0] },
      collided,
      vectorStore({ 'ent-010': [1, 0, 0] }), // ent-011 has no vector
      freshHashes(collided),
      sha256Hex,
      { onStaleVectorSkipped: (...args) => skipped.push(args) },
    );
    expect(r.status).toBe('ambiguous');
    expect(skipped).toEqual([]);
  });
});

describe('exported thresholds', () => {
  it('pins the documented defaults', () => {
    expect(ENTITY_RESOLUTION_MIN_COSINE).toBe(0.6);
    expect(ENTITY_RESOLUTION_MARGIN).toBe(0.05);
  });
});

describe('nameVectorOf — v1/v2 back-compat name-vector selection (t/3121)', () => {
  it('returns a v1 flat array as-is', () => {
    expect(nameVectorOf([1, 0, 0])).toEqual([1, 0, 0]);
  });
  it('returns a v2 record\'s name_vector (not description_vector)', () => {
    const rec: EntityVectorRecord = { name_vector: [1, 0], description_vector: [0, 1] };
    expect(nameVectorOf(rec)).toEqual([1, 0]);
  });
  it('tolerates a v2 record with no description_vector', () => {
    expect(nameVectorOf({ name_vector: [0, 1] })).toEqual([0, 1]);
  });
  it('returns undefined for an absent entry', () => {
    expect(nameVectorOf(undefined)).toBeUndefined();
  });
});

// t/4458: parity with PowerShell's Get-EntityVectorSource / SrcHash, run against the shared
// fixture both PS and TS consume (tests/fixtures/entity-vector-source-cases.json).
describe('computeEntityVectorSourceHash — shared fixture parity (t/4458)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.resolve(here, '../../tests/fixtures/entity-vector-source-cases.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    version: number;
    cases: { name: string; entity_name: string; aliases: string[]; description: string; expected_hash: string }[];
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(computeEntityVectorSourceHash(c.entity_name, c.aliases, c.description, sha256Hex)).toBe(c.expected_hash);
    });
  }

  it('matches PowerShell\'s aliasText falsy-check: a single empty-string alias behaves as no aliases', () => {
    expect(computeEntityVectorSourceHash('Name', [''], 'Desc', sha256Hex))
      .toBe(computeEntityVectorSourceHash('Name', [], 'Desc', sha256Hex));
  });

  it('alias order is preserved, not sorted — a different order hashes differently', () => {
    const a = computeEntityVectorSourceHash('Name', ['Alpha', 'Beta'], '', sha256Hex);
    const b = computeEntityVectorSourceHash('Name', ['Beta', 'Alpha'], '', sha256Hex);
    expect(a).not.toBe(b);
  });
});
