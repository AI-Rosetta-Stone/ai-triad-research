// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/764 (docs/ux/debate-fact-check-card.md §1–§2): the pieces of the redesigned fact-check card.
// Presentational only: the card in StatementCard.tsx owns the state and passes plain props.

import type { ReactNode } from 'react';
import type { FactDiscrepancy } from '@lib/debate/types';
import { pillTextOf, quotedClaim, sourceLinksOf, type SourceLink } from './factCheckView';
import './FactCheckCard.css';

export interface FactCheckTarget {
  /** The checked entry's card id: the link scrolls to and highlights `[data-entry-id]`. */
  entryId: string;
  speaker: string;
  kind: string;
}

/** §3: the verdict pill. */
export function FactCheckPill({ verdict, verdictClass }: { verdict: string | undefined; verdictClass: string }) {
  return <span className={`debate-fact-check-verdict ${verdictClass}`}>{pillTextOf(verdict)}</span>;
}

/** Scrolls to the checked statement and flashes its outline. */
function jumpToEntry(entryId: string): void {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(entryId) : entryId;
  const el = document.querySelector<HTMLElement>(`[data-entry-id="${esc}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('debate-fact-check-target-flash');
  window.setTimeout(() => el.classList.remove('debate-fact-check-target-flash'), 1600);
}

/** §1.1 right side: `of {Speaker} · {Kind}`, a link when the card is open and plain text when
 *  collapsed (the whole collapsed row is the click target). The statement id sits in the title. */
export function FactCheckTargetLink({ target, statementId, asLink }: {
  target: FactCheckTarget | null; statementId?: string; asLink: boolean;
}) {
  const title = statementId ? `Statement ${statementId}` : undefined;
  if (!target) return statementId ? <span className="debate-fact-check-target" title={title} id={`stmt-${statementId}`} /> : null;
  const text = <>of {target.speaker} · {target.kind}</>;
  const anchor = statementId ? `stmt-${statementId}` : undefined;
  if (!asLink) {
    return <span className="debate-fact-check-target" title={title} id={anchor}>{text}</span>;
  }
  return (
    <button
      type="button"
      className="debate-fact-check-target debate-fact-check-target-link"
      title={title ? `${title} · go to the checked statement` : 'Go to the checked statement'}
      id={anchor}
      onClick={() => jumpToEntry(target.entryId)}
    >
      {text}
    </button>
  );
}

/** §1.2 `Checked:` and the claim. */
export function FactCheckChecked({ text }: { text: string | undefined }) {
  if (!text || !text.trim()) return null;
  return (
    <p className="debate-fact-check-checked">
      <span className="debate-fact-check-checked-label">Checked:</span>{' '}
      <em className="debate-fact-check-checked-text">{quotedClaim(text)}</em>
    </p>
  );
}

/** §1.3 the one-sentence finding. */
export function FactCheckFinding({ children }: { children: ReactNode }) {
  return <p className="debate-fact-check-finding">{children}</p>;
}

/** §1.4 points, with the single `Limit` bullet last. */
export function FactCheckPoints({ points, limit }: { points: string[]; limit: string | null }) {
  if (points.length === 0 && !limit) return null;
  return (
    <ul className="debate-fact-check-points">
      {points.map((p, i) => <li key={i}>{p}</li>)}
      {limit && (
        <li className="debate-fact-check-limit">
          <span className="debate-fact-check-limit-label">Limit</span> {limit}
        </li>
      )}
    </ul>
  );
}

const DIMENSION_LABEL: Record<FactDiscrepancy['dimension'], string> = {
  magnitude: 'Magnitude', temporal: 'Timing', attribution: 'Attribution', scope: 'Scope', existence: 'Existence',
};

/** §1.5 `Claimed` / `Source says`, for partially_accurate. Replaces the points. */
export function FactCheckDiscrepancyPair({ discrepancy }: { discrepancy: FactDiscrepancy }) {
  return (
    <dl
      className={`debate-fact-check-pair debate-fact-check-severity-${discrepancy.severity}`}
      title={discrepancy.source ? `Source: ${discrepancy.source}` : undefined}
      aria-label={`${DIMENSION_LABEL[discrepancy.dimension] ?? discrepancy.dimension} discrepancy, ${discrepancy.severity}`}
    >
      <dt>Claimed</dt>
      <dd>{discrepancy.claimed}</dd>
      <dt>Source says</dt>
      <dd>{discrepancy.actual}</dd>
    </dl>
  );
}

/** §1.6 `Sources:` with short links and `· +N`. Always visible; omitted when there are none. */
export function FactCheckSourcesRow({ citations }: { citations: readonly { uri: string; title: string }[] }) {
  const { shown, more } = sourceLinksOf(citations);
  if (shown.length === 0) return null;
  const link = (s: SourceLink, i: number) => (s.uri ? (
    <a key={i} href={s.uri} target="_blank" rel="noreferrer noopener" className="debate-fact-check-source-link" title={s.title}>{s.label}</a>
  ) : (
    <span key={i} className="debate-fact-check-source-link debate-fact-check-source-link-plain" title={s.title}>{s.label}</span>
  ));
  return (
    <p className="debate-fact-check-sources-row" aria-label="Sources">
      <span className="debate-fact-check-sources-row-label">Sources:</span>{' '}
      {shown.map((s, i) => <span key={i}>{i > 0 && ', '}{link(s, i)}</span>)}
      {more > 0 && <span className="debate-fact-check-sources-more"> · +{more}</span>}
    </p>
  );
}

/** §1.7 `Show details` / `Hide details`. */
export function FactCheckDetailsToggle({ open, onToggle, panelId }: { open: boolean; onToggle: () => void; panelId: string }) {
  return (
    <button type="button" className="debate-fact-check-details-toggle" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      {open ? 'Hide details' : 'Show details'}
    </button>
  );
}
