// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/771: exports show a fact check's verdict, read from metadata, exactly once for every entry shape.

import { describe, it, expect } from 'vitest';
import { factCheckExportView, factCheckExportLines, factCheckSummaryText, FACT_VERDICT_LABEL } from './factCheckExport.js';
import { debateToText, debateToMarkdown, type ExportableDebateSession } from './debateExport.js';
import { formatDebateMarkdown } from './formatters.js';
import type { DebateSession } from './types.js';

// A new app entry (after t/766): content is the claim and explanation only.
const newEntry = {
  id: 'f1', timestamp: 't', type: 'fact-check', speaker: 'system', taxonomy_refs: [],
  content: '*"Women hold 45% of C-suite roles."*\n\nThe evidence shows 29%.',
  metadata: { fact_check: {
    verdict: 'partially_accurate', checked_text: 'Women hold 45% of C-suite roles.',
    finding: 'Overstated. Women hold 29% of C-suite positions as of 2024, not 45%.',
    finding_points: ['A 2024 industry survey reports 29%.'], limit: 'One survey year.',
    explanation: 'The evidence shows 29%.',
    web_search_citations: [{ title: 'Women in the Workplace 2024', uri: 'https://example.org/a' }, { title: 'Women in the Workplace 2024', uri: 'https://example.org/b' }],
  } },
};
// A new app entry without a finding (e.g. the validator dropped it).
const noFinding = { ...newEntry, id: 'f2', metadata: { fact_check: { verdict: 'disputed', checked_text: 'X is Y.', explanation: 'Sources conflict on X.' } } };
// An old app entry (before t/766): the title line carries the verdict.
const oldEntry = { ...newEntry, id: 'f3', content: '**Fact Check: Supported**\n\n*"X is Y."*\n\nConfirmed by the report.', metadata: { fact_check: { verdict: 'supported', explanation: 'Confirmed by the report.' } } };
// An engine (CLI) entry: metadata.verdict, content states it.
const engineEntry = { ...newEntry, id: 'f4', content: 'Claim AN-3 — false: The report says the opposite.', metadata: { source: 'auto', verdict: 'false', claim_text: 'X rose.' } };

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('factCheckExportView', () => {
  it('reads the verdict from metadata.fact_check, else metadata.verdict, with the shared labels', () => {
    expect(factCheckExportView(newEntry).label).toBe('Partly accurate');
    expect(factCheckExportView(engineEntry).label).toBe('False');
    expect(factCheckExportView({ content: 'x', metadata: { fact_check: { verdict: 'verified' } } }).label).toBe('Supported');
    expect(factCheckExportView({ content: 'x' }).label).toBe('Unknown');
  });

  it('labels match the card pill text when upper-cased', () => {
    expect(Object.values(FACT_VERDICT_LABEL).map(l => l.toUpperCase())).toEqual(['SUPPORTED', 'PARTLY ACCURATE', 'DISPUTED', 'FALSE', "CAN'T VERIFY"]);
  });

  it('dedupes citation titles and never shows urls', () => {
    expect(factCheckExportView(newEntry).sources).toEqual(['Women in the Workplace 2024']);
  });
});

describe('factCheckExportLines', () => {
  it('new entry: verdict, checked claim, finding, points, limit, sources', () => {
    const out = factCheckExportLines(newEntry, 'text').join('\n');
    expect(out).toBe([
      'Fact check: Partly accurate',
      'Checked: "Women hold 45% of C-suite roles."',
      '',
      'Overstated. Women hold 29% of C-suite positions as of 2024, not 45%.',
      '- A 2024 industry survey reports 29%.',
      'Limit: One survey year.',
      '',
      'Sources: Women in the Workplace 2024',
    ].join('\n'));
    expect(factCheckExportLines(newEntry, 'markdown')[0]).toBe('**Fact check: Partly accurate**');
  });

  it('no finding: falls back to the explanation', () => {
    expect(factCheckExportLines(noFinding, 'text')).toEqual(['Fact check: Disputed', 'Checked: "X is Y."', '', 'Sources conflict on X.']);
  });

  it('old app entry and engine entry: content as stored, so the verdict appears once', () => {
    expect(factCheckExportLines(oldEntry, 'markdown')).toEqual([oldEntry.content]);
    expect(factCheckExportLines(engineEntry, 'text')).toEqual([engineEntry.content]);
  });

  it('summary text never repeats the verdict', () => {
    expect(factCheckSummaryText(oldEntry)).toEqual({ label: 'Supported', text: 'Confirmed by the report.' });
    expect(factCheckSummaryText(engineEntry)).toEqual({ label: 'False', text: 'Claim AN-3: The report says the opposite.' });
  });
});

const exportable = (entries: unknown[]): ExportableDebateSession => ({
  id: 'd1', title: 'T', created_at: 't', updated_at: 't', phase: 'closed', topic: { original: 'Q?', final: 'Q?' },
  active_povers: ['accelerationist', 'safetyist', 'skeptic'], user_is_pover: false, transcript: entries as ExportableDebateSession['transcript'],
});
const session = (entries: unknown[]) => ({
  id: 'd1', title: 'T', created_at: 't', updated_at: 't', phase: 'closed', topic: { original: 'Q?', refined: null, final: 'Q?' },
  source_type: 'topic', source_ref: '', source_content: '', active_povers: ['accelerationist', 'safetyist', 'skeptic'],
  user_is_pover: false, context_summaries: [], transcript: entries,
}) as unknown as DebateSession;

describe('exports carry the verdict once (t/771 regression)', () => {
  it('debateToText and debateToMarkdown: a new entry has its verdict', () => {
    expect(debateToText(exportable([newEntry]))).toContain('Fact check: Partly accurate');
    expect(debateToMarkdown(exportable([newEntry]))).toContain('**Fact check: Partly accurate**');
  });

  it('debateToText and debateToMarkdown: an old entry and an engine entry have it exactly once', () => {
    const text = debateToText(exportable([oldEntry, engineEntry]));
    const md = debateToMarkdown(exportable([oldEntry, engineEntry]));
    for (const out of [text, md]) {
      expect(count(out.toLowerCase(), 'fact check: supported')).toBe(1);
      expect(count(out, 'false')).toBe(1);
    }
  });

  it('formatDebateMarkdown: labels from metadata, once each', () => {
    const out = formatDebateMarkdown(session([newEntry, oldEntry, engineEntry]));
    expect(out).toContain('- **Partly accurate** _[user]_: Overstated. Women hold 29%');
    expect(out).toContain('- **Supported** _[user]_: Confirmed by the report.');
    expect(out).toContain('- **False** _[auto]_: Claim AN-3: The report says the opposite.');
    expect(out).toContain('*3 checks: 1 Partly accurate, 1 Supported, 1 False*');
    expect(out).not.toContain('unknown');
  });
});
