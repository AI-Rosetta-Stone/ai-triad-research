// t/331: pure data mapping for the How → Plan claim-map layout (no React).
import { normalizeSteelmanTarget } from '@lib/debate/steelman';

/** A steelman linked to an attack: the plan tagged it as ATTACK [id] and the node resolved (t/388). */
export interface AttackSteelman {
  text: string;
  camp: string; // the camp whose position is steelmanned
  verdict: 'faithful' | 'diverges' | 'unchecked';
}

export interface ParsedAttack {
  text: string;
  targetAnchor?: string; // the node the attack names, from "targeting node X"
  // Only set when the tag is in steelman_refs_offered. The card shows it only when the steelman below resolved (t/388).
  steelmanId?: string;
  steelman?: AttackSteelman; // set only when the tagged node resolves on this debate's network
}

/** The argument-network nodes and entry the steelman tags resolve against (t/388). */
export interface SteelmanContext {
  nodes: { id: string; text?: string; steelman_of?: string | null; steelman_check?: { verdict: AttackSteelman['verdict'] }; source_entry_id?: string }[];
  entryId?: string;
  speaker: string;
}

/**
 * Resolves a tagged steelman. Shown only when the node is a steelman (steelman_of set), it came
 * from an earlier entry (not this one), and its camp is not the speaker's (normalizeSteelmanTarget
 * rejects a self-steelman). Anything else returns undefined, and the attack stays Unverified.
 */
export function resolveSteelman(ctx: SteelmanContext, id: string): AttackSteelman | undefined {
  if (!ctx.entryId) return undefined;
  const node = ctx.nodes.find(n => n.id === id);
  if (!node || !node.steelman_of || !node.source_entry_id || node.source_entry_id === ctx.entryId) return undefined;
  const { target } = normalizeSteelmanTarget(node.steelman_of, ctx.speaker);
  if (!target) return undefined;
  return { text: node.text ?? '', camp: target, verdict: node.steelman_check?.verdict ?? 'unchecked' };
}

export interface ParsedClaim {
  index: number; // 1-based over the claims that rendered, matches the C{n} badge
  point: string;
  evidence?: string;
  taxonomy_anchor?: string;
  attack?: ParsedAttack; // at most one attack per claim
}

export interface ParsedAssumption {
  text: string;
  tagged: boolean; // true for ASSUMPTION: items, false for untagged challenges
}

export interface ParsedWorkProduct {
  claims: ParsedClaim[];
  unmappedAttacks: ParsedAttack[];
  assumptions: ParsedAssumption[];
  verifiedAttacks: number; // attacks whose steelman has a verdict (faithful or diverges)
}

// Called once per skipped item, so the fallback is logged (a WARN), never silent.
export type WarnFn = (message: string) => void;

// t/3418: anticipated_challenges/anticipated_responses migrated object → tagged-string
// (t/3404, PR #2093), but debates persisted under the old schema still have
// {challenge, type} objects — rendering one directly is React error #31.
// Returns null when the item carries no readable text.
export function readAnticipatedItem(r: unknown): string | null {
  if (typeof r === 'string') return r.trim() === '' ? null : r;
  if (r && typeof r === 'object' && 'challenge' in r) {
    const { challenge, type } = r as { challenge: unknown; type?: unknown };
    if (typeof challenge !== 'string' || challenge.trim() === '') return null;
    return `${type ? `${String(type)}: ` : ''}${challenge}`;
  }
  return null;
}

// AnticipatedBox (legacy view) renders '' for an unreadable item.
export function normalizeAnticipatedItem(r: unknown): string {
  return readAnticipatedItem(r) ?? '';
}

const TARGET_PHRASE = /\s*targeting node (\S+)$/;

