// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: attack anchors. A plan's ATTACK may end with "targeting node <anchor>", naming the
// taxonomy_anchor of the speaker's own claim that the attack hits. The claim-map card reads that
// phrase to put the attack beside its claim. The engine keeps the phrase only when the anchor is
// one of the plan's own argument_structure anchors; any other anchor is removed, with a WARN.

import type { OpeningPlanWorkProduct } from '../types/pipeline.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';

/** The phrase at the very end of a challenge. Group 1 is the anchor token. */
const ANCHOR_PHRASE = /\s*targeting node (\S+)$/;

/** The taxonomy anchors of a plan's own claims. */
export function planClaimAnchors(plan: Pick<OpeningPlanWorkProduct, 'argument_structure'> | undefined): Set<string> {
  const anchors = new Set<string>();
  const claims = Array.isArray(plan?.argument_structure) ? plan.argument_structure : [];
  for (const c of claims) {
    const a = typeof c?.taxonomy_anchor === 'string' ? c.taxonomy_anchor.trim() : '';
    if (a) anchors.add(a);
  }
  return anchors;
}

/** The anchor phrase to append for a valid anchor. */
export function anchorPhrase(anchor: string): string {
  return ` targeting node ${anchor}`;
}

/** A token as an anchor: itself, or itself without trailing punctuation, when either is a claim anchor. */
function matchAnchor(token: string, anchors: ReadonlySet<string>): string | undefined {
  if (anchors.has(token)) return token;
  const bare = token.replace(/[.,;:!?)\]"']+$/, '');
  return bare !== token && anchors.has(bare) ? bare : undefined;
}

/**
 * Check the anchor phrase on each ATTACK. A phrase whose anchor is one of the plan's own claim
 * anchors is kept, in the exact form the card reads. Any other is removed and a WARN names it.
 * A challenge with no phrase is left alone.
 */
export function verifyAttackAnchors(plan: OpeningPlanWorkProduct | undefined, debateId?: string): void {
  if (!plan || !Array.isArray(plan.anticipated_challenges)) return;
  const anchors = planClaimAnchors(plan);
  plan.anticipated_challenges = plan.anticipated_challenges.map(c => {
    const m = typeof c === 'string' ? ANCHOR_PHRASE.exec(c) : null;
    if (!m) return c;
    const body = c.slice(0, m.index);
    const anchor = matchAnchor(m[1], anchors);
    if (anchor) return body + anchorPhrase(anchor);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `plan challenge anchor "${m[1].slice(0, 60)}" is not a taxonomy_anchor of this plan's claims; phrase removed (t/388)`,
      data: { anchor: m[1].slice(0, 120), plan_anchors: [...anchors] },
    });
    return body;
  });
}

/** A challenge without its anchor phrase, for the prompts of later stages. */
export function withoutAnchorPhrase(challenge: string): string {
  return challenge.replace(ANCHOR_PHRASE, '');
}
