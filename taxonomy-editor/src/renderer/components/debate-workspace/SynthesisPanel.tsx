// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809 (spec docs/ux/debate-synthesis-v2.md §3-§8, §12): the synthesis "sponsor briefing" panel.
// Presentational only: every join, label and rule is in synthesisView.ts, placement and state in
// SynthesisTop.tsx. Share, Export brief, Run another round and Debate this are not rendered:
// nothing in the page can call them (listed in the PR). The panel has no inner scroll box.

import { createContext, useCallback, useContext, useId, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { CampRef, DisputeCardView, StripLegendItem, StripSegment, StrongestArgumentsCamp, SynthesisView } from '@lib/debate/synthesisView';
import { readCheckedQuestions, writeCheckedQuestions } from './synthesisStorage';
import { HighlightedText } from './StatementCard';
import './SynthesisPanel.css';

/** In-debate find state for the panel (spec §12): offsets are per keyed text, see synthesisFind.ts. */
export interface PanelFind { query: string; current: number; offsets: Map<string, number> }
const FindContext = createContext<PanelFind | null>(null);

/** One highlightable string; `k` is its key in synthesisFindTexts. */
function Hl({ k, text }: { k: string; text: string }) {
  const f = useContext(FindContext);
  if (!f || !f.query) return <>{text}</>;
  return <HighlightedText text={text} query={f.query} matchOffset={f.offsets.get(k) ?? 0} currentIndex={f.current} />;
}

/** While a find is active every expander is open, so each counted match has an element. */
function useFindOpen(): boolean {
  return !!useContext(FindContext)?.query;
}

/** t/824 (spec §13.2): opens the New Debate dialog with a question prefilled; absent = no button. */
const DebateTopicContext = createContext<((topic: string) => void) | null>(null);

function DebateThisQuestion({ text }: { text: string }) {
  const open = useContext(DebateTopicContext);
  if (!open) return null;
  return (
    <button type="button" className="btn btn-ghost btn-xs syn-debate" aria-label={`Debate this question: ${text}`} onClick={() => open(text)}>
      Debate this question
    </button>
  );
}

/** t/823 (spec §13.1): every D# in the panel links to its dispute card and shows the question. */
interface DisputeLinks { points: Map<string, string>; jump: (n: string) => void }
const DisputeLinksContext = createContext<DisputeLinks | null>(null);

/** A D# as a link. `block` fills its parent (a strip segment); otherwise it sits inline in text. */
function DisputeRef({ n, block = false }: { n: string; block?: boolean }) {
  const ctx = useContext(DisputeLinksContext);
  const tipId = useId();
  const point = ctx?.points.get(n);
  if (!ctx || !point) return <>{n}</>;
  return (
    <span className={block ? 'syn-ref syn-ref-block' : 'syn-ref'}>
      <a
        href={`#syn-dispute-${n}`}
        className="syn-ref-link"
        aria-describedby={tipId}
        onClick={e => { e.preventDefault(); ctx.jump(n); }}
      >{n}</a>
      <span id={tipId} role="tooltip" className="syn-tip">{point}</span>
    </span>
  );
}

/** Text with D# tokens turned into links ("Settles D1, D2"). */
function WithDisputeRefs({ text }: { text: string }) {
  return <>{text.split(/(D\d+)/).map((part, i) => (/^D\d+$/.test(part) ? <DisputeRef key={i} n={part} /> : part))}</>;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

const campClass = (id: string): string =>
  id === 'accelerationist' ? 'syn-camp-acc' : id === 'safetyist' ? 'syn-camp-saf' : id === 'skeptic' ? 'syn-camp-skp' : 'syn-camp-other';

function CampChip({ camp }: { camp: CampRef }) {
  return (
    <span className={`syn-camp-chip ${campClass(camp.id)}`}>
      <span className="syn-camp-dot" aria-hidden="true" />
      {camp.label}
    </span>
  );
}

/** First 3 items, then a button. */
function Capped<T>({ items, render, listClass, showAll, showMore, tag = 'ul', onShowFewer }: {
  items: T[];
  render: (item: T, i: number) => React.ReactNode;
  listClass: string;
  /** Button text when collapsed: "Show all N points" (gets the total). */
  showAll?: (total: number) => string;
  /** Button text when collapsed: "Show N more cruxes" (gets the hidden count). */
  showMore?: (hidden: number) => string;
  tag?: 'ul' | 'div';
  /** Called when "Show fewer" is pressed (a parent may reset its own per-row state). */
  onShowFewer?: () => void;
}) {
  const [picked, setPicked] = useState(false);
  const findOpen = useFindOpen();
  const open = picked || findOpen;
  const listId = useId();
  const hidden = items.length - 3;
  const shown = open || hidden <= 0 ? items : items.slice(0, 3);
  const Tag = tag;
  return (
    <>
      <Tag id={listId} className={listClass}>{shown.map(render)}</Tag>
      {hidden > 0 && (
        <button type="button" className="btn btn-ghost syn-more" aria-expanded={open} aria-controls={listId} onClick={() => { if (picked) onShowFewer?.(); setPicked(o => !o); }}>
          {open ? 'Show fewer' : showAll ? showAll(items.length) : showMore ? showMore(hidden) : `Show ${hidden} more`}
        </button>
      )}
    </>
  );
}

function OutcomeStrip({ strip }: { strip: NonNullable<SynthesisView['strip']> }) {
  const seg = (s: StripSegment) => (
    <li
      key={s.n}
      className={`syn-seg ${s.outcome === 'camp' && s.camp ? `syn-seg-camp ${campClass(s.camp.id)}` : 'syn-seg-unresolved'}`}
      data-no-verdict={s.noVerdict || undefined}
    ><DisputeRef n={s.n} block /></li>
  );
  const dot = (l: StripLegendItem) => (
    <li key={l.key} className="syn-legend-item">
      <span className={`syn-legend-swatch ${l.key === 'unresolved' || l.key === 'none' ? 'syn-seg-unresolved' : `syn-seg-camp ${campClass(l.key)}`}`} aria-hidden="true" />
      {l.label} <strong>{l.count}</strong>
    </li>
  );
  return (
    <div className="syn-strip">
      <h4 className="syn-strip-heading">{strip.heading}</h4>
      <div role="group" aria-label={strip.ariaLabel}>
        <ol className="syn-strip-bar">{strip.segments.map(seg)}</ol>
      </div>
      {!strip.pending && <ul className="syn-legend">{strip.legend.map(dot)}</ul>}
    </div>
  );
}

function DisputeCard({ d }: { d: DisputeCardView }) {
  const [picked, setPicked] = useState(false);
  const findOpen = useFindOpen();
  const open = picked || findOpen;
  const bodyId = useId();
  const v = d.verdict;
  return (
    <article className="syn-dispute" data-dispute={d.n}>
      <div className="syn-dispute-top">
        <span className="syn-dispute-n">{d.n}</span>
        {d.type && <span className="syn-type-chip" data-type={d.type.raw}>{d.type.label}</span>}
        {d.about && <span className="syn-about">· {d.about}</span>}
        <span className="syn-dispute-verdict">
          {v.kind === 'camp' && v.camp
            ? <span className={`syn-verdict-chip ${campClass(v.camp.id)}`}>{v.camp.label} stronger</span>
            : <span className="syn-verdict-chip syn-verdict-none">{v.kind === 'none' ? 'No verdict' : 'Unresolved'}</span>}
        </span>
      </div>
      <h4 id={`syn-dispute-${d.n}`} tabIndex={-1} data-dispute-heading={d.n} className="syn-dispute-q"><Hl k={`${d.n}.point`} text={d.point} /></h4>
      <div className="syn-dispute-foot">
        {d.why && <p className="syn-why"><Hl k={`${d.n}.why`} text={d.why} /></p>}
        {d.positions.length > 0 && (
          <button type="button" className="btn btn-ghost syn-more" aria-expanded={open} aria-controls={bodyId} onClick={() => setPicked(o => !o)}>
            {open ? 'Hide both sides' : 'Read both sides'}
          </button>
        )}
      </div>
      {open && (
        <div id={bodyId} className="syn-positions">
          {d.positions.map((p, i) => (
            <div key={i} className="syn-position">
              <CampChip camp={p.camp} />
              <p><Hl k={`${d.n}.pos${i}`} text={p.stance} /></p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function OpenQuestions({ groups, debateId }: { groups: SynthesisView['openQuestionGroups']; debateId: string }) {
  const [checked, setChecked] = useState<Set<string>>(() => readCheckedQuestions(debateId));
  const toggle = useCallback((id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeCheckedQuestions(debateId, next);
      return next;
    });
  }, [debateId]);
  const list = (qs: { id: string; text: string }[]) => (
    <ul className="syn-questions">
      {qs.map(q => {
        const id = `synthesisV2.questions.${debateId}.${q.id}`;
        return (
          <li key={q.id} className="syn-question">
            <input id={id} type="checkbox" checked={checked.has(q.id)} onChange={() => toggle(q.id)} />
            <label htmlFor={id}><Hl k={q.id} text={q.text} /></label>
            <DebateThisQuestion text={q.text} />
          </li>
        );
      })}
    </ul>
  );
  if (groups.length === 1 && groups[0].theme === null) return list(groups[0].questions);
  return (
    <div className="syn-question-groups">
      {groups.map((g, i) => g.theme === null
        ? <div key={i} className="syn-question-ungrouped">{list(g.questions)}</div>
        : <fieldset key={i} className="syn-question-group"><legend>{g.theme}</legend>{list(g.questions)}</fieldset>)}
    </div>
  );
}

export type SectionKey = 'common-ground' | 'disputes' | 'strongest-arguments' | 'cruxes' | 'open-questions';

function SectionHead({ id, sectionKey, text, intro }: { id: string; sectionKey: SectionKey; text: string; intro: string }) {
  return (
    <>
      <h3 id={id} data-syn-heading={sectionKey} tabIndex={-1} className="syn-h">{text}</h3>
      <p className="syn-intro">{intro}</p>
    </>
  );
}

function ExportBriefButton({ onExportBrief }: { onExportBrief?: () => void }) {
  if (!onExportBrief) return null;
  return <button type="button" className="btn btn-primary syn-export" onClick={onExportBrief}>Export brief</button>;
}

function PanelHeader({ view, ids, collapsed, bodyId, onJump, onSkip, onToggle, onExportBrief }: {
  view: SynthesisView; ids: Record<SectionKey, string>; collapsed: boolean; bodyId: string;
  onJump: (k: SectionKey) => void; onSkip?: () => void; onToggle?: () => void; onExportBrief?: () => void;
}) {
  return (
    <header className="syn-header">
      <div className="syn-header-row">
        <h2 className="syn-heading">Debate synthesis</h2>
        <div className="syn-header-actions">
          <ExportBriefButton onExportBrief={onExportBrief} />
        {onToggle && (
          <button type="button" className="btn btn-ghost syn-collapse" aria-expanded={!collapsed} aria-controls={bodyId} onClick={onToggle}>
            {collapsed ? 'Expand synthesis ▾' : 'Collapse synthesis ▴'}
          </button>
        )}
        </div>
      </div>
      {(view.nav.length > 0 || onSkip) && (
        <nav className="syn-nav" aria-label="Synthesis sections">
          {onSkip && (
            <a href="#debate-transcript" className="syn-nav-link" onClick={e => { e.preventDefault(); onSkip(); }}>
              Skip to transcript
            </a>
          )}
          {!collapsed && view.nav.map(n => (
            <a key={n.key} href={`#${ids[n.key]}`} className="syn-nav-link"
              onClick={e => { e.preventDefault(); onJump(n.key); }}>
              {n.label} <span className="syn-nav-count">{n.count}</span>
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}

function BottomLineText({ view, collapsed }: { view: SynthesisView; collapsed: boolean }) {
  const [picked, setPicked] = useState(false);
  const findOpen = useFindOpen();
  const readMore = picked || findOpen;
  const readMoreId = useId();
  const bl = view.bottomLine;
  if (!bl.paragraph) return null;
  return (
    <p className="syn-bottom">
      <Hl k="bl" text={bl.paragraph} />
      {!collapsed && bl.more && <span id={readMoreId} hidden={!readMore}> <Hl k="blmore" text={bl.more} /></span>}
      {!collapsed && bl.more && (
        <>
          {' '}
          <button type="button" className="btn btn-ghost syn-inline" aria-expanded={readMore} aria-controls={readMoreId} onClick={() => setPicked(r => !r)}>
            {readMore ? 'Read less' : 'Read more'}
          </button>
        </>
      )}
    </p>
  );
}

function BottomLineCard({ view, collapsed }: { view: SynthesisView; collapsed: boolean }) {
  const bl = view.bottomLine;
  return (
    <section className="syn-card" aria-label="Bottom line">
      <h3 className="syn-h">Bottom line</h3>
      <BottomLineText view={view} collapsed={collapsed} />
      {!collapsed && bl.decisiveCrux && <p className="syn-crux-line"><strong>Decisive crux.</strong> <Hl k="crux" text={bl.decisiveCrux} /></p>}
      {!collapsed && view.strip && <OutcomeStrip strip={view.strip} />}
      {!collapsed && bl.settle.length > 0 && (
        <div className="syn-settle">
          <h4 className="syn-settle-h">What it takes to settle them</h4>
          <ul>
            {bl.settle.map(r => (
              <li key={r.key}><span className="syn-type-chip">{r.type}</span> <span aria-hidden="true">→</span> {r.action} <span className="syn-settle-ids">(<WithDisputeRefs text={r.ids.join(', ')} />)</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function NextMoves({ moves }: { moves: SynthesisView['nextMoves'] }) {
  return (
    <section aria-label="Next moves">
      <h3 className="syn-h">Next moves</h3>
      <div className="syn-moves">
        {moves.map((m, i) => (
          <div key={m.kind} className="syn-move">
            <div className="syn-move-title"><Hl k={`move${i}.title`} text={m.title} /></div>
            <span className="syn-move-chip"><WithDisputeRefs text={m.chip} /></span>
            {m.context && <p className="syn-move-ctx"><Hl k={`move${i}.ctx`} text={m.context} /></p>}
            {m.body && <p><Hl k={`move${i}.body`} text={m.body} /></p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function CommonGround({ agreements, id }: { agreements: SynthesisView['agreements']; id: string }) {
  return (
    <section aria-labelledby={id}>
      <SectionHead id={id} sectionKey="common-ground" text="Common ground" intro="Points all camps accept." />
      {agreements.items.length > 0 ? (
        <Capped
          items={agreements.items}
          listClass="syn-agree"
          showAll={n => `Show all ${n} points`}
          render={(t, i) => (
            <li key={i} className="syn-agree-item"><Check size={16} aria-hidden="true" className="syn-check" /><span><Hl k={`ag${i}`} text={t} /></span></li>
          )}
        />
      ) : (
        <p className="syn-unreadable">Agreements couldn&apos;t be read for this synthesis.</p>
      )}
    </section>
  );
}

/** t/829 (spec §13.7): "If yes / If no" behind a Details button; only the lines that exist, and no
 *  button when neither does. A find match inside opens it. */
function CruxDetails({ crux, open, onToggle }: { crux: SynthesisView['cruxes'][number]; open: boolean; onToggle: () => void }) {
  const findOpen = useFindOpen();
  const detailsId = useId();
  if (!crux.ifYes && !crux.ifNo) return null;
  const shown = open || findOpen;
  return (
    <>
      <button type="button" className="btn btn-ghost btn-xs syn-crux-details-btn" aria-expanded={shown} aria-controls={detailsId} onClick={onToggle}>
        {shown ? 'Details ▴' : 'Details ▸'}
      </button>
      {shown && (
        <div id={detailsId} className="syn-crux-details">
          {crux.ifYes && <p><strong>If yes:</strong> <Hl k={`${crux.n}.yes`} text={crux.ifYes} /></p>}
          {crux.ifNo && <p><strong>If no:</strong> <Hl k={`${crux.n}.no`} text={crux.ifNo} /></p>}
        </div>
      )}
    </>
  );
}

function Cruxes({ cruxes, id }: { cruxes: SynthesisView['cruxes']; id: string }) {
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  const toggle = (n: string) => setOpenDetails(prev => {
    const next = new Set(prev);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });
  return (
    <section aria-labelledby={id}>
      <SectionHead id={id} sectionKey="cruxes" text="Cruxes" intro="Answer one of these and a position should move." />
      <Capped
        items={cruxes}
        tag="div"
        listClass="syn-cruxes"
        showMore={n => `Show ${n} more cruxes`}
        onShowFewer={() => setOpenDetails(new Set())}
        render={c => (
          <div key={c.n} className="syn-crux">
            <span className="syn-crux-n">{c.n}</span>
            {c.typeLabel && <span className="syn-type-chip" data-type={c.rawType ?? undefined}>{c.typeLabel}</span>}
            <p><Hl k={c.n} text={c.question} /></p>
            <div className="syn-crux-actions">
              <CruxDetails crux={c} open={openDetails.has(c.n)} onToggle={() => toggle(c.n)} />
              <DebateThisQuestion text={c.question} />
            </div>
          </div>
        )}
      />
    </section>
  );
}

/** t/825 (spec §13.3): "Show in transcript" scrolls to the statement and flashes it. */
function showInTranscript(entryId: string): void {
  const el = document.getElementById(`debate-entry-${entryId}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  el.classList.add('syn-flash');
  window.setTimeout(() => el.classList.remove('syn-flash'), 2000);
}

function argumentLine(a: StrongestArgumentsCamp['items'][number]): string | null {
  const parts = [a.supportedBy > 0 && `Supported by ${a.supportedBy}`, a.challengedBy > 0 && `Challenged by ${a.challengedBy}`].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');
  return a.engages > 0 ? `Engages ${a.engages} other argument${a.engages === 1 ? '' : 's'}` : null;
}

function StrongestArguments({ camps, id }: { camps: SynthesisView['strongestArguments']; id: string }) {
  return (
    <section aria-labelledby={id}>
      <SectionHead id={id} sectionKey="strongest-arguments" text="Strongest arguments" intro="The best-engaged arguments from each camp. Strength is the model's estimate." />
      <div className="syn-arg-camps">
        {camps.map(c => (
          <section key={c.camp.id} className="syn-arg-camp" aria-label={`Strongest arguments: ${c.camp.label}`}>
            <CampChip camp={c.camp} />
            {c.items.length === 0 ? (
              <p className="syn-arg-none">No argument from {c.camp.label} was supported or challenged by another.</p>
            ) : (
              <ol className="syn-arg-list">
                {c.items.map(a => {
                  const line = argumentLine(a);
                  return (
                    <li key={a.id} className="syn-arg">
                      <p><Hl k={`arg.${c.camp.id}.${a.id}`} text={a.text} /></p>
                      {line && <p className="syn-arg-meta">{line}</p>}
                      <a href={`#debate-entry-${a.sourceEntryId}`} className="syn-arg-link"
                        aria-label={`Show in transcript: ${a.text.split(/\s+/).slice(0, 6).join(' ')}`}
                        onClick={e => { e.preventDefault(); showInTranscript(a.sourceEntryId); }}>
                        Show in transcript
                      </a>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}

function ExpandedSections({ view, ids, debateId, onExportBrief }: { view: SynthesisView; ids: Record<SectionKey, string>; debateId: string; onExportBrief?: () => void }) {
  const hasAgreements = view.agreements.items.length > 0 || view.agreements.unreadable;
  return (
    <>
      {view.nextMoves.length > 0 && <NextMoves moves={view.nextMoves} />}
      {hasAgreements && <CommonGround agreements={view.agreements} id={ids['common-ground']} />}
      {view.disputes.length > 0 && (
        <section aria-labelledby={ids.disputes}>
          <SectionHead id={ids.disputes} sectionKey="disputes" text="Disputes" intro={'Each dispute once, with the model’s verdict where it gave one.'} />
          <div className="syn-disputes">{view.disputes.map(d => <DisputeCard key={d.n} d={d} />)}</div>
        </section>
      )}
      {view.strongestArguments.length > 0 && <StrongestArguments camps={view.strongestArguments} id={ids['strongest-arguments']} />}
      {view.cruxes.length > 0 && <Cruxes cruxes={view.cruxes} id={ids.cruxes} />}
      {view.openQuestions.length > 0 && (
        <section aria-labelledby={ids['open-questions']}>
          <SectionHead id={ids['open-questions']} sectionKey="open-questions" text="Open questions" intro="Nobody answered these. Expect reviewers to ask." />
          <OpenQuestions groups={view.openQuestionGroups} debateId={debateId} />
        </section>
      )}
      <footer className="syn-footer">
        <span>Synthesis of the full debate transcript.</span>
        <ExportBriefButton onExportBrief={onExportBrief} />
      </footer>
    </>
  );
}

export interface SynthesisPanelViewProps {
  view: SynthesisView;
  debateId: string;
  find?: PanelFind | null;
  /** When omitted the panel has no collapse button (always expanded). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Moves focus to the first transcript entry; adds the "Skip to transcript" link. */
  onSkip?: () => void;
  /** Exports the debate's Markdown brief; "Export brief" is hidden when there is no handler. */
  onExportBrief?: () => void;
  /** Opens the New Debate dialog on a question; the "Debate this question" buttons are hidden without it. */
  onDebateTopic?: (topic: string) => void;
}

export function SynthesisPanelView({ view, debateId, find = null, collapsed = false, onToggleCollapsed, onSkip, onExportBrief, onDebateTopic }: SynthesisPanelViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const ids: Record<SectionKey, string> = {
    'common-ground': useId(), disputes: useId(), 'strongest-arguments': useId(), cruxes: useId(), 'open-questions': useId(),
  };
  // A find in progress shows everything, so every counted match has an element.
  const isCollapsed = collapsed && !find?.query;

  const jump = useCallback((key: SectionKey) => {
    const h = rootRef.current?.querySelector<HTMLElement>(`[data-syn-heading="${key}"]`);
    if (!h) return;
    h.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    h.focus({ preventScroll: true });
  }, []);

  const disputeLinks = useMemo<DisputeLinks>(() => ({
    points: new Map(view.disputes.map(d => [d.n, d.point])),
    jump: (n: string) => {
      const h = rootRef.current?.querySelector<HTMLElement>(`[data-dispute-heading="${n}"]`);
      if (!h) return;
      h.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      h.focus({ preventScroll: true });
    },
  }), [view.disputes]);
  const hasBottomLine = !!(view.bottomLine.paragraph || view.strip || view.bottomLine.settle.length);
  return (
    <FindContext.Provider value={find}>
     <DisputeLinksContext.Provider value={disputeLinks}>
     <DebateTopicContext.Provider value={onDebateTopic ?? null}>
      <div className="syn-panel" ref={rootRef} data-testid="synthesis-v2" data-collapsed={isCollapsed || undefined}>
        <PanelHeader view={view} ids={ids} collapsed={isCollapsed} bodyId={bodyId} onJump={jump} onSkip={onSkip} onToggle={onToggleCollapsed} onExportBrief={onExportBrief} />
        <div id={bodyId} className="syn-body">
          {hasBottomLine && <BottomLineCard view={view} collapsed={isCollapsed} />}
          {!isCollapsed && <ExpandedSections view={view} ids={ids} debateId={debateId} onExportBrief={onExportBrief} />}
        </div>
      </div>
     </DebateTopicContext.Provider>
     </DisputeLinksContext.Provider>
    </FindContext.Provider>
  );
}
