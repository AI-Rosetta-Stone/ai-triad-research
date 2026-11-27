// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809 (spec docs/ux/debate-synthesis-v2.md, t/807): the pure view-model for the synthesis
// "sponsor briefing" panel. Every join, label translation and rule lives here so the components
// stay presentational. Input is `entry.metadata.synthesis` (untyped JSON; every field optional,
// old debates have no ids) plus the debate's participants. List order is the engine's (t/769,
// t/775); nothing here re-ranks on camp.

import { POVER_INFO } from '../../types/debate';

export type DisputeTypeKey = 'definitional' | 'empirical' | 'values';

export interface CampRef { id: string; label: string }

export interface DisputeVerdict {
  /** camp: a camp prevails; unresolved: the model said undecidable (or the value is unreadable);
   *  none: no preference was matched to this dispute. */
  kind: 'camp' | 'unresolved' | 'none';
  camp?: CampRef;
  /** The raw `prevails` value when it could not be read as a camp (shown as plain text). */
  raw?: string;
}

export interface DisputeCardView {
  /** D1…Dn, in display order. */
  n: string;
  /** The disagreement's engine id (t/808), when present. */
  id?: string;
  point: string;
  /** Chip label; an unknown type keeps its raw value as `label` and `known: false`. */
  type: { label: string; raw: string; known: boolean; key?: DisputeTypeKey } | null;
  about: string | null;
  verdict: DisputeVerdict;
  /** The one-line "Why: …", or null. */
  why: string | null;
  rationale: string | null;
  whatWouldChange: string | null;
  resolvability: string | null;
  positions: { camp: CampRef; stance: string }[];
  /** True for a preference that matched no disagreement: its own card, no type chip. */
  unmatched: boolean;
}

export interface StripSegment { n: string; outcome: 'camp' | 'unresolved'; camp?: CampRef; noVerdict: boolean }
export interface StripLegendItem { key: string; label: string; count: number }

export interface NextMoveView {
  kind: DisputeTypeKey;
  title: string;
  chip: string;
  body: string | null;
}

export interface SettleRow { key: DisputeTypeKey; type: string; action: string; ids: string[] }

export interface SynthesisView {
  title: string;
  debaters: CampRef[];
  bottomLine: {
    /** Up to the first 3 sentences. */
    paragraph: string | null;
    /** The remaining sentences (behind "Read more"), or null. */
    more: string | null;
    /** True when no `where_it_landed` exists and the paragraph is the counts-only template. */
    fromTemplate: boolean;
    decisiveCrux: string | null;
    settle: SettleRow[];
  };
  strip: {
    segments: StripSegment[];
    legend: StripLegendItem[];
    heading: string;
    ariaLabel: string;
    pending: boolean;
  } | null;
  nextMoves: NextMoveView[];
  agreements: { items: string[]; unreadable: boolean };
  disputes: DisputeCardView[];
  cruxes: { n: string; type: DisputeTypeKey | null; typeLabel: string | null; rawType: string | null; question: string }[];
  openQuestions: { id: string; text: string }[];
  /** Section nav: only sections with items (or the unreadable line). */
  nav: { key: 'common-ground' | 'disputes' | 'cruxes' | 'open-questions'; label: string; count: number }[];
}

// ── Label tables (spec §5–§7) ──────────────────────────────────────────────

const TYPE_LABEL: Record<DisputeTypeKey, string> = {
  definitional: 'Definitional',
  empirical: 'Empirical',
  values: 'Values',
};

const SETTLE_ACTION: Record<DisputeTypeKey, string> = {
  definitional: 'Clearer terms',
  empirical: 'New evidence',
  values: 'A judgment call',
};

const BDI_ABOUT: Record<string, string> = {
  belief: "about what's true",
  intention: 'about what the plan intends',
  desire: 'about what matters more',
};

/** `preferences[].criterion` → the clause after "the <Camp>'s argument". Codes come from
 *  lib/debate/prompts/synthesis.ts. An unknown code is shown raw, never blank. */
export const CRITERION_PHRASE: Record<string, string> = {
  empirical_evidence: 'cited more or better evidence',
  logical_validity: 'had fewer logical gaps',
  source_authority: 'drew on more authoritative sources',
  specificity: 'was more specific and testable',
  scope: 'took more relevant considerations into account',
  political_feasibility: 'was more likely to get through a legislature and be enforced',
  implementation_specificity: 'named concrete enforcement steps, timelines and responsible bodies',
};

