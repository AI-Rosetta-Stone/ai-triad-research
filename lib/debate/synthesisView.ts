// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809 (spec docs/ux/debate-synthesis-v2.md, t/807): the pure view-model for the synthesis
// "sponsor briefing" panel. Every join, label translation and rule lives here so the components
// stay presentational. Input is `entry.metadata.synthesis` (untyped JSON; every field optional,
// old debates have no ids) plus the debate's participants. List order is the engine's (t/769,
// t/775); nothing here re-ranks on camp.

import { POVER_INFO } from './types.js';

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
  /** The full dispute text, when the title had to drop some of it. */
  context: string | null;
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
  /** Open questions in render order: one untitled group (flat), or themed groups (spec §8). */
  openQuestionGroups: { theme: string | null; questions: { id: string; text: string }[] }[];
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

/**
 * The one text join for a preference's free-text `conflict` against the disagreements' `point`s, shared
 * by the engine (synthesisLinks.ts, when the model gave no valid disagreement_id) and this builder (old
 * debates with no ids). Returns the index of the matching point, or -1 when nothing matches clearly:
 * exactly one point equal after normalising; else exactly one point containing or contained by the
 * conflict (both at least 20 characters); else the single best word-overlap of at least 0.5 with no tie.
 * Never the first of several candidates: an unlinked preference stays unlinked (t/810, Design).
 */
export function matchPointIndex(conflict: string, points: readonly string[]): number {
  const c = normaliseText(conflict);
  if (c === '') return -1;
  const ps = points.map(normaliseText);
  const only = (hits: number[]): number => (hits.length === 1 ? hits[0] : -1);
  const idx = (pred: (p: string) => boolean): number[] => ps.flatMap((p, i) => (pred(p) ? [i] : []));
  const exact = idx(p => p === c);
  if (exact.length > 0) return only(exact);
  const contained = only(idx(p => p.length >= 20 && c.length >= 20 && (p.includes(c) || c.includes(p))));
  if (contained >= 0) return contained;
  let best = -1;
  let bestScore = 0;
  let tie = false;
  ps.forEach((p, i) => {
    const score = tokenOverlap(c, p);
    if (score > bestScore) { best = i; bestScore = score; tie = false; } else if (score === bestScore && score > 0) tie = true;
  });
  return bestScore >= 0.5 && !tie ? best : -1;
}

const TRAILING_FILLER = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'without', 'that', 'can', 'be', 'is', 'are', 'will', 'whether', 'if', 'by', 'as']);

/** Words ending in -ly that are nouns (or names), so a cut title ending in one keeps it (t/822). */
const LY_NOUNS = new Set(['family', 'supply', 'assembly', 'monopoly', 'oligopoly', 'duopoly', 'anomaly', 'ally', 'apply', 'reply', 'rally', 'tally', 'bully', 'belly', 'jelly', 'italy']);

/** A trailing adverb ("effectively"): 6+ letters ending in -ly and not a known noun. Only used on a title that was already cut. */
const isTrailingAdverb = (w: string): boolean => /ly$/i.test(w) && w.length >= 6 && !LY_NOUNS.has(w.toLowerCase());

/**
 * The noun-phrase a next-move title is built around (spec §7, Design p/14#150): a leading
 * "Whether"/"If" dropped, first letter lower-cased (not an acronym), cut at a clause boundary
 * (comma, semicolon, colon) inside the first `n` words, else at `n` words with dangling filler
 * words removed. Never an ellipsis: `lost` says whether text was dropped so the caller can show
 * the full sentence in the card body instead.
 */
