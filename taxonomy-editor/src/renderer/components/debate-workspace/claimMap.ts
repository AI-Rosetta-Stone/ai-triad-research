// t/331: pure data mapping for the How → Plan claim-map layout (no React).

export interface ParsedAttack {
  text: string;
  targetAnchor?: string; // the node the attack names, from "targeting node X"
  annotationId: string;
  verificationStatus?: string; // NLI verdict; undefined until a check has run
}

export interface ParsedClaim {
  index: number; // 1-based, matches the C{n} badge
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
  verifiedAttacks: number;
}

// t/3418: anticipated_challenges/anticipated_responses migrated object → tagged-string
// (t/3404, PR #2093), but debates persisted under the old schema still have
// {challenge, type} objects — rendering one directly is React error #31.
export function normalizeAnticipatedItem(r: unknown): string {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && 'challenge' in r) {
    const { challenge, type } = r as { challenge: unknown; type?: unknown };
    return `${type ? `${String(type)}: ` : ''}${String(challenge)}`;
  }
  return String(r);
}

const TARGET_PHRASE = /\s*targeting node (\S+)$/;

function tokensOf(text: string): string[] {
  return text.split(/\s+/).map(t => t.replace(/[.,;:()"']+$/, ''));
}

export function parseWorkProduct(wp: Record<string, unknown>): ParsedWorkProduct {
  const claims: ParsedClaim[] = Array.isArray(wp.argument_structure)
    ? (wp.argument_structure as { point?: unknown; evidence?: unknown; taxonomy_anchor?: unknown }[]).map((s, i) => ({
      index: i + 1,
      point: String(s?.point ?? ''),
      evidence: s?.evidence ? String(s.evidence) : undefined,
      taxonomy_anchor: s?.taxonomy_anchor ? String(s.taxonomy_anchor) : undefined,
    }))
    : [];

  const unmappedAttacks: ParsedAttack[] = [];
  const assumptions: ParsedAssumption[] = [];

  if (Array.isArray(wp.anticipated_challenges)) {
    (wp.anticipated_challenges as unknown[]).forEach((item, idx) => {
      const full = normalizeAnticipatedItem(item);
      if (full.startsWith('ATTACK:')) {
        const body = full.replace(/^ATTACK:\s*/, '');
        const target = body.match(TARGET_PHRASE)?.[1];
        const attack: ParsedAttack = {
          text: body.replace(TARGET_PHRASE, ''),
          targetAnchor: target,
          annotationId: `AN-${idx}`,
        };
        // Prefer the node the attack names; otherwise match a whole token of the text, never a substring.
        const tokens = tokensOf(body);
        const claim = claims.find(c =>
          c.taxonomy_anchor !== undefined && (target === c.taxonomy_anchor || tokens.includes(c.taxonomy_anchor))
        );
        if (claim && !claim.attack) {
          claim.attack = attack;
        } else {
          unmappedAttacks.push(attack);
        }
      } else if (full.startsWith('ASSUMPTION:')) {
        assumptions.push({ text: full.replace(/^ASSUMPTION:\s*/, ''), tagged: true });
      } else {
        assumptions.push({ text: full, tagged: false });
      }
    });
  }

  const verifiedAttacks = [...claims.map(c => c.attack), ...unmappedAttacks]
    .filter((a): a is ParsedAttack => a !== undefined && a.verificationStatus !== undefined && a.verificationStatus !== 'not yet checked')
    .length;

  return { claims, unmappedAttacks, assumptions, verifiedAttacks };
}

export function stripLeadingVerb(text: string): string {
  const match = text.match(/^(Establish that |Argue that )/i);
  return match ? text.slice(match[0].length) : text;
}
