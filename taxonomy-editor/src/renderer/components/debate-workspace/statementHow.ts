// t/469: pure data model for the per-statement HOW view (Layout A, docs/ux/debate-statement-how.md).
// No React. Every field is read from the statement's own record or its argument network; nothing
// is synthesised, and nothing from the plan stage is used (no statement has one).

import type { ArgumentNetworkNode, ArgumentNetworkEdge, ConvergenceSignals, TranscriptEntry } from '../../types/debate';

export interface StatementHowItem {
  id: string; // the attacking or supporting node id
  text: string;
  kind: 'attacks' | 'supports';
}

export interface StatementHowClaim {
  index: number; // 1-based, matches the C{n} badge
  node: ArgumentNetworkNode;
  attacks: StatementHowItem[];
  supports: StatementHowItem[];
}

export interface StatementHowMove {
  move: string;
  target?: string; // an argument-network id, when the move names one
  detail?: string;
}

export interface StatementHowAssumption {
  assumption: string;
  if_wrong?: string;
}

export interface StatementHowModel {
  claims: StatementHowClaim[];
  attackCount: number;
  supportCount: number;
  focus?: string;
  moves: StatementHowMove[];
  assumptions: StatementHowAssumption[];
  anticipated: string[];
}

/** The first `limit` items, and how many are left behind "Show N more" (per claim). */
export function collapseItems<T>(items: T[], limit = 3): { shown: T[]; hidden: number } {
  return { shown: items.slice(0, limit), hidden: Math.max(0, items.length - limit) };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function buildStatementHow(entry: TranscriptEntry, nodes: ArgumentNetworkNode[], edges: ArgumentNetworkEdge[]): StatementHowModel {
  const entryNodes = nodes.filter(n => n.source_entry_id === entry.id);
  const textOf = new Map(nodes.map(n => [n.id, n.text ?? '']));
  const claims: StatementHowClaim[] = entryNodes.map((node, i) => {
    const incoming = edges.filter(e => e.target === node.id);
    const item = (e: ArgumentNetworkEdge): StatementHowItem => ({ id: e.source, text: textOf.get(e.source) ?? '', kind: e.type as 'attacks' | 'supports' });
    return {
      index: i + 1,
      node,
      attacks: incoming.filter(e => e.type === 'attacks').map(item),
      supports: incoming.filter(e => e.type === 'supports').map(item),
    };
  });
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const moves = Array.isArray(meta.move_types)
    ? (meta.move_types as Record<string, unknown>[])
      .map(m => ({ move: asString(m.move) ?? '', target: asString(m.target), detail: asString(m.detail) }))
      .filter(m => m.move !== '')
    : [];
  const assumptions = Array.isArray(meta.key_assumptions)
    ? (meta.key_assumptions as Record<string, unknown>[])
      .map(a => ({ assumption: asString(a.assumption) ?? '', if_wrong: asString(a.if_wrong) }))
      .filter(a => a.assumption !== '')
    : [];
  const anticipated = Array.isArray(meta.anticipated_responses)
    ? (meta.anticipated_responses as unknown[]).map(asString).filter((s): s is string => s !== undefined)
    : [];
  return {
    claims,
    attackCount: claims.reduce((n, c) => n + c.attacks.length, 0),
    supportCount: claims.reduce((n, c) => n + c.supports.length, 0),
    focus: asString(meta.focus_point),
    moves,
    assumptions,
    anticipated,
  };
}

/** The seven convergence signals as [label, value] cells. All seven are present on every row in the
 *  data (t/469 measurement); only the counterargument and the concession outcome can be null. */
export function convergenceCells(s: ConvergenceSignals): [string, string][] {
  const mp = s.move_polarity;
  const de = s.dialectical_engagement;
  return [
    ['Move polarity', `${mp.ratio} (${mp.confrontational} confrontational, ${mp.collaborative} collaborative)`],
    ['Dialectical engagement', `${de.ratio} (${de.targeted} targeted, ${de.standalone} standalone)`],
    ['Argument redundancy', `avg overlap ${s.argument_redundancy.avg_self_overlap}`],
    ['Dominant counterargument', s.dominant_counterargument ? String(s.dominant_counterargument) : 'None'],
    ['Concession opportunity', s.concession_opportunity.outcome ?? 'none'],
    ['Position drift', `${s.position_drift.drift}`],
    ['Crux engagement', `${s.crux_engagement_rate.cumulative_follow_through} follow-through`],
  ];
}

/** The counts line, with zero terms left out: "2 claims · 5 attacks · 1 support". */
export function statementCounts(m: StatementHowModel): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    m.claims.length > 0 && plural(m.claims.length, 'claim'),
    m.attackCount > 0 && plural(m.attackCount, 'attack'),
    m.supportCount > 0 && plural(m.supportCount, 'support'),
  ].filter(Boolean).join(' · ');
}