export function typeKeyOf(raw: unknown): DisputeTypeKey | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  return k === 'definitional' || k === 'empirical' || k === 'values' ? k : null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function campRef(id: string): CampRef {
  const info = (POVER_INFO as Record<string, { label?: string } | undefined>)[id];
  return { id, label: info?.label ?? id };
}

/** Lower-case, strip punctuation and collapse whitespace, for the no-id join. */
export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenOverlap(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both);
}

/** Matches when the normalised texts are equal, one contains the other, or the word sets overlap
 *  by at least 60% (the model often paraphrases a `conflict` slightly). */
export function textMatches(a: string, b: string): boolean {
  const x = normaliseText(a);
  const y = normaliseText(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return tokenOverlap(x, y) >= 0.6;
}

/** First `n` words at a word boundary, trailing punctuation dropped (spec §7). */
export function shorten(text: string, n = 8): string {
  const words = text.trim().split(/\s+/);
  const cut = words.slice(0, n).join(' ').replace(/[\s,;:.?!–—-]+$/u, '');
  return words.length > n ? `${cut}…` : cut;
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/** `claim_id` → camp id, from the synthesis `argument_map` (claimant on every claim, including
 *  the nested attackers). */
function claimCamps(argumentMap: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: unknown): void => {
    if (!isRec(n)) return;
    const id = str(n.claim_id);
    const who = str(n.claimant);
    if (id && who && !out.has(id)) out.set(id, who);
    for (const k of ['supported_by', 'attacked_by']) arr(n[k]).forEach(visit);
  };
  arr(argumentMap).forEach(visit);
  return out;
}

function resolveVerdict(prevails: string | null, claims: Map<string, string>, debaters: CampRef[]): DisputeVerdict {
  if (!prevails) return { kind: 'unresolved' };
  const v = prevails.trim();
  if (/^undecidable$/i.test(v)) return { kind: 'unresolved' };
  const claimCamp = claims.get(v);
  if (claimCamp) return { kind: 'camp', camp: campRef(claimCamp) };
  const lower = v.toLowerCase();
  const named = debaters.find(d => lower === d.id || lower === d.label.toLowerCase());
  if (named) return { kind: 'camp', camp: named };
  return { kind: 'unresolved', raw: v };
}

function whyLine(verdict: DisputeVerdict, criterion: string | null): string | null {
  if (verdict.kind !== 'camp' || !verdict.camp || !criterion) return null;
  const phrase = CRITERION_PHRASE[criterion];
  return phrase ? `Why: the ${verdict.camp.label}'s argument ${phrase}.` : `Why: ${criterion}`;
}

// ── The builder ────────────────────────────────────────────────────────────

export interface BuildSynthesisInput {
  synthesis: unknown;
  /** Camp ids taking part (`active_povers`); non-camp speakers such as 'user' are ignored. */
  debaters: readonly string[];
  /** The session topic, used when the synthesis has no restated question. */
  topic?: string;
  /** True while the synthesis is still running: the strip shows "Verdicts pending". */
  pending?: boolean;
}

interface Pref { conflict: string; prevails: string | null; criterion: string | null; rationale: string | null; change: string | null; disagreementId: string | null }

function readPrefs(v: unknown): Pref[] {
  const out: Pref[] = [];
  for (const p of arr(v)) {
    if (!isRec(p)) continue;
    const conflict = str(p.conflict);
    if (!conflict) continue;
    out.push({
      conflict,
      prevails: str(p.prevails),
      criterion: str(p.criterion),
      rationale: str(p.rationale),
      change: str(p.what_would_change_this),
      disagreementId: str(p.disagreement_id),
    });
  }
  return out;
}

export function buildSynthesisView(input: BuildSynthesisInput): SynthesisView {
  const s: Rec = isRec(input.synthesis) ? input.synthesis : {};
  const debaters = input.debaters.filter(d => d in POVER_INFO && d !== 'user').map(campRef);
  const claims = claimCamps(s.argument_map);
  const unreadable = new Set(arr(s.unreadable_lists).filter((k): k is string => typeof k === 'string'));
  const tr: Rec = isRec(s.topic_resolution) ? s.topic_resolution : {};

  // Disputes + the preference join (id first, then text; unmatched preferences keep their own card).
  const prefs = readPrefs(s.preferences);
  const used = new Set<number>();
  const rawDisputes = arr(s.areas_of_disagreement).filter(isRec).filter(d => str(d.point));
  const findPref = (d: Rec): number => {
    const id = str(d.id);
    const point = str(d.point) as string;
    if (id) {
      const byId = prefs.findIndex((p, i) => !used.has(i) && p.disagreementId === id);
      if (byId >= 0) return byId;
    }
    return prefs.findIndex((p, i) => !used.has(i) && !(p.disagreementId && id) && textMatches(p.conflict, point));
  };

  const disputes: DisputeCardView[] = rawDisputes.map(d => {
    const pi = findPref(d);
    const pref = pi >= 0 ? prefs[pi] : null;
    if (pi >= 0) used.add(pi);
    const rawType = str(d.type);
    const key = typeKeyOf(rawType);
    const layer = str(d.bdi_layer)?.toLowerCase();
    const verdict: DisputeVerdict = pref ? resolveVerdict(pref.prevails, claims, debaters) : { kind: 'none' };
    return {
      n: '',
      id: str(d.id) ?? undefined,
      point: str(d.point) as string,
      type: rawType ? { label: key ? TYPE_LABEL[key] : rawType, raw: rawType, known: key !== null, key: key ?? undefined } : null,
      about: layer ? BDI_ABOUT[layer] ?? null : null,
      verdict,
      why: pref ? whyLine(verdict, pref.criterion) : null,
      rationale: pref?.rationale ?? null,
      whatWouldChange: pref?.change ?? null,
      resolvability: str(d.resolvability),
      positions: arr(d.positions).filter(isRec)
        .map(p => ({ camp: campRef(str(p.pover) ?? 'unknown'), stance: str(p.stance) ?? '' }))
        .filter(p => p.stance),
      unmatched: false,
    };
  });

  prefs.forEach((p, i) => {
    if (used.has(i)) return;
    const verdict = resolveVerdict(p.prevails, claims, debaters);
    disputes.push({
      n: '', point: p.conflict, type: null, about: null, verdict,
      why: whyLine(verdict, p.criterion), rationale: p.rationale, whatWouldChange: p.change,
      resolvability: null, positions: [], unmatched: true,
    });
  });
  disputes.forEach((d, i) => { d.n = `D${i + 1}`; });

  // Outcome strip.
  const pending = input.pending === true;
  const segments: StripSegment[] = disputes.map(d => ({
    n: d.n,
    outcome: !pending && d.verdict.kind === 'camp' ? 'camp' : 'unresolved',
    camp: !pending && d.verdict.kind === 'camp' ? d.verdict.camp : undefined,
    noVerdict: d.verdict.kind === 'none',
  }));
  const campCounts = new Map<string, number>();
  debaters.forEach(c => campCounts.set(c.id, 0));
  const unresolvedCount = disputes.filter(d => d.verdict.kind === 'unresolved').length;
  const noVerdictCount = disputes.filter(d => d.verdict.kind === 'none').length;
  for (const sg of segments) if (sg.camp) campCounts.set(sg.camp.id, (campCounts.get(sg.camp.id) ?? 0) + 1);
  const legend: StripLegendItem[] = [
    ...[...campCounts.entries()].map(([id, count]) => ({ key: id, label: campRef(id).label, count })),
    { key: 'unresolved', label: 'Unresolved', count: pending ? disputes.length : unresolvedCount },
  ];
  if (!pending && noVerdictCount > 0) legend.push({ key: 'none', label: 'No verdict', count: noVerdictCount });
  const outcomeText = (d: DisputeCardView): string =>
    pending ? 'verdict pending'
      : d.verdict.kind === 'camp' ? `${d.verdict.camp?.label} stronger`
        : d.verdict.kind === 'none' ? 'no verdict' : 'unresolved';
  const strip = disputes.length === 0 ? null : {
    segments,
    legend,
    heading: pending ? 'Verdicts pending' : 'Which camp made the stronger case (model’s assessment)',
    ariaLabel: disputes.map(d => `${d.n}: ${outcomeText(d)}.`).join(' '),
    pending,
  };

  // Bottom line.
  const landed = str(tr.where_it_landed);
  let paragraph: string | null = null;
  let more: string | null = null;
  let fromTemplate = false;
  if (landed) {
    const sentences = splitSentences(landed);
    paragraph = sentences.slice(0, 3).join(' ');
    more = sentences.length > 3 ? sentences.slice(3).join(' ') : null;
  } else if (disputes.length > 0) {
    const decided = disputes.filter(d => d.verdict.kind === 'camp').length;
    const parts = [`The camps stated a stronger case on ${decided} of ${disputes.length} disputes`];
    if (unresolvedCount) parts.push(`${unresolvedCount} ${unresolvedCount === 1 ? 'is' : 'are'} unresolved`);
    if (noVerdictCount) parts.push(`${noVerdictCount} ${noVerdictCount === 1 ? 'has' : 'have'} no verdict`);
    paragraph = `${parts.join('; ')}.`;
    fromTemplate = true;
  }

  const idsByType = (k: DisputeTypeKey): DisputeCardView[] => disputes.filter(d => d.type?.key === k);
  const order: DisputeTypeKey[] = ['definitional', 'empirical', 'values'];
  const settle: SettleRow[] = order
    .filter(k => idsByType(k).length > 0)
    .map(k => ({ key: k, type: TYPE_LABEL[k], action: SETTLE_ACTION[k], ids: idsByType(k).map(d => d.n) }));

  // Next moves: rule table only (spec §7), cheapest first.
  const nextMoves: NextMoveView[] = order.filter(k => idsByType(k).length > 0).map(k => {
    const ds = idsByType(k);
    const first = ds[0];
    const ids = ds.map(d => d.n).join(', ');
    const term = shorten(first.point);
    const body = ds.map(d => d.whatWouldChange ?? d.resolvability?.replace(/_/g, ' ') ?? null).find(Boolean) ?? null;
    return k === 'definitional'
      ? { kind: k, title: `Define ${term}`, chip: `Settles ${ids}`, body }
      : k === 'empirical'
        ? { kind: k, title: `Find a way to measure ${term}`, chip: `Bears on ${ids}`, body }
        : { kind: k, title: `Name the trade-off on ${term}`, chip: `Answers ${ids}`, body };
  });

  // Plain lists.
  const agreementItems = arr(s.areas_of_agreement).map(a => (isRec(a) ? str(a.point) : str(a))).filter((x): x is string => !!x);
  const cruxes = arr(s.cruxes).filter(isRec).filter(c => str(c.question)).map((c, i) => {
    const raw = str(c.type);
    const key = typeKeyOf(raw);
    return { n: `C${i + 1}`, type: key, typeLabel: raw ? (key ? TYPE_LABEL[key] : raw) : null, rawType: raw, question: str(c.question) as string };
  });
  const openQuestions = arr(s.unresolved_questions).map(q => (isRec(q) ? str(q.question) ?? str(q.text) : str(q)))
    .filter((x): x is string => !!x).map((text, i) => ({ id: `Q${i + 1}`, text }));

  const agreementsUnreadable = agreementItems.length === 0 && unreadable.has('areas_of_agreement');
  const nav: SynthesisView['nav'] = [];
  if (agreementItems.length || agreementsUnreadable) nav.push({ key: 'common-ground', label: 'Common ground', count: agreementItems.length });
  if (disputes.length) nav.push({ key: 'disputes', label: 'Disputes', count: disputes.length });
  if (cruxes.length) nav.push({ key: 'cruxes', label: 'Cruxes', count: cruxes.length });
  if (openQuestions.length) nav.push({ key: 'open-questions', label: 'Open questions', count: openQuestions.length });

  return {
    title: str(tr.restated_question) ?? input.topic ?? 'Debate synthesis',
    debaters,
    bottomLine: { paragraph, more, fromTemplate, decisiveCrux: str(tr.what_would_resolve_it), settle },
    strip,
    nextMoves,
    agreements: { items: agreementItems, unreadable: agreementsUnreadable },
    disputes,
    cruxes,
    openQuestions,
    nav,
  };
}
