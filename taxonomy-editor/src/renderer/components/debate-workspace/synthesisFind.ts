// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809 (spec §12): in-debate find reaches the synthesis panel text. The panel sits above the
// transcript, so its matches come first. `synthesisFindTexts` lists every highlightable string in
// the order the panel renders it (keyed, so the panel and the counter cannot drift); while a find
// is active the panel renders fully expanded so every counted match has an element.

import { countOccurrences } from './utils';
import type { SynthesisView } from '@lib/debate/synthesisView';

/** Keyed text in render order. Keys are what the panel passes to its highlighter. */
export function synthesisFindTexts(view: SynthesisView): [string, string][] {
  const out: [string, string][] = [];
  const bl = view.bottomLine;
  if (bl.paragraph) out.push(['bl', bl.paragraph]);
  if (bl.more) out.push(['blmore', bl.more]);
  if (bl.decisiveCrux) out.push(['crux', bl.decisiveCrux]);
  view.nextMoves.forEach((m, i) => {
    out.push([`move${i}.title`, m.title]);
    if (m.context) out.push([`move${i}.ctx`, m.context]);
    if (m.body) out.push([`move${i}.body`, m.body]);
  });
  view.agreements.items.forEach((t, i) => out.push([`ag${i}`, t]));
  for (const d of view.disputes) {
    out.push([`${d.n}.point`, d.point]);
    if (d.why) out.push([`${d.n}.why`, d.why]);
    d.positions.forEach((p, i) => out.push([`${d.n}.pos${i}`, p.stance]));
  }
  for (const camp of view.strongestArguments) for (const a of camp.items) out.push([`arg.${camp.camp.id}.${a.id}`, a.text]);
  for (const c of view.cruxes) {
    out.push([c.n, c.question]);
    if (c.ifYes) out.push([`${c.n}.yes`, c.ifYes]);
    if (c.ifNo) out.push([`${c.n}.no`, c.ifNo]);
  }
  // Render order: themed groups can reorder the questions.
  view.openQuestionGroups.forEach(g => g.questions.forEach(q => out.push([q.id, q.text])));
  return out;
}

export function synthesisFindOffsets(view: SynthesisView, query: string): { total: number; offsets: Map<string, number> } {
  const offsets = new Map<string, number>();
  let total = 0;
  if (!query) return { total, offsets };
  for (const [key, text] of synthesisFindTexts(view)) {
    const n = countOccurrences(text, query);
    if (n > 0) { offsets.set(key, total); total += n; }
  }
  return { total, offsets };
}
