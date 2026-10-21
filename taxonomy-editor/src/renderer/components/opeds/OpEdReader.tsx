// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// OpEdReader — renders one op-ed SET as an article (t/2576 PR#1, §6). A multi-voice
// set gets a camp-tab strip (roving-tabindex tablist); a single-voice set renders the
// one article directly with no tab strip (TL ruling t/2576#3). Each article is a
// landmark <article> whose headline is the region's sole <h1>. Grounding ids are real
// <button aria-expanded> disclosures that expand an inline taxonomy-element card.

import { useState, useCallback, useRef, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OpEdSet, OpEdMember, OpEdGroundingRef, PovKey } from '../../../../../lib/oped/types';
import { resolvePovMeta } from './povResolve';
import { opedTagScopeText, tagLabelFor } from './opedTagScopeText';
import { registryOrNull } from '../debate/SeatTagPicker';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, povOfNode } from '../../hooks/useTaxonomyStore/superseded';
import { NodeDetail } from '../taxonomy/NodeDetail';
import { SituationDetail } from '../debate/SituationDetail';
import './OpEdReader.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ──────────────────────────────────────────────
// Inline grounding-element detail card (§6 clickable grounding)
// ──────────────────────────────────────────────

function GroundingDetailCard({ ref, onClose, claims }: { ref: OpEdGroundingRef; onClose: () => void; claims?: { text: string; paragraph: number }[] }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const state = useTaxonomyStore.getState();

  useEffect(() => {
    const el = cardRef.current;
    if (el) el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const openInTaxonomy = useCallback((tab: string, id: string) => {
    // navigateToNode swaps the app to the taxonomy tab and selects the node.
    (useTaxonomyStore.getState().navigateToNode as (t: string, id: string) => void)(tab, id);
  }, []);

  // Resolve the node exactly like SearchPreview: situations first, then each POV set.
  let body: React.ReactNode = <div className="oped-grounding-card-empty">Element not found in the loaded taxonomy.</div>;
  let openTab: string | null = null;

  if (ref.node_id?.startsWith('sit-')) {
    const node = state.situations?.nodes.find(n => n.id === ref.node_id);
    if (node) { body = <SituationDetail node={node} readOnly chipDepth={0} />; openTab = 'situations'; }
  } else if (ref.node_id) {
    // t/4355: an op-ed citation shows the exact node it cited, superseded or not.
    const node = allNodesById(state).get(ref.node_id);
    const p = povOfNode(state, ref.node_id);
    if (node && p) { body = <NodeDetail pov={p} node={node} readOnly chipDepth={0} />; openTab = p; }
  }

  return (
    <div ref={cardRef} className="oped-grounding-card">
      <div className="oped-grounding-card-head">
        <span className="oped-grounding-card-id">{ref.node_id}</span>
        <div className="oped-grounding-card-head-actions">
          {openTab && (
            <button
              type="button"
              className="oped-grounding-card-open"
              onClick={() => openInTaxonomy(openTab!, ref.node_id)}
              title="Open this element in the taxonomy tree"
            >
              Open in Taxonomy →
            </button>
          )}
          <button type="button" className="oped-grounding-card-close" onClick={onClose} aria-label="Close element detail" title="Close">×</button>
        </div>
      </div>
      {ref.how_reflected && (
        <div className="oped-grounding-card-reflected">
          <span className="oped-grounding-card-reflected-label">Reflected in this op-ed:</span> {ref.how_reflected}
        </div>
      )}
      {ref.document_claims && ref.document_claims.length > 0 && (
        <div className="oped-grounding-card-claims">
          <span className="oped-grounding-card-claims-label">Addresses these source claims:</span>
          <ul className="oped-grounding-card-claims-list">
            {ref.document_claims.map((c, i) => {
              const matchIdx = claims?.findIndex(cl => cl.text === c) ?? -1;
              const claimNum = matchIdx >= 0 ? matchIdx + 1 : null;
              const para = matchIdx >= 0 ? claims![matchIdx].paragraph : null;
              return (
                <li key={i}>
                  {claimNum != null && <strong>Claim #{claimNum} · </strong>}
                  {c}
                  {para != null && para > 0 && (
                    <span className="oped-claim-para" title={`Paragraph ${para}`} aria-label={`Paragraph ${para}`}>¶{para}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {body}
    </div>
  );
}

// ──────────────────────────────────────────────
// Claims section (t/2890) — source claims above taxonomy grounding
// ──────────────────────────────────────────────

function ClaimsSection({ claims }: { claims: { text: string; paragraph: number }[] }) {
  if (claims.length === 0) return null;
  return (
    <details className="oped-claims" open>
      <summary className="oped-claims-summary">Claims ({claims.length})</summary>
      <ol className="oped-claims-list">
        {claims.map((c, i) => (
          <li key={i} className="oped-claim-item">
            {c.text}
            {c.paragraph > 0 && (
              <span
                className="oped-claim-para"
                title={`Paragraph ${c.paragraph}`}
                aria-label={`Paragraph ${c.paragraph}`}
              >
                ¶{c.paragraph}
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

// ──────────────────────────────────────────────
// Grounding section (collapsible table + inline expand)
// ──────────────────────────────────────────────

function GroundingSection({ grounding, claims }: { grounding: OpEdGroundingRef[]; claims?: { text: string; paragraph: number }[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showUnused, setShowUnused] = useState(false);

  useEffect(() => {
    if (!expandedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expandedId]);

  if (grounding.length === 0) {
    return <p className="oped-voice-only">Written from voice alone (no taxonomy grounding).</p>;
  }

  // t/2703: elements the AI judged 'not directly used' are noise by default — partition
  // them out and reveal on demand via the toggle below. Used rows keep their (relevance) order.
  const used = grounding.filter(g => g.how_reflected !== 'not directly used');
  const unused = grounding.filter(g => g.how_reflected === 'not directly used');
  const visible = showUnused ? [...used, ...unused] : used;

  // Only a visible row can stay expanded — hiding the unused set closes any card it owned.
  const expandedRef = visible.find(g => g.node_id === expandedId) ?? null;

  return (
    <details className="oped-grounding" open>
      <summary className="oped-grounding-summary">Taxonomy grounding ({grounding.length} element{grounding.length !== 1 ? 's' : ''})</summary>
      <div className="oped-grounding-table-wrap">
        <table className="oped-grounding-table">
          <caption className="sr-only">Taxonomy grounding for this op-ed</caption>
          <thead>
            <tr>
              <th scope="col">Element</th>
              <th scope="col">Relevance</th>
              <th scope="col">Reflected in the op-ed</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(g => {
              const isOpen = g.node_id === expandedId;
              return (
                <tr key={g.node_id} className={isOpen ? 'oped-grounding-row-active' : ''}>
                  <td>
                    <button
                      type="button"
                      className="oped-grounding-id-btn"
                      aria-expanded={isOpen}
                      title={g.node_id}
                      onClick={() => setExpandedId(isOpen ? null : g.node_id)}
                    >
                      {g.label || g.node_id}
                    </button>
                  </td>
                  <td>{g.relevance || '—'}</td>
                  <td>{g.how_reflected || '(not reported)'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unused.length > 0 && (
        <button
          type="button"
          className="oped-grounding-toggle-unused"
          aria-expanded={showUnused}
          onClick={() => setShowUnused(v => !v)}
        >
          {showUnused ? 'Hide' : 'Show'} {unused.length} unused element{unused.length !== 1 ? 's' : ''}
        </button>
      )}
      {expandedRef && <GroundingDetailCard ref={expandedRef} onClose={() => setExpandedId(null)} claims={claims} />}
    </details>
  );
}

// ──────────────────────────────────────────────
// One article (a single voice)
// ──────────────────────────────────────────────

function OpEdArticle({ member, outlet }: { member: OpEdMember; outlet?: string }) {
  const meta = resolvePovMeta(member.pov);
  const metaLine = [meta.label.toUpperCase(), outlet || null, `${member.wordCount} words`]
    .filter(Boolean).join(' · ');

  return (
    <article className="oped-article">
      {/* Camp-accent strip — label text carries the identity, never color alone */}
      <div
        className="oped-article-strip"
        // eslint-disable-next-line local/no-inline-style -- dynamic: camp accent color from POV_META cssVar (theme-aware)
        style={{ borderLeftColor: `var(${meta.cssVar})` }}
      >
        {metaLine}
      </div>
      {/* t/3992: a one-wing essay says so, so it never reads as the whole camp's position (TL t/3960#3). */}
      {member.tag && (
        <p className="oped-tag-scope" role="note">
          {opedTagScopeText(meta.label, tagLabelFor(member.tag.pov, member.tag.tag, registryOrNull()), member.tag)}
        </p>
      )}

      {member.status !== 'complete' ? (
        <div className="oped-article-notice" role="status">
          This voice {member.status === 'failed' ? 'failed to generate' : 'was cancelled'} — no essay is available for it.
        </div>
      ) : (
        <>
          <h1 className="oped-article-headline">{member.headline}</h1>
          {member.subtitle && <p className="oped-article-subtitle">{member.subtitle}</p>}
          {member.byline && <p className="oped-byline">{member.byline}</p>}
          {member.disclosure && <p className="oped-disclosure" role="note">{member.disclosure}</p>}
          <div className="oped-reader-body">
            <Markdown remarkPlugins={[remarkGfm]}>{member.body}</Markdown>
          </div>
          {member.claims && member.claims.length > 0 && <ClaimsSection claims={member.claims} />}
          <GroundingSection grounding={member.grounding} claims={member.claims} />

          {member.rhetorical_meta && (
            <section className="oped-rhetorical-meta" aria-label="What this op-ed did">
              <h2 className="oped-rhetorical-meta-heading">What this op-ed did</h2>
              <p>{member.rhetorical_meta}</p>
            </section>
          )}
        </>
      )}
    </article>
  );
}

// ──────────────────────────────────────────────
// Reader (tab strip for multi-voice sets)
// ──────────────────────────────────────────────

export function OpEdReader({
  set, initialPov, onPovChange,
}: {
  set: OpEdSet;
  /** t/3486: camp tab a deep link asked to open on — seeds the initial active tab. */
  initialPov?: string;
  /** t/3486: fires whenever the active camp tab changes, so the URL can track it. */
  onPovChange?: (pov: string) => void;
}) {
  const members = set.opeds;
  const [activeIdx, setActiveIdxState] = useState(() => {
    const idx = initialPov ? members.findIndex(m => m.pov === initialPov) : -1;
    return idx >= 0 ? idx : 0;
  });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const active = members[Math.min(activeIdx, members.length - 1)];

  const setActiveIdx = useCallback((idx: number) => {
    setActiveIdxState(idx);
    onPovChange?.(members[idx].pov);
  }, [members, onPovChange]);

  const onTabKeyDown = useCallback((e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % members.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + members.length) % members.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = members.length - 1;
    else return;
    e.preventDefault();
    setActiveIdx(next);
    tabRefs.current[next]?.focus();
  }, [members.length, setActiveIdx]);

  if (members.length === 0) {
    return <div className="oped-reader oped-reader-empty">This op-ed set has no voices.</div>;
  }

  // Single-voice set: no tab strip, render the article directly (TL ruling t/2576#3).
  if (members.length === 1) {
    return (
      <div className="oped-reader">
        <OpEdArticle member={members[0]} outlet={set.params.outlet} />
      </div>
    );
  }

  return (
    <div className="oped-reader">
      <div className="oped-tabstrip" role="tablist" aria-label="Op-ed voices">
        {members.map((m, i) => {
          const meta = resolvePovMeta(m.pov);
          const isActive = i === activeIdx;
          return (
            <button
              key={`${m.pov}-${i}`}
              ref={el => { tabRefs.current[i] = el; }}
              role="tab"
              id={`oped-tab-${i}`}
              aria-selected={isActive}
              aria-controls="oped-panel"
              tabIndex={isActive ? 0 : -1}
              className={`oped-tab${isActive ? ' oped-tab-active' : ''}`}
              // eslint-disable-next-line local/no-inline-style -- dynamic: active underline uses the camp's theme color
              style={isActive ? { borderBottomColor: `var(${meta.cssVar})`, color: `var(${meta.cssVar})` } : undefined}
              onClick={() => setActiveIdx(i)}
              onKeyDown={e => onTabKeyDown(e, i)}
            >
              {meta.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id="oped-panel" aria-labelledby={`oped-tab-${activeIdx}`}>
        <OpEdArticle member={active} outlet={set.params.outlet} />
      </div>
    </div>
  );
}