export function termOf(text: string, n = 8): { term: string; lost: boolean } {
  const flat = text.trim().replace(/\s+/g, ' ').replace(/[?!.]+$/u, '');
  const stripped = flat.replace(/^(whether|if)\s+/i, '');
  const lowered = /^[A-Z][a-z]/.test(stripped) ? stripped[0].toLowerCase() + stripped.slice(1) : stripped;
  const words = lowered.split(' ');
  let cut = words.slice(0, n).join(' ');
  const clause = cut.search(/[,;:]/);
  if (words.length > n || clause >= 0) {
    if (clause > 0) cut = cut.slice(0, clause);
    const kept = cut.split(' ');
    while (kept.length > 1 && (TRAILING_FILLER.has(kept[kept.length - 1].toLowerCase()) || isTrailingAdverb(kept[kept.length - 1]))) kept.pop();
    cut = kept.join(' ');
  }
  const term = cut.replace(/[\s,;:.?!–—-]+$/u, '');
  return { term, lost: term.length < lowered.length };
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

function disputeFromRaw(d: Rec, pref: Pref | null, claims: Map<string, string>, debaters: CampRef[]): DisputeCardView {
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
}

/** Disputes with the preference join (a valid disagreement_id first, then the engine's unique text
 *  match); a preference that matches no disagreement keeps its own card at the end, never dropped.
 *  Numbers them D1…Dn. */
function buildDisputes(s: Rec, claims: Map<string, string>, debaters: CampRef[]): DisputeCardView[] {
  const prefs = readPrefs(s.preferences);
  const raw = arr(s.areas_of_disagreement).filter(isRec).filter(d => str(d.point));
  const points = raw.map(d => str(d.point) as string);
  const ids = raw.map(d => str(d.id));
  const target = prefs.map(p => {
    const byId = p.disagreementId ? ids.indexOf(p.disagreementId) : -1;
    return byId >= 0 ? byId : matchPointIndex(p.conflict, points);
  });
  const used = new Set<number>();
  const disputes = raw.map((d, di) => {
    const pi = target.findIndex((t, k) => t === di && !used.has(k));
    if (pi >= 0) used.add(pi);
    return disputeFromRaw(d, pi >= 0 ? prefs[pi] : null, claims, debaters);
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
  return disputes;
}

function outcomeText(d: DisputeCardView, pending: boolean): string {
  if (pending) return 'verdict pending';
  if (d.verdict.kind === 'camp') return `${d.verdict.camp?.label} stronger`;
  return d.verdict.kind === 'none' ? 'no verdict' : 'unresolved';
}

function buildStrip(disputes: DisputeCardView[], debaters: CampRef[], pending: boolean): SynthesisView['strip'] {
  if (disputes.length === 0) return null;
  const segments: StripSegment[] = disputes.map(d => {
    const camp = !pending && d.verdict.kind === 'camp' ? d.verdict.camp : undefined;
    return { n: d.n, outcome: camp ? 'camp' : 'unresolved', camp, noVerdict: d.verdict.kind === 'none' };
  });
  const counts = new Map<string, number>(debaters.map(c => [c.id, 0]));
  for (const sg of segments) if (sg.camp) counts.set(sg.camp.id, (counts.get(sg.camp.id) ?? 0) + 1);
  const unresolved = disputes.filter(d => d.verdict.kind === 'unresolved').length;
  const noVerdict = disputes.filter(d => d.verdict.kind === 'none').length;
  const legend: StripLegendItem[] = [
    ...[...counts.entries()].map(([id, count]) => ({ key: id, label: campRef(id).label, count })),
    { key: 'unresolved', label: 'Unresolved', count: pending ? disputes.length : unresolved },
  ];
  if (!pending && noVerdict > 0) legend.push({ key: 'none', label: 'No verdict', count: noVerdict });
  return {
    segments,
    legend,
    heading: pending ? 'Verdicts pending' : 'Which camp made the stronger case (model’s assessment)',
    ariaLabel: disputes.map(d => `${d.n}: ${outcomeText(d, pending)}.`).join(' '),
    pending,
  };
}

function templateParagraph(disputes: DisputeCardView[]): string | null {
  if (disputes.length === 0) return null;
  const decided = disputes.filter(d => d.verdict.kind === 'camp').length;
  const unresolved = disputes.filter(d => d.verdict.kind === 'unresolved').length;
  const none = disputes.filter(d => d.verdict.kind === 'none').length;
  const parts = [`The camps stated a stronger case on ${decided} of ${disputes.length} disputes`];
  if (unresolved) parts.push(`${unresolved} ${unresolved === 1 ? 'is' : 'are'} unresolved`);
  if (none) parts.push(`${none} ${none === 1 ? 'has' : 'have'} no verdict`);
  return `${parts.join('; ')}.`;
}

const TYPE_ORDER: DisputeTypeKey[] = ['definitional', 'empirical', 'values'];

function buildBottomLine(tr: Rec, disputes: DisputeCardView[]): SynthesisView['bottomLine'] {
  const landed = str(tr.where_it_landed);
  const sentences = landed ? splitSentences(landed) : [];
  const ofType = (k: DisputeTypeKey): DisputeCardView[] => disputes.filter(d => d.type?.key === k);
  return {
    paragraph: landed ? sentences.slice(0, 3).join(' ') : templateParagraph(disputes),
    more: sentences.length > 3 ? sentences.slice(3).join(' ') : null,
    fromTemplate: !landed && disputes.length > 0,
    decisiveCrux: str(tr.what_would_resolve_it),
    settle: TYPE_ORDER.filter(k => ofType(k).length > 0)
      .map(k => ({ key: k, type: TYPE_LABEL[k], action: SETTLE_ACTION[k], ids: ofType(k).map(d => d.n) })),
  };
}

/** Next moves: rule table only (spec §7), cheapest first. */
function buildNextMoves(disputes: DisputeCardView[]): NextMoveView[] {
  const moves: NextMoveView[] = [];
  for (const kind of TYPE_ORDER) {
    const ds = disputes.filter(d => d.type?.key === kind);
    if (ds.length === 0) continue;
    const { term, lost } = termOf(ds[0].point);
    const ids = ds.map(d => d.n).join(', ');
    const body = ds.map(d => d.whatWouldChange ?? d.resolvability?.replace(/_/g, ' ') ?? null).find(Boolean) ?? null;
    const [title, chip] = kind === 'definitional' ? [`Define ${term}`, `Settles ${ids}`]
      : kind === 'empirical' ? [`Find a way to measure ${term}`, `Bears on ${ids}`]
        : [`Name the trade-off on ${term}`, `Answers ${ids}`];
    moves.push({ kind, title, chip, body, context: lost ? ds[0].point : null });
  }
  return moves;
}

function buildCruxes(s: Rec): SynthesisView['cruxes'] {
  return arr(s.cruxes).filter(isRec).filter(c => str(c.question)).map((c, i) => {
    const raw = str(c.type);
    const key = typeKeyOf(raw);
    return { n: `C${i + 1}`, type: key, typeLabel: raw ? (key ? TYPE_LABEL[key] : raw) : null, rawType: raw, question: str(c.question) as string };
  });
}

function textOf(q: unknown): string | null {
  return isRec(q) ? str(q.question) ?? str(q.text) : str(q);
}

/**
 * Spec §8 (Design p/14#151): group by `unresolved_question_themes` (parallel to the questions, '' for
 * none) only when at least one theme covers 2+ questions, which guards against a model giving every
 * question its own label. Otherwise one flat list. Questions with no theme go in a final list with
 * no heading.
 */
function buildQuestionGroups(themes: unknown, questions: { id: string; text: string }[]): SynthesisView['openQuestionGroups'] {
  if (questions.length === 0) return [];
  const themeOf = arr(themes);
  const labelled = questions.map((q, i) => ({ q, theme: str(themeOf[i]) }));
  const counts = new Map<string, number>();
  for (const { theme } of labelled) if (theme) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  if (![...counts.values()].some(n => n >= 2)) return [{ theme: null, questions }];
  const groups: SynthesisView['openQuestionGroups'] = [...counts.keys()].map(theme => ({
    theme, questions: labelled.filter(l => l.theme === theme).map(l => l.q),
  }));
  const ungrouped = labelled.filter(l => !l.theme).map(l => l.q);
  if (ungrouped.length) groups.push({ theme: null, questions: ungrouped });
  return groups;
}

function buildNav(c: { agreements: number; agreementsUnreadable: boolean; disputes: number; cruxes: number; questions: number }): SynthesisView['nav'] {
  const nav: SynthesisView['nav'] = [];
  if (c.agreements || c.agreementsUnreadable) nav.push({ key: 'common-ground', label: 'Common ground', count: c.agreements });
  if (c.disputes) nav.push({ key: 'disputes', label: 'Disputes', count: c.disputes });
  if (c.cruxes) nav.push({ key: 'cruxes', label: 'Cruxes', count: c.cruxes });
  if (c.questions) nav.push({ key: 'open-questions', label: 'Open questions', count: c.questions });
  return nav;
}

export function buildSynthesisView(input: BuildSynthesisInput): SynthesisView {
  const s: Rec = isRec(input.synthesis) ? input.synthesis : {};
  const debaters = input.debaters.filter(d => d in POVER_INFO && d !== 'user').map(campRef);
  const tr: Rec = isRec(s.topic_resolution) ? s.topic_resolution : {};
  const disputes = buildDisputes(s, claimCamps(s.argument_map), debaters);
  const agreementItems = arr(s.areas_of_agreement).map(textOf2).filter((x): x is string => !!x);
  const agreementsUnreadable = agreementItems.length === 0 && arr(s.unreadable_lists).includes('areas_of_agreement');
  const cruxes = buildCruxes(s);
  const openQuestions = arr(s.unresolved_questions).map(textOf).filter((x): x is string => !!x)
    .map((text, i) => ({ id: `Q${i + 1}`, text }));

  return {
    title: str(tr.restated_question) ?? input.topic ?? 'Debate synthesis',
    debaters,
    bottomLine: buildBottomLine(tr, disputes),
    strip: buildStrip(disputes, debaters, input.pending === true),
    nextMoves: buildNextMoves(disputes),
    agreements: { items: agreementItems, unreadable: agreementsUnreadable },
    disputes,
    cruxes,
    openQuestions,
    openQuestionGroups: buildQuestionGroups(s.unresolved_question_themes, openQuestions),
    nav: buildNav({
      agreements: agreementItems.length, agreementsUnreadable, disputes: disputes.length,
      cruxes: cruxes.length, questions: openQuestions.length,
    }),
  };
}

function textOf2(a: unknown): string | null {
  return isRec(a) ? str(a.point) : str(a);
}
