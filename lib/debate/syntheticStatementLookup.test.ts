// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { bestMatchingSyntheticStatement, makeGroundingLookup } from './syntheticStatementLookup.js';

describe('bestMatchingSyntheticStatement', () => {
  const nodeVectors = {
    'acc-beliefs-001': { vectors: [[1, 0], [0, 1], [0.7, 0.7]] },
  };
  const nodeStatements = {
    'acc-beliefs-001': ['statement A (axis x)', 'statement B (axis y)', 'statement C (diagonal)'],
  };

  it('returns the statement whose vector is most cosine-similar to the claim embedding', () => {
    const result = bestMatchingSyntheticStatement('acc-beliefs-001', [1, 0.1], nodeVectors, nodeStatements);
    expect(result).toBe('statement A (axis x)');
  });

  it('picks a different statement for a claim embedding closer to a different vector', () => {
    const result = bestMatchingSyntheticStatement('acc-beliefs-001', [0.1, 1], nodeVectors, nodeStatements);
    expect(result).toBe('statement B (axis y)');
  });

  it('returns undefined when the claim has no embedding', () => {
    expect(bestMatchingSyntheticStatement('acc-beliefs-001', undefined, nodeVectors, nodeStatements)).toBeUndefined();
  });

  it('returns undefined when the claim embedding is empty', () => {
    expect(bestMatchingSyntheticStatement('acc-beliefs-001', [], nodeVectors, nodeStatements)).toBeUndefined();
  });

  it('returns undefined when the node has no vectors', () => {
    expect(bestMatchingSyntheticStatement('acc-beliefs-999', [1, 0], nodeVectors, nodeStatements)).toBeUndefined();
  });

  it('returns undefined when the node has no statements', () => {
    expect(bestMatchingSyntheticStatement('acc-beliefs-001', [1, 0], nodeVectors, {})).toBeUndefined();
  });

  it('fails safe (returns undefined) when vector/statement counts are misaligned', () => {
    const mismatchedStatements = { 'acc-beliefs-001': ['only one statement'] };
    expect(bestMatchingSyntheticStatement('acc-beliefs-001', [1, 0], nodeVectors, mismatchedStatements)).toBeUndefined();
  });

  it('returns undefined when the node has an empty vectors array', () => {
    const empty = { 'acc-beliefs-001': { vectors: [] } };
    expect(bestMatchingSyntheticStatement('acc-beliefs-001', [1, 0], empty, nodeStatements)).toBeUndefined();
  });
});

describe('makeGroundingLookup', () => {
  const nodeVectors = {
    'acc-beliefs-001': { vectors: [[1, 0], [0, 1]] },
  };
  const nodeStatements = {
    'acc-beliefs-001': ['statement A', 'statement B'],
  };

  it('binds the taxonomy data into a reusable (nodeId, claimEmbedding) lookup', () => {
    const lookup = makeGroundingLookup(nodeVectors, nodeStatements);
    expect(lookup('acc-beliefs-001', [1, 0])).toBe('statement A');
    expect(lookup('acc-beliefs-001', [0, 1])).toBe('statement B');
  });

  it('returns a no-op lookup when no synthetic statements are loaded', () => {
    const lookup = makeGroundingLookup(nodeVectors, undefined);
    expect(lookup('acc-beliefs-001', [1, 0])).toBeUndefined();
  });
});
