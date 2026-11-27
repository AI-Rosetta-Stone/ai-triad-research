// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * The synthesis brief as Markdown or plain text (t/810, spec docs/ux/debate-synthesis-v2.md §3, §9 child 3,
 * acceptance 7). Rendered from `buildSynthesisView`, the same builder the synthesis panel uses (t/809), so
 * the export cannot differ from the panel in its joins, labels or order.
 *
 * Sections, in the panel's order, each omitted when it has no items: the motion, bottom line (where it
 * landed, decisive crux, which camp made the stronger case per dispute, what settles each), next moves,
 * common ground, disputes (each once, with its verdict and the "(model's assessment)" label), strongest
 * arguments (t/827), cruxes, open
 * questions, footer. No raw tags: types, layers and criteria go through the view's label tables.
 */

import { buildSynthesisView, type SynthesisView } from './synthesisView.js';

export interface BriefOptions {
  /** Markdown heading depth for the brief's sections (the caller's own heading is one above). Default 3. */
  level?: number;
  /** 'markdown' (default) or 'text' (no markup, for the .txt export). */
  format?: 'markdown' | 'text';
}

export const BRIEF_ASSESSMENT = "(model's assessment)";

/** A structured synthesis has at least one list or paragraph the brief can show. */
export function hasStructuredSynthesis(synthesis: unknown): boolean {
  if (!synthesis || typeof synthesis !== 'object' || Array.isArray(synthesis)) return false;
  const s = synthesis as Record<string, unknown>;
  return ['areas_of_agreement', 'areas_of_disagreement', 'cruxes', 'unresolved_questions', 'preferences', 'topic_resolution']
    .some(k => s[k] !== undefined && s[k] !== null);
}

function verdictText(d: SynthesisView['disputes'][number]): string {
  const v = d.verdict;
  if (v.kind === 'camp') return `${v.camp?.label} stronger ${BRIEF_ASSESSMENT}`;
  if (v.kind === 'none') return 'No verdict';
  return v.raw ? `Unresolved ${BRIEF_ASSESSMENT}; the model wrote "${v.raw}"` : `Unresolved ${BRIEF_ASSESSMENT}`;
}

/** Line writer for one brief: Markdown or plain text, one place for every markup choice. */
interface Writer {
  out: string[];
  blank(): void;
  heading(t: string): void;
  bold(t: string): string;
  italic(t: string): string;
  bullet(t: string): void;
  sub(t: string): void;
  para(t: string): void;
  line(t: string): void;
  num(n: number, t: string): void;
}

function makeWriter(options: BriefOptions): Writer {
  const text = options.format === 'text';
  const level = Math.max(1, Math.min(6, options.level ?? 3));
  const out: string[] = [];
  const w: Writer = {
    out,
    blank: () => { if (out.length && out[out.length - 1] !== '') out.push(''); },
    heading: (t) => { w.blank(); out.push(text ? t.toUpperCase() : `${'#'.repeat(level)} ${t}`, ''); },
    bold: (t) => (text ? t : `**${t}**`),
    italic: (t) => (text ? t : `*${t}*`),
    bullet: (t) => { out.push(text ? `  - ${t}` : `- ${t}`); },
    sub: (t) => { out.push(text ? `      - ${t}` : `  - ${t}`); },
    para: (t) => { w.blank(); out.push(t, ''); },
    line: (t) => { out.push(t, ''); },
    num: (n, t) => { out.push(text ? `  ${n}. ${t}` : `${n}. ${t}`); },
  };
  return w;
}

type Dispute = SynthesisView['disputes'][number];

const outcomeShort = (d: Dispute): string =>
  d.verdict.kind === 'camp' ? `${d.verdict.camp?.label} stronger` : d.verdict.kind === 'none' ? 'no verdict' : 'unresolved';

/** 1. The motion, the debaters, the section counts. */
function writeHeader(w: Writer, view: SynthesisView): void {
  w.para(`${w.bold('Motion:')} ${view.title}`);
  if (view.debaters.length > 0) w.line(`${w.bold('Debaters:')} ${view.debaters.map(c => c.label).join(' vs ')}`);
  if (view.nav.length > 0) w.line(view.nav.map(n => `${n.label} ${n.count}`).join(' · '));
}

/** 2. Where it landed, the decisive crux, the stronger case per dispute, what settles each. */
function writeBottomLine(w: Writer, view: SynthesisView): void {
  const bl = view.bottomLine;
  if (!(bl.paragraph || bl.decisiveCrux || view.strip || bl.settle.length > 0)) return;
  w.heading('Bottom line');
  if (bl.paragraph) w.para([bl.paragraph, bl.more].filter(Boolean).join(' '));
  if (bl.decisiveCrux) w.para(w.italic(`Decisive crux: ${bl.decisiveCrux}`));
  if (view.strip) {
    w.para(w.bold(view.strip.heading));
    for (const d of view.disputes) w.bullet(`${d.n}: ${outcomeShort(d)}`);
    w.blank();
    w.line(view.strip.legend.map(l => `${l.label} ${l.count}`).join(' · '));
  }
  if (bl.settle.length > 0) {
    w.para(w.bold('What it takes to settle them'));
    for (const r of bl.settle) w.bullet(`${r.type} → ${r.action} (${r.ids.join(', ')})`);
    w.blank();
  }
}

