// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809 (spec docs/ux/debate-synthesis-v2.md, t/807): the synthesis "sponsor briefing" panel.
// Presentational only: every join, label and rule is in synthesisView.ts. Behind the short-lived
// `synthesisV2` switch (default OFF; `localStorage.synthesisV2 = '1'`), removed one train after
// the human signs off. Share, Export brief, Run another round and Debate this are not rendered:
// nothing in the card can call them (listed in the PR).

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import {
  buildSynthesisView, type BuildSynthesisInput, type CampRef, type DisputeCardView,
  type StripLegendItem, type StripSegment, type SynthesisView,
} from './synthesisView';
import { useDebateStore } from '../../hooks/useDebateStore';
import type { TranscriptEntry } from '../../types/debate';
import { ConcludingSections } from './SynthesisSections';
import './SynthesisPanel.css';

const SWITCH_KEY = 'synthesisV2';

/** The short-lived switch: `localStorage.synthesisV2 = '1'` turns the v2 panel on. */
export function isSynthesisV2On(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SWITCH_KEY) === '1';
  } catch (err) {
    // A blocked storage means the switch is off; the reader just sees the existing panel.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'SynthesisPanel', level: 'error',
      message: 'synthesisV2 switch unreadable; panel stays off',
      error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack },
    });
    return false;
  }
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

/** First 3 items, then a button. `noun` completes "Show N more …". */
function Capped<T>({ items, render, listClass, showAll, showMore, tag = 'ul' }: {
  items: T[];
  render: (item: T, i: number) => React.ReactNode;
  listClass: string;
  /** Button text when collapsed: "Show all N points" (gets the total). */
  showAll?: (total: number) => string;
  /** Button text when collapsed: "Show N more cruxes" (gets the hidden count). */
  showMore?: (hidden: number) => string;
  tag?: 'ul' | 'div';
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const hidden = items.length - 3;
  const shown = open || hidden <= 0 ? items : items.slice(0, 3);
  const Tag = tag;
  return (
    <>
      <Tag id={listId} className={listClass}>{shown.map(render)}</Tag>
      {hidden > 0 && (
        <button type="button" className="btn btn-ghost syn-more" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(o => !o)}>
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
    >{s.n}</li>
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
      <ol className="syn-strip-bar" role="img" aria-label={strip.ariaLabel}>{strip.segments.map(seg)}</ol>
      {!strip.pending && <ul className="syn-legend">{strip.legend.map(dot)}</ul>}
    </div>
  );
}

function DisputeCard({ d }: { d: DisputeCardView }) {
  const [open, setOpen] = useState(false);
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
      <h4 className="syn-dispute-q">{d.point}</h4>
      <div className="syn-dispute-foot">
        {d.why && <p className="syn-why">{d.why}</p>}
        {d.positions.length > 0 && (
          <button type="button" className="btn btn-ghost syn-more" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide both sides' : 'Read both sides'}
          </button>
        )}
      </div>
      {open && (
        <div id={bodyId} className="syn-positions">
          {d.positions.map((p, i) => (
            <div key={i} className="syn-position">
              <CampChip camp={p.camp} />
              <p>{p.stance}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function OpenQuestions({ items, debateId }: { items: SynthesisView['openQuestions']; debateId: string }) {
  const storeKey = `synthesisV2.questions.${debateId}`;
  const [checked, setChecked] = useState<Set<string>>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storeKey) : null;
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'SynthesisPanel', level: 'error',
        message: 'open-question state unreadable; starting unchecked',
        error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack },
      });
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(storeKey, JSON.stringify([...next])); } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'SynthesisPanel', level: 'error',
          message: 'open-question state not saved',
          error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack },
        });
      }
      return next;
    });
  }, [storeKey]);
  return (
    <ul className="syn-questions">
      {items.map(q => {
        const id = `${storeKey}.${q.id}`;
        return (
          <li key={q.id} className="syn-question">
            <input id={id} type="checkbox" checked={checked.has(q.id)} onChange={() => toggle(q.id)} />
            <label htmlFor={id}>{q.text}</label>
          </li>
        );
      })}
    </ul>
  );
}

type SectionKey = 'common-ground' | 'disputes' | 'cruxes' | 'open-questions';

function SectionHead({ id, sectionKey, text, intro }: { id: string; sectionKey: SectionKey; text: string; intro: string }) {
  return (
    <>
      <h3 id={id} data-syn-heading={sectionKey} tabIndex={-1} className="syn-h">{text}</h3>
      <p className="syn-intro">{intro}</p>
    </>
  );
}

