// t/469: pure data model for the per-statement HOW view (Layout A, docs/ux/debate-statement-how.md).
// No React. Every field is read from the statement's own record or its argument network; nothing
// is synthesised, and nothing from the plan stage is used (no statement has one).

import type { ArgumentNetworkNode, ArgumentNetworkEdge, TranscriptEntry } from '../../types/debate';

export interface StatementHowItem {
  id: string; // the attacking or supporting node id
  text: string;
  kind: 'attacks' | 'supports';
  speaker?: 'accelerationist' | 'safetyist' | 'skeptic'; // the attacker's POV speaker; absent for other speakers
}

const POV_SPEAKERS = new Set(['accelerationist', 'safetyist', 'skeptic']);

/** The POV speaker of the entry that owns a node, or undefined for anything else (incl. 'system'). */
function povSpeakerOf(nodeId: string, nodes: ArgumentNetworkNode[], transcript: TranscriptEntry[]): StatementHowItem['speaker'] {
  const node = nodes.find(n => n.id === nodeId);
  const speaker = transcript.find(e => e.id === node?.source_entry_id)?.speaker as string | undefined;
  return speaker && POV_SPEAKERS.has(speaker) ? (speaker as StatementHowItem['speaker']) : undefined;
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

export function buildStatementHow(entry: TranscriptEntry, nodes: ArgumentNetworkNode[], edges: ArgumentNetworkEdge[], transcript: TranscriptEntry[] = []): StatementHowModel {
  const entryNodes = nodes.filter(n => n.source_entry_id === entry.id);
  const textOf = new Map(nodes.map(n => [n.id, n.text ?? '']));
  const claims: StatementHowClaim[] = entryNodes.map((node, i) => {
    const incoming = edges.filter(e => e.target === node.id);
    const item = (e: ArgumentNetworkEdge): StatementHowItem => ({ id: e.source, text: textOf.get(e.source) ?? '', kind: e.type as 'attacks' | 'supports', speaker: povSpeakerOf(e.source, nodes, transcript) });
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

/** The counts line, with zero terms left out: "2 claims · 5 attacks · 1 support". */
export function statementCounts(m: StatementHowModel): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    m.claims.length > 0 && plural(m.claims.length, 'claim'),
    m.attackCount > 0 && plural(m.attackCount, 'attack'),
    m.supportCount > 0 && plural(m.supportCount, 'support'),
  ].filter(Boolean).join(' · ');
}

/** The debate fields the HOW view reads, looked up for one statement. */
export function readDebateHow(debate: { argument_network?: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] } } | null | undefined) {
  return { nodes: debate?.argument_network?.nodes, edges: debate?.argument_network?.edges ?? [] };
}
