// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1882 §5 — EntityDetail renders the landed Entity contract read-only. These tests
// pin the field mapping (name/badge/dolce/aliases/status/description/refs/provenance),
// the deprecated + redirected_from affordances, and — critically — that absent optional
// fields OMIT their line rather than rendering "undefined" (AC #4).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Entity } from '@lib/entities/types';

// ExternalLinkRow (via DetailPrimitives) imports the bridge; stub it — no link is
// clicked here, and flight-recorder must not touch a real recorder.
vi.mock('@bridge', () => ({ api: { openExternal: vi.fn() } }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { EntityDetail } from './EntityDetail';

const fullEntity: Entity = {
  id: 'ent-042',
  name: 'OpenAI',
  aliases: ['OpenAI Inc.', 'OpenAI LP'],
  entity_type: 'institution',
  dolce_category: 'non-agentive-social-object',
  description: 'An institution that develops and deploys frontier AI systems.',
  external_refs: [{ label: 'Website', url: 'https://openai.com' }],
  source_refs: ['2023-frontier-safety', 'eu-ai-act-analysis'],
  status: 'approved',
  discovered_by: { model: 'gemini-flash', usage_id: 'u-4471' },
  confidence: 0.86,
  created_at: '2026-01-01',
  last_modified: '2026-01-02',
};

describe('EntityDetail', () => {
  it('survives polymorphic aliases + source_refs (array|null|string) — no throw (t/1882#7)', () => {
    // ent-034 "Claude" has aliases:null; 11 entities have source_refs as a bare string —
    // both despite the string[] type. `.length`/`.map`/`.join` must not throw.
    render(<EntityDetail entity={{
      ...fullEntity,
      aliases: null as unknown as string[],
      source_refs: 'eu-ai-act-analysis' as unknown as string[],
    }} />);
    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.queryByText(/^also:/)).not.toBeInTheDocument(); // null aliases → no row
    // a bare-string source_refs → exactly one chip with the full doc id (not char-sliced)
    expect(screen.getByText('doc: eu-ai-act-analysis')).toBeInTheDocument();
  });

  it('renders a bare-string alias in full, not sliced to a character (t/1884#4)', () => {
    render(<EntityDetail entity={{ ...fullEntity, aliases: 'GDPR' as unknown as string[] }} />);
    expect(screen.getByText('also: GDPR')).toBeInTheDocument();
  });

  it('renders the full field set', () => {
    render(<EntityDetail entity={fullEntity} />);
    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.getByText('institution')).toBeInTheDocument();
    // dolce humanized for display; raw slug preserved on the title attribute
    const dolce = screen.getByText('non agentive social object');
    expect(dolce).toHaveAttribute('title', 'non-agentive-social-object');
    expect(screen.getByText('also: OpenAI Inc., OpenAI LP')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(fullEntity.description)).toBeInTheDocument();
    expect(screen.getByText('References')).toBeInTheDocument();
    expect(screen.getByText('Appears in')).toBeInTheDocument();
    expect(screen.getByText('doc: 2023-frontier-safety')).toBeInTheDocument();
    expect(screen.getByText('Discovered by gemini-flash · usage u-4471')).toBeInTheDocument();
    expect(screen.getByText('Confidence 0.86')).toBeInTheDocument();
  });

  it('source chips are non-interactive (no viewer target yet — spec open-Q3)', () => {
    render(<EntityDetail entity={fullEntity} />);
    const chip = screen.getByText('doc: 2023-frontier-safety');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).not.toHaveAttribute('role');
    expect(chip.closest('button')).toBeNull();
  });

  it('omits every optional line when its field is absent — never renders "undefined"', () => {
    const minimal: Entity = {
      id: 'ent-100',
      name: 'Bare Entity',
      aliases: [],
      entity_type: 'artifact',
      dolce_category: 'non-agentive-functional-artifact',
      description: 'An artifact with no optional fields.',
      status: 'proposed',
      created_at: '2026-01-01',
      last_modified: '2026-01-02',
    };
    const { container } = render(<EntityDetail entity={minimal} />);
    expect(container.textContent).not.toContain('undefined');
    expect(screen.queryByText(/^also:/)).not.toBeInTheDocument();
    expect(screen.queryByText('References')).not.toBeInTheDocument();
    expect(screen.queryByText('Appears in')).not.toBeInTheDocument();
    expect(screen.queryByText(/Discovered by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Confidence/)).not.toBeInTheDocument();
    expect(screen.getByText('Proposed')).toBeInTheDocument();
  });

  it('shows the deprecated banner (muted warning) and keeps rendering the record', () => {
    render(<EntityDetail entity={{ ...fullEntity, status: 'deprecated' }} />);
    expect(screen.getByText('This entity is deprecated.')).toBeInTheDocument();
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
    expect(screen.getByText(fullEntity.description)).toBeInTheDocument();
  });

  it('shows a redirect note when a merge tombstone was followed', () => {
    render(<EntityDetail entity={fullEntity} redirectedFrom="ent-017" />);
    expect(screen.getByText('Redirected from ent-017')).toBeInTheDocument();
  });

  it('does not show a redirect note by default', () => {
    render(<EntityDetail entity={fullEntity} />);
    expect(screen.queryByText(/^Redirected from/)).not.toBeInTheDocument();
  });

  // t/4451 (t/4404 SO condition C2): both API paths already fold a duplicate_of copy to its
  // canonical before this component sees the record (t/4527 server, t/4528 desktop) — this is
  // a value-dedupe safety net at the render layer, not the fold itself.
  it('collapses a source_refs list holding the canonical plus its own value twice to one chip (t/4451)', () => {
    render(<EntityDetail entity={{
      ...fullEntity,
      source_refs: ['doc-canonical', 'doc-canonical'],
    }} />);
    expect(screen.getAllByText('doc: doc-canonical')).toHaveLength(1);
  });

  it('keeps distinct source doc ids as separate chips', () => {
    render(<EntityDetail entity={{
      ...fullEntity,
      source_refs: ['doc-canonical', 'doc-other'],
    }} />);
    expect(screen.getByText('doc: doc-canonical')).toBeInTheDocument();
    expect(screen.getByText('doc: doc-other')).toBeInTheDocument();
  });
});
