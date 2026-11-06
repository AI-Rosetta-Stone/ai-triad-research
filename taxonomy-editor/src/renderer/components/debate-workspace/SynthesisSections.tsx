// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Rendering for the debate's concluding (Synthesis) statement, per the Design spec
// (t/4914, docs/ux/debate-synthesis.md): a scannable single view — a jump-link
// overview strip, every section labelled with a count, top-3 + "Show N more" per
// list section, camp chips in place of a trailing camp-name parenthetical, and one
// unified bullet/disclosure style. Split out of StatementCard.tsx to stay under its
// line-count ceiling.

import { useState, useCallback, useMemo, useRef, useId } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkColorizePov } from '../../utils/colorizePovPlugin';
import { remarkLinkifyRefs } from '../shared/refLinkifyPlugin';
import { fixMarkdownLinks } from './utils';
import './StatementCard.css';

/** Same remark pipeline as StatementCard.tsx's DEBATE_REMARK_PLUGINS (t/1776) — kept
 * identical here rather than imported, to avoid a circular import with StatementCard.tsx. */
const DEBATE_REMARK_PLUGINS = [remarkGfm, remarkColorizePov, remarkLinkifyRefs];

const FULLY_COLLAPSED_SECTIONS = new Set(['Argument Map']);
/** Sections that show only the top 3 items by default, with "Show N more" (spec §4). */
const LIST_SECTIONS = new Set(['Areas of Agreement', 'Areas of Disagreement', 'Cruxes']);
/** LIST_SECTIONS plus Resolution Analysis: all get the unified bullet style + chips + a
 * per-item "details" disclosure (spec §6), but only LIST_SECTIONS get the top-3 cap. */
const BULLETED_SECTIONS = new Set([...LIST_SECTIONS, 'Resolution Analysis']);

const SECTION_SHORT_NAME: Record<string, string> = {
  'Areas of Agreement': 'Agreement',
  'Areas of Disagreement': 'Disagreement',
  'Cruxes': 'Cruxes',
  'Resolution Analysis': 'Resolution',
  'Argument Map': 'Argument map',
};

interface ParsedSection { heading: string; body: string }

