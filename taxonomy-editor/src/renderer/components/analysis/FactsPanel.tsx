// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { EntityRef } from '@lib/entities/types';
import { reconstructSeiContainer } from '../shared/mentionText';
import { useContainerMentions, MentionField } from '../shared/MentionField';
import './FactsPanel.css';

export interface SourceFact {
  claim: string;
  label: string;
  doc_id: string;
  specificity: string;
  temporal_bound: string | null;
}

type FactsIndex = Record<string, { facts: SourceFact[] }>;

// Module-level cache — loaded once, reused across renders
let _factsCache: FactsIndex | null = null;
let _factsLoading = false;
let _factsListeners: Array<() => void> = [];

async function getFactsIndex(): Promise<FactsIndex> {
  if (_factsCache) return _factsCache;
  if (_factsLoading) {
    return new Promise((resolve) => {
      _factsListeners.push(() => resolve(_factsCache!));
    });
  }
  _factsLoading = true;
  try {
    _factsCache = (await api.loadSourceEvidenceIndex()) as FactsIndex | null ?? {};
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'facts-panel',
      level: 'error',
      message: 'Failed to load source evidence index',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    _factsCache = {};
  }
  _factsLoading = false;
  for (const cb of _factsListeners) cb();
  _factsListeners = [];
  return _factsCache;
}

/** Return the fact count for a node (synchronous — returns 0 until cache is warm). */
export function getFactCount(nodeId: string): number {
  return _factsCache?.[nodeId]?.facts?.length ?? 0;
}

/** Kick off cache loading eagerly (call from parent on mount). */
export function preloadFactsIndex(): void {
  void getFactsIndex();
}

const SPECIFICITY_COLORS: Record<string, { bg: string; fg: string }> = {
  precise: { bg: 'rgba(34,197,94,0.12)', fg: '#16a34a' },
  qualified: { bg: 'rgba(234,179,8,0.12)', fg: '#ca8a04' },
  unknown: { bg: 'rgba(148,163,184,0.12)', fg: '#64748b' },
};

export function FactsPanel({ nodeId, onSelectFact, onSelectRef }: {
  nodeId: string;
  onSelectFact?: (fact: SourceFact | null) => void;
  /** Ref-select handler injected by a co-mounted DetailPane. Mentions linkify ONLY when
   *  this is wired — otherwise claims render as plain text (t/1977: never a dead link
   *  where no pane receives the click). The taxonomy-view DetailPane host (blocks t/1906)
   *  supplies it; until then FactsPanel renders plain. */
  onSelectRef?: (ref: EntityRef) => void;
}) {
  const [facts, setFacts] = useState<SourceFact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  // t/4919: track which node's first fact we've already defaulted open, so a re-render with a
  // new `facts` array identity for the SAME node (e.g. a cache refetch) doesn't reopen a card
  // the user collapsed.
  const defaultAppliedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpanded(null);
    defaultAppliedFor.current = null;
    onSelectFact?.(null);
    void getFactsIndex().then((idx) => {
      if (cancelled) return;
      setFacts(idx[nodeId]?.facts ?? []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [nodeId]);

  // t/4919: default the first fact expanded, once per node, only after facts have loaded —
  // WITHOUT calling onSelectFact (Design t/4919#2: the split pane opens only on an explicit
  // click, not the default).
  useEffect(() => {
    if (facts && facts.length > 0 && defaultAppliedFor.current !== nodeId) {
      setExpanded(0);
      defaultAppliedFor.current = nodeId;
    }
  }, [facts, nodeId]);

  // Mention-render kit (t/1906): reconstruct the sei:<nodeId> container from the fact
  // claims (single-LF join) so stored entity-name mentions can render as .ref-link
  // buttons. Two gates:
  //   1. Co-mount (t/1977): linkify ONLY when `onSelectRef` is wired — a link must have a
  //      DetailPane to receive its click, else render plain text (never a dead link). The
  //      taxonomy-view host that supplies onSelectRef blocks t/1906; until then → plain.
  //   2. WCAG AA (§9): links render only in the EXPANDED claim (var(--text-primary),
  //      passes AA in all 4 themes). The collapsed preview stays plain — it uses
  //      var(--text-muted) and .ref-link inherits color (var(--focus-ring) is undefined
  //      app-wide), which fails AA at the preview's small muted size.
  // Hooks stay unconditional (above the early returns); claims are plain text (no
  // HighlightedTextarea caveat).
  const containerId = `sei:${nodeId}`;
  const container = useMemo(
    () => reconstructSeiContainer((facts ?? []).map(f => f.claim)),
    [facts],
  );
  const mentions = useContainerMentions(onSelectRef ? containerId : null);
  const renderClaim = (index: number, claim: string) => {
    if (!onSelectRef) return claim; // no co-mounted pane → plain text (t/1977)
    const field = container.fields.find(f => f.name === `fact-${index}`);
    return field
      ? <MentionField field={field} mentions={mentions} onSelectRef={onSelectRef} />
      : claim;
  };

  if (loading) {
    return <div className="facts-message">Loading facts...</div>;
  }

  if (!facts || facts.length === 0) {
    return <div className="facts-message">No source evidence linked to this node.</div>;
  }

  return (
    <div className="facts-root">
      <div className="facts-count">
        {facts.length} fact{facts.length !== 1 ? 's' : ''} from source documents
      </div>
      {facts.map((f, i) => {
        const isExpanded = expanded === i;
        const spec = SPECIFICITY_COLORS[f.specificity] ?? SPECIFICITY_COLORS.unknown;
        return (
          <div
            key={`${f.doc_id}-${i}`}
            className="facts-card"
            aria-expanded={isExpanded}
            /* eslint-disable-next-line local/no-inline-style -- dynamic: expand-state background */
            style={{ background: isExpanded ? 'var(--bg-secondary)' : 'transparent' }}
            onClick={() => {
              const next = isExpanded ? null : i;
              setExpanded(next);
              onSelectFact?.(next !== null ? f : null);
            }}
          >
            <div className="facts-card-head">
              <span className="facts-caret">
                {isExpanded ? '\u25BC' : '\u25B6'}
              </span>
              <div className="facts-card-body">
                <div className="facts-label">{f.label}</div>
                {!isExpanded && (
                  <div className="facts-claim-preview">
                    {f.claim}
                  </div>
                )}
              </div>
              <span
                className="facts-badge"
                /* eslint-disable-next-line local/no-inline-style -- dynamic: data-driven specificity colors */
                style={{ background: spec.bg, color: spec.fg }}
              >
                {f.specificity}
              </span>
            </div>
            {isExpanded && (
              <div className="facts-expanded">
                <div className="facts-claim-full">{renderClaim(i, f.claim)}</div>
                <div className="facts-meta">
                  <span title="Source document"><strong>Doc:</strong> {f.doc_id}</span>
                  {f.temporal_bound && (
                    <span title="Temporal bound"><strong>Period:</strong> {f.temporal_bound}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
