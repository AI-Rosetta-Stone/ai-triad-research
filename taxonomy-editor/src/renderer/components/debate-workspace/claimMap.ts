// t/331: pure data mapping for the How → Plan claim-map layout (no React).

export interface ParsedAttack {
  text: string;
  targetAnchor?: string; // the node the attack names, from "targeting node X"
  annotationId: string;
  verificationStatus?: string; // NLI verdict; undefined until a check has run (wiring: t/388)
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

export function parseWorkProduct(wp: Record<string, unknown>, warn: WarnFn = () => {}): ParsedWorkProduct {
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
      if (full.startsWith('ATTACK:')) {
        const body = full.replace(/^ATTACK:\s*/, '');
        const targetMatch = body.match(TARGET_PHRASE);
        const target = targetMatch ? cleanToken(targetMatch[1]) : undefined;
        const text = body.replace(TARGET_PHRASE, '').trim();
        if (text === '') {
          warn(`anticipated_challenges[${idx}] is an empty ATTACK; skipped`);
          return;
        }
        const attack: ParsedAttack = { text, targetAnchor: target, annotationId: `AN-${idx}` };
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

  return { claims, unmappedAttacks, assumptions };
}

export function stripLeadingVerb(text: string): string {
  const match = text.match(/^(Establish that |Argue that )/i);
  return match ? text.slice(match[0].length) : text;
}