/** 3. Next moves. */
function writeNextMoves(w: Writer, view: SynthesisView): void {
  if (view.nextMoves.length === 0) return;
  w.heading('Next moves');
  for (const m of view.nextMoves) {
    w.bullet(`${w.bold(m.title)} (${m.chip})${m.body ? `: ${m.body}` : ''}`);
    if (m.context) w.sub(`${w.italic('The dispute in full:')} ${m.context}`);
  }
  w.blank();
}

/** 4. Common ground. */
function writeCommonGround(w: Writer, view: SynthesisView): void {
  const { items, unreadable } = view.agreements;
  if (items.length === 0 && !unreadable) return;
  w.heading('Common ground');
  if (items.length === 0) { w.para("Agreements couldn't be read for this synthesis."); return; }
  w.para('Points all camps accept.');
  for (const a of items) w.bullet(a);
  w.blank();
}

/** 5. Disputes: each once, with its verdict on the same entry. */
function writeDisputes(w: Writer, view: SynthesisView): void {
  if (view.disputes.length === 0) return;
  w.heading('Disputes');
  for (const d of view.disputes) {
    w.para(w.bold([d.n, d.type?.label, d.about].filter(Boolean).join(' · ')));
    w.line(d.point);
    w.line(`${w.bold('Verdict')}: ${verdictText(d)}${d.why ? `. ${d.why}` : ''}`);
    if (d.rationale) w.line(w.italic(d.rationale));
    if (d.whatWouldChange) w.line(`Would change if: ${d.whatWouldChange}`);
    for (const p of d.positions) w.bullet(`${w.bold(`${p.camp.label}:`)} ${p.stance}`);
    if (d.positions.length > 0) w.blank();
  }
}

/** 5b. Strongest arguments (spec §13.3, t/827): each camp's best-engaged arguments, after Disputes. No strength number. */
function writeStrongestArguments(w: Writer, view: SynthesisView): void {
  if (view.strongestArguments.length === 0) return;
  w.heading('Strongest arguments');
  w.para("The best-engaged arguments from each camp. Strength is the model's estimate.");
  for (const c of view.strongestArguments) {
    w.line(w.bold(c.camp.label));
    if (c.items.length === 0) { w.line(`No argument from ${c.camp.label} was supported or challenged by another.`); continue; }
    c.items.forEach((a, i) => {
      const incoming = [a.supportedBy > 0 ? `Supported by ${a.supportedBy}` : '', a.challengedBy > 0 ? `Challenged by ${a.challengedBy}` : ''].filter(Boolean);
      // Engaged only as a source: say so, so the argument doesn't look unengaged (Design, t/827)
      const parts = incoming.length === 0 && a.engages > 0 ? [`Engages ${a.engages} other argument${a.engages === 1 ? '' : 's'}`] : incoming;
      w.num(i + 1, parts.length > 0 ? `${a.text} (${parts.join(' · ')})` : a.text);
    });
    w.blank();
  }
}

/** 6. Cruxes. */
function writeCruxes(w: Writer, view: SynthesisView): void {
  if (view.cruxes.length === 0) return;
  w.heading('Cruxes');
  w.para('Answer one of these and a position should move.');
  for (const c of view.cruxes) {
    w.bullet(`${w.bold(c.n)}${c.typeLabel ? ` (${c.typeLabel})` : ''} ${c.question}`);
    if (c.ifYes) w.sub(`${w.bold('If yes:')} ${c.ifYes}`);
    if (c.ifNo) w.sub(`${w.bold('If no:')} ${c.ifNo}`);
  }
  w.blank();
}

/** 7. Open questions, grouped by theme when the view says to. */
function writeOpenQuestions(w: Writer, view: SynthesisView): void {
  if (view.openQuestions.length === 0) return;
  w.heading('Open questions');
  w.para('Nobody answered these. Expect reviewers to ask.');
  for (const g of view.openQuestionGroups) {
    if (g.theme) w.line(w.bold(g.theme));
    for (const q of g.questions) w.bullet(q.text);
    w.blank();
  }
}

/** The brief as lines, from a ready SynthesisView. */
export function synthesisBriefLines(view: SynthesisView, options: BriefOptions = {}): string[] {
  const w = makeWriter(options);
  writeHeader(w, view);
  writeBottomLine(w, view);
  writeNextMoves(w, view);
  writeCommonGround(w, view);
  writeDisputes(w, view);
  writeStrongestArguments(w, view);
  writeCruxes(w, view);
  writeOpenQuestions(w, view);
  w.para(w.italic('Synthesis of the full debate transcript.'));
  while (w.out.length && w.out[w.out.length - 1] === '') w.out.pop();
  return w.out;
}

/** Build the view from a stored synthesis and render it. */
export function synthesisBrief(
  synthesis: unknown,
  context: { debaters: readonly string[]; topic?: string; argumentNetwork?: { nodes?: unknown; edges?: unknown } | null },
  options: BriefOptions = {},
): string[] {
  return synthesisBriefLines(buildSynthesisView({ synthesis, debaters: context.debaters, topic: context.topic, argumentNetwork: context.argumentNetwork }), options);
}
