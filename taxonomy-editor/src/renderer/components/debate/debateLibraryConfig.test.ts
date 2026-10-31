// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import {
  debatePhaseToStatusToken,
  debateSafeTitle,
  debateSecondaryLine,
  filterDebateRows,
  formatDebateDate,
  renderDebateStatus,
  DEBATE_COLUMNS,
} from './debateLibraryConfig';
import type { SessionRowData } from './debateSessionTypes';
import type { CommunityDebate } from '../../hooks/useCommunityStore';

describe('debatePhaseToStatusToken', () => {
  it('collapses the three pre-debate phases to setup', () => {
    expect(debatePhaseToStatusToken('setup')).toBe('setup');
    expect(debatePhaseToStatusToken('clarification')).toBe('setup');
    expect(debatePhaseToStatusToken('edit-claims')).toBe('setup');
  });

  it('maps opening/debate/closed/cancelled to their own tokens (t/3705#3, #4)', () => {
    expect(debatePhaseToStatusToken('opening')).toBe('opening');
    expect(debatePhaseToStatusToken('debate')).toBe('active');
    expect(debatePhaseToStatusToken('closed')).toBe('closed');
    expect(debatePhaseToStatusToken('cancelled')).toBe('cancelled');
  });

  it('returns null for missing/unmapped phases rather than throwing', () => {
    expect(debatePhaseToStatusToken(undefined)).toBeNull();
    expect(debatePhaseToStatusToken('some-future-phase')).toBeNull();
  });
});

describe('debateSafeTitle', () => {
  it('passes through a plain string title', () => {
    expect(debateSafeTitle({ title: 'Should AI be regulated?' } as SessionRowData)).toBe('Should AI be regulated?');
  });

  it('falls back to final/original when title is corrupted to an object (t/2334)', () => {
    expect(debateSafeTitle({ title: { final: 'Final title' } } as unknown as SessionRowData)).toBe('Final title');
    expect(debateSafeTitle({ title: { original: 'Original title' } } as unknown as SessionRowData)).toBe('Original title');
    expect(debateSafeTitle({ title: {} } as unknown as SessionRowData)).toBe('Untitled');
  });
});

describe('filterDebateRows', () => {
  const myRows: SessionRowData[] = [
    { id: '1', title: 'AI regulation debate', created_at: '', updated_at: '', phase: 'closed', topic_text: 'regulation' },
    { id: '2', title: 'Open source models', created_at: '', updated_at: '', phase: 'closed' },
  ];

  it('filters My rows by title and topic_text, case-insensitively', () => {
    expect(filterDebateRows(myRows, 'REGULATION', 'my')).toHaveLength(1);
    expect(filterDebateRows(myRows, 'open source', 'my')).toHaveLength(1);
    expect(filterDebateRows(myRows, 'nonexistent', 'my')).toHaveLength(0);
  });

  it('returns all rows for an empty query', () => {
    expect(filterDebateRows(myRows, '', 'my')).toHaveLength(2);
  });
});

describe('debateSecondaryLine', () => {
  it('returns null on the My tab for an ordinary (non-inquiry) row', () => {
    const row = { id: '1', title: 't', created_at: '', updated_at: '', phase: 'closed' } as SessionRowData;
    expect(debateSecondaryLine(row, 'my')).toBeNull();
  });

  it('returns "From Ask a Question" on the My tab for an inquiry row (t/4678/t/4683)', () => {
    const row = { id: '1', title: 't', created_at: '', updated_at: '', phase: 'closed', origin_mode: 'inquiry' } as SessionRowData;
    expect(debateSecondaryLine(row, 'my')).toBe('From Ask a Question');
  });

  it('returns "by <author>" on the Community tab when metadata is present', () => {
    const cd = {
      id: '1', title: 't', created_at: '', updated_at: '',
      community_metadata: { submitted_by_display: 'Jane Doe', submitted_at: '', approved_at: '', original_id: '' },
    } as CommunityDebate;
    expect(debateSecondaryLine(cd, 'community')).toBe('by Jane Doe');
  });

  it('returns null on Community when metadata is absent', () => {
    const cd = { id: '1', title: 't', created_at: '', updated_at: '' } as CommunityDebate;
    expect(debateSecondaryLine(cd, 'community')).toBeNull();
  });
});

describe('renderDebateStatus', () => {
  it('includes the "Question" pill for an inquiry row, before the status pill (t/4683)', () => {
    const row = { id: '1', title: 't', created_at: '', updated_at: '', phase: 'closed', origin_mode: 'inquiry' } as SessionRowData;
    const markup = renderToStaticMarkup(renderDebateStatus(row) as ReactElement);
    expect(markup).toContain('debate-lib-question-badge');
    expect(markup).toContain('Question');
    expect(markup.indexOf('debate-lib-question-badge')).toBeLessThan(markup.indexOf('debate-lib-status--closed'));
  });

  it('omits the pill for an ordinary row', () => {
    const row = { id: '1', title: 't', created_at: '', updated_at: '', phase: 'closed' } as SessionRowData;
    const markup = renderToStaticMarkup(renderDebateStatus(row) as ReactElement);
    expect(markup).not.toContain('debate-lib-question-badge');
  });

  it('still shows the pill when phase is unmapped (no status token)', () => {
    const row = { id: '1', title: 't', created_at: '', updated_at: '', phase: 'some-future-phase', origin_mode: 'inquiry' } as SessionRowData;
    const markup = renderToStaticMarkup(renderDebateStatus(row) as ReactElement);
    expect(markup).toContain('debate-lib-question-badge');
    expect(markup).toContain('lib-empty-value');
  });
});

describe('formatDebateDate', () => {
  it('formats as month/day/hour/minute', () => {
    const formatted = formatDebateDate('2026-08-16T10:48:00Z');
    // Locale-dependent exact string; assert shape rather than an exact literal.
    expect(formatted).toMatch(/[A-Za-z]{3}\s+\d{1,2}/);
  });
});

describe('DEBATE_COLUMNS', () => {
  it('declares all four data columns as sortable — none silently dropped (t/3705#2)', () => {
    const sortableKeys = DEBATE_COLUMNS.filter(c => c.sortable).map(c => c.key);
    expect(sortableKeys.sort()).toEqual(['date', 'model', 'status', 'turns']);
  });

  it('right-aligns Turns and only Turns', () => {
    const rightAligned = DEBATE_COLUMNS.filter(c => c.align === 'right').map(c => c.key);
    expect(rightAligned).toEqual(['turns']);
  });

  it('sorts Turns numerically via its comparator, not lexicographically', () => {
    const turnsCol = DEBATE_COLUMNS.find(c => c.key === 'turns')!;
    const a = { turn_count: 9 } as SessionRowData;
    const b = { turn_count: 10 } as SessionRowData;
    // Lexicographic '10' < '9' would give the wrong sign; numeric compare must return < 0.
    expect(turnsCol.compare!(a, b, 'my')).toBeLessThan(0);
  });
});
