// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4726: one shared builder for the fact-check transcript entry's markdown content, used by
// both sites that assemble one (argumentNetwork.ts's inline fact check, synthesisSlice.ts's
// selected-text fact check) so they can't drift apart on format again.

/** Escapes markdown emphasis characters (`*`, `_`) and a literal backslash, so a claim
 *  containing them doesn't break out of the `*"..."*` wrapper or itself turn bold/italic.
 *  Trims the claim first — edge whitespace inside the quote marks looks wrong either way. */
export function escapeMarkdownEmphasis(text: string): string {
  return text.trim().replace(/[\\*_]/g, '\\$&');
}

/** The fact-check transcript entry's markdown `content` string. The quoted claim renders in
 *  italics (`*"..."*`) per the PI request (t/4726). t/766 (docs/ux/debate-fact-check-card.md §5):
 *  no `**Fact Check: {Label}**` title line and no web note; the card shows the verdict and the
 *  web-search state from `metadata.fact_check`, so `content` is the claim and the explanation. */
export function formatFactCheckContent(claim: string, explanation: string): string {
  return `*"${escapeMarkdownEmphasis(claim)}"*

${explanation}`;
}
