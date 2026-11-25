// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/490 follow-up (t/167#30): a hosted reply on staging was complete (stop_reason stop, refs present) but the
 * model put literal newlines inside the "response" string, so JSON.parse failed with "Bad control character"
 * at 235 and the chat showed raw JSON with no grounding. The fixture is that reply, verbatim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import RAW from './__fixtures__/t167-stg-2-raw-response.txt?raw';

vi.mock('@bridge', () => ({ api: {}, setActiveDebateId: () => undefined, isElectronMode: () => false }));

import { parseChatResponse, escapeControlCharsInStrings } from '../../hooks/useChatStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

const ACC_FILE = {
  pov: 'accelerationist',
  nodes: [
    { id: 'acc-beliefs-051', label: 'Stagnation is the real risk', category: 'Beliefs' },
    { id: 'acc-beliefs-084', label: 'Intelligence is an evolutionary imperative', category: 'Beliefs' },
    { id: 'acc-beliefs-085', label: 'Regulation protects incumbents', category: 'Beliefs' },
  ],
};
const EMPTY_FILE = { nodes: [] };

beforeEach(() => {
  useTaxonomyStore.setState({
    accelerationist: ACC_FILE,
    safetyist: EMPTY_FILE,
    skeptic: EMPTY_FILE,
    situations: EMPTY_FILE,
    policyRegistry: [],
  } as never);
});

describe('t/490 follow-up: raw control characters inside JSON strings', () => {
  it('the fixture is the failing shape: plain JSON.parse rejects it', () => {
    expect(() => JSON.parse(RAW)).toThrow(/control character/i);
  });

  it('parses the staging reply with its answer and all three taxonomy_refs', () => {
    const { response, taxonomyRefs } = parseChatResponse(RAW);
    expect(response.startsWith('Yes, and... what if we look at the entire')).toBe(true);
    expect(response).toContain('\n');
    expect(response.trimStart().startsWith('{')).toBe(false);
    expect(taxonomyRefs.map(r => r.node_id)).toEqual(['acc-beliefs-051', 'acc-beliefs-085', 'acc-beliefs-084']);
  });

  it('escapes control characters only inside strings, never outside them', () => {
    const input = '{\n  "a": "line1\nline2\ttab",\n  "b": "already\\nescaped"\n}';
    const out = escapeControlCharsInStrings(input);
    expect(out).toBe('{\n  "a": "line1\\nline2\\ttab",\n  "b": "already\\nescaped"\n}');
    expect(JSON.parse(out)).toEqual({ a: 'line1\nline2\ttab', b: 'already\nescaped' });
  });

  it('respects escaped quotes when tracking string boundaries', () => {
    const input = '{"a": "say \\"hi\\"\nthen"}';
    expect(JSON.parse(escapeControlCharsInStrings(input))).toEqual({ a: 'say "hi"\nthen' });
  });

  it('leaves valid JSON unchanged', () => {
    const valid = JSON.stringify({ response: 'ok', taxonomy_refs: [] }, null, 2);
    expect(escapeControlCharsInStrings(valid)).toBe(valid);
  });
});