function PanelHeader({ view, ids, onJump }: { view: SynthesisView; ids: Record<SectionKey, string>; onJump: (k: SectionKey) => void }) {
  return (
    <header className="syn-header">
      <div className="syn-eyebrow">Debate synthesis</div>
      <h2 className="syn-title">{view.title}</h2>
      {view.debaters.length > 0 && (
        <p className="syn-debaters">
          {view.debaters.map((c, i) => (
            <span key={c.id}>{i > 0 && <span className="syn-vs"> vs </span>}<CampChip camp={c} /></span>
          ))}
        </p>
      )}
      {view.nav.length > 0 && (
        <nav className="syn-nav" aria-label="Synthesis sections">
          {view.nav.map(n => (
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

function BottomLineCard({ view }: { view: SynthesisView }) {
  const [readMore, setReadMore] = useState(false);
  const readMoreId = useId();
  const bl = view.bottomLine;
  return (
    <section className="syn-card" aria-label="Bottom line">
      <h3 className="syn-h">Bottom line</h3>
      {bl.paragraph && (
        <p className="syn-bottom">
          {bl.paragraph}
          {bl.more && <span id={readMoreId} hidden={!readMore}> {bl.more}</span>}
          {bl.more && (
            <>
              {' '}
              <button type="button" className="btn btn-ghost syn-inline" aria-expanded={readMore} aria-controls={readMoreId} onClick={() => setReadMore(r => !r)}>
                {readMore ? 'Read less' : 'Read more'}
              </button>
            </>
          )}
        </p>
      )}
      {bl.decisiveCrux && <p className="syn-crux-line"><strong>Decisive crux.</strong> {bl.decisiveCrux}</p>}
      {view.strip && <OutcomeStrip strip={view.strip} />}
      {bl.settle.length > 0 && (
        <div className="syn-settle">
          <h4 className="syn-settle-h">What it takes to settle them</h4>
          <ul>
            {bl.settle.map(r => (
              <li key={r.key}><span className="syn-type-chip">{r.type}</span> <span aria-hidden="true">→</span> {r.action} <span className="syn-settle-ids">({r.ids.join(', ')})</span></li>
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
        {moves.map(m => (
          <div key={m.kind} className="syn-move">
            <div className="syn-move-title">{m.title}</div>
            <span className="syn-move-chip">{m.chip}</span>
            {m.body && <p>{m.body}</p>}
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
            <li key={i} className="syn-agree-item"><Check size={16} aria-hidden="true" className="syn-check" /><span>{t}</span></li>
          )}
        />
      ) : (
        <p className="syn-unreadable">Agreements couldn&apos;t be read for this synthesis.</p>
      )}
    </section>
  );
}

function Cruxes({ cruxes, id }: { cruxes: SynthesisView['cruxes']; id: string }) {
  return (
    <section aria-labelledby={id}>
      <SectionHead id={id} sectionKey="cruxes" text="Cruxes" intro="Answer one of these and a position should move." />
      <Capped
        items={cruxes}
        tag="div"
        listClass="syn-cruxes"
        showMore={n => `Show ${n} more cruxes`}
        render={c => (
          <div key={c.n} className="syn-crux">
            <span className="syn-crux-n">{c.n}</span>
            {c.typeLabel && <span className="syn-type-chip" data-type={c.rawType ?? undefined}>{c.typeLabel}</span>}
            <p>{c.question}</p>
          </div>
        )}
      />
    </section>
  );
}

export function SynthesisPanelView({ view, debateId }: { view: SynthesisView; debateId: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ids: Record<SectionKey, string> = {
    'common-ground': useId(), disputes: useId(), cruxes: useId(), 'open-questions': useId(),
  };

  const jump = useCallback((key: SectionKey) => {
    const h = rootRef.current?.querySelector<HTMLElement>(`[data-syn-heading="${key}"]`);
    if (!h) return;
    h.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    h.focus({ preventScroll: true });
  }, []);

  const hasBottomLine = !!(view.bottomLine.paragraph || view.strip || view.bottomLine.settle.length);
  const hasAgreements = view.agreements.items.length > 0 || view.agreements.unreadable;
  return (
    <div className="syn-panel" ref={rootRef} data-testid="synthesis-v2">
      <PanelHeader view={view} ids={ids} onJump={jump} />
      {hasBottomLine && <BottomLineCard view={view} />}
      {view.nextMoves.length > 0 && <NextMoves moves={view.nextMoves} />}
      {hasAgreements && <CommonGround agreements={view.agreements} id={ids['common-ground']} />}
      {view.disputes.length > 0 && (
        <section aria-labelledby={ids.disputes}>
          <SectionHead id={ids.disputes} sectionKey="disputes" text="Disputes" intro={'Each dispute once, with the model’s verdict where it gave one.'} />
          <div className="syn-disputes">{view.disputes.map(d => <DisputeCard key={d.n} d={d} />)}</div>
        </section>
      )}
      {view.cruxes.length > 0 && <Cruxes cruxes={view.cruxes} id={ids.cruxes} />}
      {view.openQuestions.length > 0 && (
        <section aria-labelledby={ids['open-questions']}>
          <SectionHead id={ids['open-questions']} sectionKey="open-questions" text="Open questions" intro="Nobody answered these. Expect reviewers to ask." />
          <OpenQuestions items={view.openQuestions} debateId={debateId} />
        </section>
      )}
      <footer className="syn-footer">Synthesis of the full debate transcript.</footer>
    </div>
  );
}

/** Builds the view from the concluding entry's structured synthesis, then renders it. */
export function SynthesisPanel({ input, debateId }: { input: BuildSynthesisInput; debateId: string }) {
  const view = useMemo(() => buildSynthesisView(input), [input.synthesis, input.topic, input.pending, input.debaters.join('|')]);
  return <SynthesisPanelView view={view} debateId={debateId} />;
}

/** The concluding card's body: the v2 panel when the switch is on and the entry carries the
 *  structured synthesis, else the existing sections. */
export function ConcludingBody({ entry, content, mdComponents }: { entry: TranscriptEntry; content: string; mdComponents: object }) {
  const activeDebate = useDebateStore(s => s.activeDebate);
  const synthesis = (entry.metadata as Record<string, unknown> | undefined)?.synthesis;
  if (!synthesis || !isSynthesisV2On()) return <ConcludingSections content={content} mdComponents={mdComponents} />;
  return (
    <SynthesisPanel
      debateId={activeDebate?.id ?? 'unsaved'}
      input={{ synthesis, debaters: activeDebate?.active_povers ?? [], topic: activeDebate?.topic?.final }}
    />
  );
}
