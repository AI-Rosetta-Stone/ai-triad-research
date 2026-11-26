// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/701 (docs/ux/debate-statement-density.md): the pieces of a statement card that make a
// debate less to take in at once. Kept out of StatementCard.tsx for its line budget.
//   §1 StructuredBrief: one bold claim plus 2 or 3 support bullets.
//   §3 ReadMoreLink:    `Read full statement (≈N words)` / `Show brief`.
//   §6 HeaderTurnSymbols: the model-chosen emoji, small, in the header, as decoration.
//   §8 collapsedClaimOf: the one line a collapsed turn shows.

import type { TranscriptEntry } from '../../types/debate';
import { firstSentence, roundedWordCount, splitTagline } from './utils';
import './StatementBrief.css';

/** The structured Brief fields t/700 adds to `entry.summaries`. Optional: debates generated
 *  before that change have only the `brief` and `medium` strings. */
type StructuredSummaries = { brief_claim?: unknown; brief_points?: unknown };

/** The structured Brief, or null when the entry has none (old debates: show the `brief` string). */
export function structuredBriefOf(entry: TranscriptEntry): { claim: string; points: string[] } | null {
  const s = entry.summaries as (TranscriptEntry['summaries'] & StructuredSummaries) | undefined;
  const claim = typeof s?.brief_claim === 'string' ? s.brief_claim.trim() : '';
  if (!claim) return null;
  const points = Array.isArray(s?.brief_points)
    ? s.brief_points.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map(p => p.trim())
    : [];
  return { claim, points };
}

/** The structured Brief as plain text: what find-in-debate highlights and comments anchor to. */
export function structuredBriefText(brief: { claim: string; points: string[] }): string {
  return [brief.claim, ...brief.points].join('\n');
}

/** §8: the claim a collapsed turn shows: `brief_claim`, or the first sentence of the `brief`
 *  string for an old debate, or of the statement itself when it was never summarized. */
export function collapsedClaimOf(entry: TranscriptEntry): string {
  return structuredBriefOf(entry)?.claim ?? firstSentence(splitTagline(entry.summaries?.brief ?? '').body || entry.content);
}

export function StructuredBrief({ claim, points }: { claim: string; points: string[] }) {
  return (
    <>
      <p className="debate-brief-claim">{claim}</p>
      {points.length > 0 && (
        <ul className="debate-brief-points">
          {points.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
    </>
  );
}

/** §3: says that more exists, and how much. A button in link colour; `aria-expanded` is true
 *  while the full statement is showing. The same element serves both states, so focus stays on it. */
export function ReadMoreLink({ showingFull, content, controlsId, onToggle }: {
  showingFull: boolean;
  content: string;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <div className="debate-read-more">
      <button
        type="button"
        className="debate-link-btn"
        aria-expanded={showingFull}
        aria-controls={controlsId}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        {showingFull ? 'Show brief' : `Read full statement (≈${roundedWordCount(content)} words)`}
      </button>
    </div>
  );
}

/** §6: decoration, not a control. Each symbol is an image whose name is the analogy it stands for. */
export function HeaderTurnSymbols({ turnSymbols }: { turnSymbols: { symbol: string; tooltip: string }[] | undefined }) {
  if (!(turnSymbols && turnSymbols.length > 0)) return null;
  return (
    <span className="debate-turn-symbols">
      {turnSymbols.map((s, i) => (
        <span key={i} className="debate-turn-symbol" role="img" aria-label={s.tooltip} title={s.tooltip}>
          {s.symbol}
        </span>
      ))}
    </span>
  );
}
