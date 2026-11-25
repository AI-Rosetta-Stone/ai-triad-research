// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/167: Chat's Why panel reads entry.taxonomy_refs, and parseChatResponse is the only place those
 * refs are created. These tests pin two ways it returns no grounding for an answer that had some:
 *
 *   A. The model's text is the expected JSON wrapped in something the parser doesn't strip
 *      (an uppercase fence, prose before or after) or is cut off. The parse fails, so the refs are
 *      lost and the raw JSON is shown as the answer.
 *   B. A cited id is dropped as "unresolvable" when the part of the taxonomy that holds it has not
 *      loaded yet. Not loaded is not the same as not in the taxonomy.
 *
 * Each case here failed against origin/main before the t/490 fix. They are plain `it` tests now, and
 * they guard the fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@bridge', () => ({ api: {}, setActiveDebateId: () => undefined, isElectronMode: () => false }));

import { parseChatResponse } from '../../hooks/useChatStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

const ANSWER = 'Compute limits slow progress.';
const REPLY = {
  response: ANSWER,
  taxonomy_refs: [
    { node_id: 'acc-desires-001', relevance: 'Grounds the claim.' },
    { node_id: 'sit-001', relevance: 'The situation it applies to.' },
  ],
};
const JSON_TEXT = JSON.stringify(REPLY, null, 2);

const ACC_FILE = { pov: 'accelerationist', nodes: [{ id: 'acc-desires-001', label: 'Faster progress', category: 'Desires' }] };
const SITUATIONS_FILE = { nodes: [{ id: 'sit-001', label: 'Compute governance' }] };
const EMPTY_FILE = { nodes: [] };

type Loaded = 'all' | 'chat-pov-only' | 'none';

function setTaxonomy(loaded: Loaded): void {
  useTaxonomyStore.setState({
    accelerationist: loaded === 'none' ? null : ACC_FILE,
    safetyist: loaded === 'all' ? EMPTY_FILE : null,
    skeptic: loaded === 'all' ? EMPTY_FILE : null,
    situations: loaded === 'all' ? SITUATIONS_FILE : null,
  } as never);
}

const ids = (text: string) => parseChatResponse(text, 'gemini-3.5-flash-lite').taxonomyRefs.map((r) => r.node_id);
const content = (text: string) => parseChatResponse(text, 'gemini-3.5-flash-lite').response;

describe('parseChatResponse keeps the grounding for Why (t/167)', () => {
  describe('A. JSON the model wrapped or cut off', () => {
    beforeEach(() => setTaxonomy('all'));

    it('baseline: bare JSON and a lowercase json fence keep both refs', () => {
      expect(ids(JSON_TEXT)).toEqual(['acc-desires-001', 'sit-001']);
      expect(ids('```json\n' + JSON_TEXT + '\n```')).toEqual(['acc-desires-001', 'sit-001']);
    });

    // Was failing: stripCodeFences matched "```json" case-sensitively.
    it.each([
      ['an uppercase JSON fence', '```JSON\n' + JSON_TEXT + '\n```'],
      ['a sentence before a fenced reply', 'Here is my response:\n\n```json\n' + JSON_TEXT + '\n```'],
      ['a sentence before bare JSON', 'Here is my response:\n' + JSON_TEXT],
      ['a sentence after the JSON', JSON_TEXT + '\n\nLet me know if you want more detail.'],
    ])('%s keeps both refs and shows the answer text, not raw JSON', (_name, text) => {
      expect(ids(text)).toEqual(['acc-desires-001', 'sit-001']);
      expect(content(text)).toBe(ANSWER);
    });

    // Was failing: a reply cut off mid-array was shown to the user as raw JSON.
    it('a reply cut off after the answer shows the answer text, never raw JSON', () => {
      const truncated = JSON_TEXT.slice(0, JSON_TEXT.indexOf('"relevance"'));
      const shown = content(truncated);
      expect(shown).toBe(ANSWER);
      expect(shown).not.toContain('taxonomy_refs');
    });

    it('prose with no JSON at all is shown as written, with no refs', () => {
      const prose = 'Compute limits slow progress. They also concentrate power.';
      expect(content(prose)).toBe(prose);
      expect(ids(prose)).toEqual([]);
    });
  });

  describe('B. ids whose part of the taxonomy has not loaded yet', () => {
    // Was failing: with situations still loading, every sit-* ref was dropped as unresolvable.
    it('keeps a situation ref while situations are still loading', () => {
      setTaxonomy('chat-pov-only');
      expect(ids(JSON_TEXT)).toEqual(['acc-desires-001', 'sit-001']);
    });

    // Was failing: with nothing loaded, every ref was dropped.
    it('keeps every ref when no taxonomy has loaded', () => {
      setTaxonomy('none');
      expect(ids(JSON_TEXT)).toEqual(['acc-desires-001', 'sit-001']);
    });

    it('still drops an id that is not in a loaded taxonomy (t/4675)', () => {
      setTaxonomy('all');
      const slugged = JSON.stringify({ response: ANSWER, taxonomy_refs: [
        { node_id: 'acc-desires-001-faster-progress', relevance: 'x' },
        { node_id: 'sit-999', relevance: 'x' },
        { node_id: 'acc-desires-001', relevance: 'x' },
      ] });
      expect(ids(slugged)).toEqual(['acc-desires-001']);
    });
  });
});
