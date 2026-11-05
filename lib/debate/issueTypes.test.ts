// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { GraphAttributesSchema, IssueTypeSchema } from './schemas.js';

describe('IssueTypeSchema', () => {
  it('accepts valid issue type values', () => {
    expect(() => IssueTypeSchema.parse('loss_of_control')).not.toThrow();
    expect(() => IssueTypeSchema.parse('misuse')).not.toThrow();
    expect(() => IssueTypeSchema.parse('power_concentration')).not.toThrow();
    expect(() => IssueTypeSchema.parse('economic')).not.toThrow();
    expect(() => IssueTypeSchema.parse('political')).not.toThrow();
    expect(() => IssueTypeSchema.parse('social')).not.toThrow();
  });

  it('rejects unknown issue type values', () => {
    expect(() => IssueTypeSchema.parse('unknown_type')).toThrow();
    expect(() => IssueTypeSchema.parse('invalid')).toThrow();
  });
});

describe('GraphAttributesSchema.issue_types', () => {
  const createGraphAttrs = (issue_types: unknown) => ({
    issue_types,
  });

  it('accepts absent issue_types (optional field)', () => {
    const result = GraphAttributesSchema.parse({});
    expect(result.issue_types).toBeUndefined();
  });

  it('accepts 1 issue type', () => {
    const result = GraphAttributesSchema.parse(createGraphAttrs(['loss_of_control']));
    expect(result.issue_types).toEqual(['loss_of_control']);
  });

  it('accepts 2 issue types', () => {
    const result = GraphAttributesSchema.parse(createGraphAttrs(['loss_of_control', 'economic']));
    expect(result.issue_types).toEqual(['loss_of_control', 'economic']);
  });

  it('accepts 3 issue types', () => {
    const result = GraphAttributesSchema.parse(createGraphAttrs(['loss_of_control', 'economic', 'political']));
    expect(result.issue_types).toEqual(['loss_of_control', 'economic', 'political']);
  });

  it('accepts empty array (0 tags, valid state)', () => {
    const result = GraphAttributesSchema.parse(createGraphAttrs([]));
    expect(result.issue_types).toEqual([]);
  });

  it('rejects more than 3 issue types', () => {
    expect(() => GraphAttributesSchema.parse(createGraphAttrs([
      'loss_of_control', 'economic', 'political', 'social',
    ]))).toThrow();
  });

  it('rejects duplicate issue types', () => {
    expect(() => GraphAttributesSchema.parse(createGraphAttrs([
      'loss_of_control', 'loss_of_control',
    ]))).toThrow();
  });

  it('rejects unknown issue type values in array', () => {
    expect(() => GraphAttributesSchema.parse(createGraphAttrs([
      'loss_of_control', 'unknown_type',
    ]))).toThrow();
  });
});

describe('GraphAttributesSchema.issue_types_provenance', () => {
  it('accepts valid provenance object', () => {
    const result = GraphAttributesSchema.parse({
      issue_types: ['loss_of_control'],
      issue_types_provenance: {
        method: 'llm',
        model: 'gpt-4',
        prompt_version: 'issue-types-v1',
        run_id: '550e8400-e29b-41d4-a716-446655440000',
        classified_at: '2026-11-04T18:00:49Z',
        confidence: { loss_of_control: 0.85 },
        rationale: 'This is a loss of control concern.',
      },
    });
    expect(result.issue_types_provenance).toBeDefined();
    expect(result.issue_types_provenance?.method).toBe('llm');
  });

  it('accepts absent provenance (optional)', () => {
    const result = GraphAttributesSchema.parse({
      issue_types: ['loss_of_control'],
    });
    expect(result.issue_types_provenance).toBeUndefined();
  });

  it('rejects provenance with rationale > 300 chars', () => {
    const longRationale = 'a'.repeat(301);
    expect(() => GraphAttributesSchema.parse({
      issue_types: ['loss_of_control'],
      issue_types_provenance: {
        method: 'llm',
        model: 'gpt-4',
        prompt_version: 'issue-types-v1',
        run_id: '550e8400-e29b-41d4-a716-446655440000',
        classified_at: '2026-11-04T18:00:49Z',
        confidence: { loss_of_control: 0.85 },
        rationale: longRationale,
      },
    })).toThrow();
  });

  it('rejects invalid UUID in run_id', () => {
    expect(() => GraphAttributesSchema.parse({
      issue_types: ['loss_of_control'],
      issue_types_provenance: {
        method: 'llm',
        model: 'gpt-4',
        prompt_version: 'issue-types-v1',
        run_id: 'not-a-uuid',
        classified_at: '2026-11-04T18:00:49Z',
        confidence: { loss_of_control: 0.85 },
        rationale: 'Test',
      },
    })).toThrow();
  });

  it('rejects invalid datetime in classified_at', () => {
    expect(() => GraphAttributesSchema.parse({
      issue_types: ['loss_of_control'],
      issue_types_provenance: {
        method: 'llm',
        model: 'gpt-4',
        prompt_version: 'issue-types-v1',
        run_id: '550e8400-e29b-41d4-a716-446655440000',
        classified_at: 'not-a-datetime',
        confidence: { loss_of_control: 0.85 },
        rationale: 'Test',
      },
    })).toThrow();
  });
});

describe('backward compatibility', () => {
  it('existing nodes without issue_types validate unchanged', () => {
    const existingNode = {
      epistemic_type: 'empirical_claim',
      rhetorical_strategy: 'appeal_to_evidence',
    };
    const result = GraphAttributesSchema.parse(existingNode);
    expect(result).toBeDefined();
    expect(result.issue_types).toBeUndefined();
    expect(result.issue_types_provenance).toBeUndefined();
  });
});
