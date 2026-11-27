// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * The synthesis brief as Markdown or plain text (t/810, spec docs/ux/debate-synthesis-v2.md §3, §9 child 3,
 * acceptance 7). Rendered from `buildSynthesisView`, the same builder the synthesis panel uses (t/809), so
 * the export cannot differ from the panel in its joins, labels or order.
 *
 * Sections, in the panel's order, each omitted when it has no items: the motion, bottom line (where it
 * landed, decisive crux, which camp made the stronger case per dispute, what settles each), next moves,
 * common ground, disputes (each once, with its verdict and the "(model's assessment)" label), cruxes, open
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

/** The brief as lines, from a ready SynthesisView. */
export function synthesisBriefLines(view: SynthesisView, options: BriefOptions = {}): string[] {
  const text = options.format === 'text';
  const level = Math.max(1, Math.min(6, options.level ?? 3));
  const out: string[] = [];
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  const heading = (t: string) => {
    blank();
    out.push(text ? t.toUpperCase() : `${'#'.repeat(level)} ${t}`);
    out.push('');
  };
  const bold = (t: string) => (text ? t : `**${t}**`);
  const italic = (t: string) => (text ? t : `*${t}*`);
  const bullet = (t: string) => out.push(text ? `  - ${t}` : `- ${t}`);
  const para = (t: string) => { blank(); out.push(t); out.push(''); };

  // 1. Header: the motion, the debaters, the section counts.
  para(`${bold('Motion:')} ${view.title}`);
  if (view.debaters.length > 0) out.push(`${bold('Debaters:')} ${view.debaters.map(c => c.label).join(' vs ')}`, '');
  if (view.nav.length > 0) out.push(view.nav.map(n => `${n.label} ${n.count}`).join(' · '), '');

  // 2. Bottom line.
  const bl = view.bottomLine;
  const hasBottom = bl.paragraph || bl.decisiveCrux || view.strip || bl.settle.length > 0;
  if (hasBottom) {
    heading('Bottom line');
    if (bl.paragraph) para([bl.paragraph, bl.more].filter(Boolean).join(' '));
    if (bl.decisiveCrux) para(italic(`Decisive crux: ${bl.decisiveCrux}`));
    if (view.strip) {
      para(bold(view.strip.heading));
      for (const d of view.disputes) bullet(`${d.n}: ${d.verdict.kind === 'camp' ? `${d.verdict.camp?.label} stronger` : d.verdict.kind === 'none' ? 'no verdict' : 'unresolved'}`);
      out.push('');
      out.push(view.strip.legend.map(l => `${l.label} ${l.count}`).join(' · '), '');
    }
    if (bl.settle.length > 0) {
      para(bold('What it takes to settle them'));
      for (const r of bl.settle) bullet(`${r.type} → ${r.action} (${r.ids.join(', ')})`);
      out.push('');
    }
  }

  // 3. Next moves.
  if (view.nextMoves.length > 0) {
    heading('Next moves');
    for (const m of view.nextMoves) {
      bullet(`${bold(m.title)} (${m.chip})${m.body ? `: ${m.body}` : ''}`);
      if (m.context) bullet(`${italic('The dispute in full:')} ${m.context}`);
    }
    out.push('');
  }

  // 4. Common ground.
  if (view.agreements.items.length > 0 || view.agreements.unreadable) {
    heading('Common ground');
    if (view.agreements.items.length === 0) para("Agreements couldn't be read for this synthesis.");
    else {
      para('Points all camps accept.');
      for (const a of view.agreements.items) bullet(a);
      out.push('');
    }
  }

  // 5. Disputes: each once, verdict on the same card.
  if (view.disputes.length > 0) {
    heading('Disputes');
    for (const d of view.disputes) {
      para(bold([d.n, d.type?.label, d.about].filter(Boolean).join(' · ')));
      out.push(d.point, '');
      out.push(`${bold('Verdict')}: ${verdictText(d)}${d.why ? `. ${d.why}` : ''}`, '');
      if (d.rationale) out.push(italic(d.rationale), '');
      if (d.whatWouldChange) out.push(`Would change if: ${d.whatWouldChange}`, '');
      for (const p of d.positions) bullet(`${bold(`${p.camp.label}:`)} ${p.stance}`);
      if (d.positions.length > 0) out.push('');
    }
  }

  // 6. Cruxes.
  if (view.cruxes.length > 0) {
    heading('Cruxes');
    para('Answer one of these and a position should move.');
    for (const c of view.cruxes) bullet(`${bold(c.n)}${c.typeLabel ? ` (${c.typeLabel})` : ''} ${c.question}`);
    out.push('');
  }

  // 7. Open questions, grouped by theme when the view says to.
  if (view.openQuestions.length > 0) {
    heading('Open questions');
    para('Nobody answered these. Expect reviewers to ask.');
    for (const g of view.openQuestionGroups) {
      if (g.theme) out.push(bold(g.theme), '');
      for (const q of g.questions) bullet(q.text);
      out.push('');
    }
  }

  // 8. Footer.
  para(italic('Synthesis of the full debate transcript.'));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Build the view from a stored synthesis and render it. */
export function synthesisBrief(
  synthesis: unknown,
  context: { debaters: readonly string[]; topic?: string },
  options: BriefOptions = {},
): string[] {
  return synthesisBriefLines(buildSynthesisView({ synthesis, debaters: context.debaters, topic: context.topic }), options);
}