export function splitByHeadings(content: string): ParsedSection[] {
  const parts = content.split(/\n(?=## )/);
  const sections: ParsedSection[] = [];
  for (const part of parts) {
    const match = part.match(/^## (.+)\n([\s\S]*)$/);
    if (match) {
      sections.push({ heading: match[1].trim(), body: match[2].trim() });
    } else if (part.trim()) {
      // t/4914 spec §4: the model's markdown omits the heading on the leading block,
      // but it's always the agreement section — don't guess from content.
      sections.push({ heading: 'Areas of Agreement', body: part.trim() });
    }
  }
  return sections;
}

export function parseBullets(body: string): { top: string; subs: string[] }[] {
  const lines = body.split('\n');
  const groups: { top: string; subs: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith('- ')) {
      groups.push({ top: line, subs: [] });
    } else if (line.startsWith('  - ') && groups.length > 0) {
      groups[groups.length - 1].subs.push(line);
    } else if (line.startsWith('  ') && groups.length > 0 && groups[groups.length - 1].subs.length > 0) {
      groups[groups.length - 1].subs[groups[groups.length - 1].subs.length - 1] += '\n' + line;
    }
  }
  return groups;
}

const CAMP_NAMES = ['Accelerationist', 'Safetyist', 'Skeptic'] as const;
type CampName = typeof CAMP_NAMES[number];

/**
 * Spec §5: a bullet whose text ends with a parenthetical made up ONLY of camp names
 * (any order/subset) has that parenthetical stripped, to be re-rendered as chips.
 * Any other trailing parenthetical (including an unrecognized name) is left as text.
 */
export function extractCampChips(text: string): { text: string; camps: CampName[] } {
  const match = text.match(/\s*\(\s*([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s*\)\s*$/);
  if (!match) return { text, camps: [] };
  const named = match[1].split(',').map(s => s.trim());
  if (named.length === 0 || !named.every(n => (CAMP_NAMES as readonly string[]).includes(n))) {
    return { text, camps: [] };
  }
  const camps = CAMP_NAMES.filter(c => named.includes(c));
  return { text: text.slice(0, text.length - match[0].length), camps };
}

function CampChipGroup({ camps }: { camps: CampName[] }) {
  if (camps.length === 0) return null;
  if (camps.length === 3) {
    return (
      <span className="concluding-camp-chips" role="group" aria-label="Held by all three camps">
        <span className="concluding-camp-chip concluding-camp-chip-all">All three</span>
      </span>
    );
  }
  const label = camps.length === 1
    ? `Held by ${camps[0]}`
    : `Held by ${camps.slice(0, -1).join(', ')} and ${camps[camps.length - 1]}`;
  return (
    <span className="concluding-camp-chips" role="group" aria-label={label}>
      {camps.map(c => (
        <span key={c} className={`concluding-camp-chip concluding-camp-chip-${c.toLowerCase()}`}>
          {c}
        </span>
      ))}
    </span>
  );
}

/** One bullet item: unified plain-bullet style, camp chips, and (if it has
 * sub-points) a trailing "details" disclosure — never the whole row clickable
 * (spec §6). */
function SynthesisBulletItem({ top, subs, mdComponents }: { top: string; subs: string[]; mdComponents: object }) {
  const [expanded, setExpanded] = useState(false);
  const subsId = useId();
  const { text, camps } = useMemo(() => extractCampChips(top.replace(/^-\s*/, '')), [top]);
  const hasSubs = subs.length > 0;
  return (
    <li className="concluding-bullet-item">
      <span className="concluding-bullet-text">
        <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={mdComponents}>{fixMarkdownLinks(text)}</Markdown>
      </span>
      <CampChipGroup camps={camps} />
      {hasSubs && (
        <button
          type="button"
          className="btn btn-ghost btn-xs concluding-details-toggle"
          aria-expanded={expanded}
          aria-controls={subsId}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'details ▴' : 'details ▸'}
        </button>
      )}
      {hasSubs && expanded && (
        <div id={subsId} className="concluding-bullet-subs">
          <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={mdComponents}>{fixMarkdownLinks(subs.join('\n'))}</Markdown>
        </div>
      )}
    </li>
  );
}

/** A heading + bulleted list section. `capped` sections (the three LIST_SECTIONS)
 * show only the top 3 items by default, with "Show N more" (spec §4). */
function SynthesisListSection({ heading, body, capped, mdComponents }: { heading: string; body: string; capped: boolean; mdComponents: object }) {
  const bullets = useMemo(() => parseBullets(body), [body]);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const remaining = bullets.length - 3;
  const visibleCount = capped && !expanded ? Math.min(3, bullets.length) : bullets.length;
  return (
    <div data-section={heading} className="concluding-list-section">
      <h2 className="concluding-section-heading">
        {heading}
        <span className="concluding-section-count"> ({bullets.length})</span>
      </h2>
      <ul id={listId} className="concluding-bullet-list">
        {bullets.slice(0, visibleCount).map((b, j) => (
          <SynthesisBulletItem key={j} top={b.top} subs={b.subs} mdComponents={mdComponents} />
        ))}
      </ul>
      {capped && remaining > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-xs concluding-show-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Show fewer ▴' : `Show ${remaining} more ▾`}
        </button>
      )}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Spec §3: a jump-link strip built from the sections actually present, with
 * item counts on the three LIST_SECTIONS. Clicking scrolls the section into
 * view and expands it if it was collapsed (the Argument Map). */
function SynthesisOverviewStrip({ sections, onJump }: { sections: { heading: string; count?: number }[]; onJump: (heading: string) => void }) {
  if (sections.length === 0) return null;
  return (
    <nav className="concluding-overview-strip" aria-label="Synthesis sections">
      {sections.map(s => (
        <button key={s.heading} type="button" className="concluding-overview-link" onClick={() => onJump(s.heading)}>
          {SECTION_SHORT_NAME[s.heading] ?? s.heading}
          {s.count !== undefined && <span className="concluding-overview-count"> {s.count}</span>}
        </button>
      ))}
    </nav>
  );
}

export function ConcludingSections({ content, mdComponents }: { content: string; mdComponents: object }) {
  const sections = splitByHeadings(content);
  const containerRef = useRef<HTMLDivElement>(null);

  const stripSections = useMemo(() => sections.map(s => ({
    heading: s.heading,
    count: LIST_SECTIONS.has(s.heading) ? parseBullets(s.body).length : undefined,
  })), [sections]);

  const handleJump = useCallback((heading: string) => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-section="${heading}"]`);
    if (!el) return;
    const details = el.closest('details');
    if (details && !details.open) details.open = true;
    el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  return (
    <div className="concluding-sections" ref={containerRef}>
      <SynthesisOverviewStrip sections={stripSections} onJump={handleJump} />
      {sections.map((section, i) => {
        if (FULLY_COLLAPSED_SECTIONS.has(section.heading)) {
          return (
            <details key={i} data-section={section.heading} className="concluding-collapsed-section">
              <summary className="concluding-section-summary"><h2>{section.heading}</h2></summary>
              <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={mdComponents}>{fixMarkdownLinks(section.body)}</Markdown>
            </details>
          );
        }
        if (BULLETED_SECTIONS.has(section.heading)) {
          return (
            <SynthesisListSection
              key={i}
              heading={section.heading}
              body={section.body}
              capped={LIST_SECTIONS.has(section.heading)}
              mdComponents={mdComponents}
            />
          );
        }
        return (
          <div key={i} data-section={section.heading}>
            <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={mdComponents}>{fixMarkdownLinks(`## ${section.heading}\n${section.body}`)}</Markdown>
          </div>
        );
      })}
    </div>
  );
}