// Drops wrapping brackets and quotes, trailing punctuation and a possessive, so "(acc-B-001)" and "acc-B-001's" both read as the anchor.
function cleanToken(token: string): string {
  return token
    .replace(/^[([{"'“]+/, '')
    .replace(/[)\]}.,;:!?"'”]+$/, '')
    .replace(/['’]s$/, '');
}

// A named target decides the claim on its own: when it names no claim, the attack stays unmapped.
// Without a target, a whole token of the text must equal a claim's anchor, never a substring.
function findClaim(claims: ParsedClaim[], target: string | undefined, body: string): ParsedClaim | undefined {
  if (target !== undefined) return claims.find(c => c.taxonomy_anchor === target);
  const tokens = body.split(/\s+/).map(cleanToken);
  return claims.find(c => c.taxonomy_anchor !== undefined && tokens.includes(c.taxonomy_anchor));
}

export interface ParsedLens {
  title: string; // the frame
  why?: string;
}

// framing_choices is an array of {frame, why}, or a plain string. A malformed entry is skipped with a WARN.
export function parseLenses(framingChoices: unknown, warn: WarnFn = () => {}): ParsedLens[] {
  if (framingChoices === undefined) return [];
  if (typeof framingChoices === 'string') {
    if (framingChoices.trim() !== '') return [{ title: framingChoices }];
    warn('framing_choices is an empty string; skipped');
    return [];
  }
  if (!Array.isArray(framingChoices)) {
    warn(`framing_choices is not a list or a string (${framingChoices === null ? 'null' : typeof framingChoices}); skipped`);
    return [];
  }
  const lenses: ParsedLens[] = [];
  framingChoices.forEach((fc: unknown, i) => {
    const entry = fc as { frame?: unknown; why?: unknown } | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.frame !== 'string' || entry.frame.trim() === '') {
      warn(`framing_choices[${i}] has no frame; skipped`);
      return;
    }
    const why = typeof entry.why === 'string' && entry.why.trim() !== '' ? entry.why : undefined;
    lenses.push({ title: entry.frame, why });
  });
  return lenses;
}

const ATTACK_PREFIX = /^ATTACK(?:\s*\[([^\]]+)\])?:\s*/;

// A tag links a steelman only when it is in steelman_refs_offered; any other tag is dropped and logged.
function linkedSteelman(tag: string | undefined, offered: string[], ctx: SteelmanContext | undefined, warn: WarnFn, idx: number): { steelmanId?: string; steelman?: AttackSteelman } {
  if (!tag) return {};
  if (!offered.includes(tag)) {
    warn(`anticipated_challenges[${idx}] tag "${tag}" is not in steelman_refs_offered; not linked`);
    return {};
  }
  return { steelmanId: tag, steelman: ctx ? resolveSteelman(ctx, tag) : undefined };
}

export function parseWorkProduct(wp: Record<string, unknown>, warn: WarnFn = () => {}, ctx?: SteelmanContext): ParsedWorkProduct {
  const offered = Array.isArray(wp.steelman_refs_offered) ? (wp.steelman_refs_offered as unknown[]).map(String) : [];
  const claims: ParsedClaim[] = [];
  if (Array.isArray(wp.argument_structure)) {
    (wp.argument_structure as unknown[]).forEach((s, i) => {
      const entry = s as { point?: unknown; evidence?: unknown; taxonomy_anchor?: unknown } | null;
      if (typeof entry?.point !== 'string' || entry.point.trim() === '') {
        warn(`argument_structure[${i}] has no point; skipped`);
        return;
      }
      claims.push({
        index: claims.length + 1,
        point: entry.point,
        evidence: entry.evidence ? String(entry.evidence) : undefined,
        taxonomy_anchor: entry.taxonomy_anchor ? String(entry.taxonomy_anchor) : undefined,
      });
    });
  }

  const unmappedAttacks: ParsedAttack[] = [];
  const assumptions: ParsedAssumption[] = [];

  if (Array.isArray(wp.anticipated_challenges)) {
    (wp.anticipated_challenges as unknown[]).forEach((item, idx) => {
      const full = readAnticipatedItem(item);
      if (full === null) {
        warn(`anticipated_challenges[${idx}] has no readable text; skipped`);
        return;
      }
      const prefix = full.match(ATTACK_PREFIX);
      if (prefix) {
        const body = full.slice(prefix[0].length);
        const targetMatch = body.match(TARGET_PHRASE);
        const target = targetMatch ? cleanToken(targetMatch[1]) : undefined;
        const text = body.replace(TARGET_PHRASE, '').trim();
        if (text === '') {
          warn(`anticipated_challenges[${idx}] is an empty ATTACK; skipped`);
          return;
        }
        // A tag links a steelman only when it is in steelman_refs_offered; any other tag is dropped.
        const { steelmanId, steelman } = linkedSteelman(prefix[1]?.trim(), offered, ctx, warn, idx);
        const attack: ParsedAttack = { text, targetAnchor: target, steelmanId, steelman };
        const claim = findClaim(claims, target, body);
        if (claim && !claim.attack) {
          claim.attack = attack;
        } else {
          unmappedAttacks.push(attack);
        }
      } else if (full.startsWith('ASSUMPTION:')) {
        const text = full.replace(/^ASSUMPTION:\s*/, '').trim();
        if (text === '') {
          warn(`anticipated_challenges[${idx}] is an empty ASSUMPTION; skipped`);
          return;
        }
        assumptions.push({ text, tagged: true });
      } else {
        assumptions.push({ text: full, tagged: false });
      }
    });
  }

  const allAttacks = [...claims.map(c => c.attack), ...unmappedAttacks].filter((a): a is ParsedAttack => a !== undefined);
  const verifiedAttacks = allAttacks.filter(a => a.steelman && a.steelman.verdict !== 'unchecked').length;
  return { claims, unmappedAttacks, assumptions, verifiedAttacks };
}

export function stripLeadingVerb(text: string): string {
  const match = text.match(/^(Establish that |Argue that )/i);
  return match ? text.slice(match[0].length) : text;
}
