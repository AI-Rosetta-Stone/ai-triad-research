// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// NodeDetail's single admin "⋯" menu builder (t/4574, docs/ux/node-detail-redesign.md §2.2).
// Extracted from NodeDetail.tsx so the host file stays under its complexity/line-count
// baseline (ticket instruction: extract rather than raise the baseline).

import type { OverflowMenuEntry } from '../shared/OverflowMenu';

export interface MoveTarget {
  label: string;
  action: () => void;
  isTransfer?: boolean;
}

export interface RelocatedMenuItems {
  onSimilarSearch?: () => void;
  onOpenSoulDoc?: () => void;
  nodeId: string;
}

/** Builds the public share link for a node (t/4574 — "the real link builder", not just the id). */
function buildNodePublicLink(nodeId: string): string {
  return `${window.location.origin}/share/pov/${nodeId}`;
}

/** The four t/4559/t/4574 relocated items (Search taxonomy, BDI grounding, Copy link, Find
 *  similar), in spec order, for the top of the single admin "⋯" (spec §2.2). */
function relocatedMenuEntries({ onSimilarSearch, onOpenSoulDoc, nodeId }: RelocatedMenuItems): OverflowMenuEntry[] {
  return [
    { type: 'item', key: 'search', label: 'Search taxonomy', onClick: onSimilarSearch ?? (() => {}) },
    { type: 'item', key: 'bdi', label: 'BDI grounding', onClick: onOpenSoulDoc ?? (() => {}) },
    { type: 'item', key: 'copy', label: 'Copy link', onClick: () => void navigator.clipboard.writeText(buildNodePublicLink(nodeId)) },
    { type: 'item', key: 'similar', label: 'Find similar', onClick: onSimilarSearch ?? (() => {}) },
  ];
}

export function buildOverflowEntries(moveTargets: MoveTarget[], onDelete: () => void, onAIAnalysis: () => void, onPin: (() => void) | undefined, relocated: RelocatedMenuItems): OverflowMenuEntry[] {
  const entries: OverflowMenuEntry[] = [...relocatedMenuEntries(relocated), { type: 'divider' }];
  entries.push({ type: 'item', key: 'ai', label: 'AI Analysis', onClick: onAIAnalysis });
  if (onPin) entries.push({ type: 'item', key: 'pin', label: 'Pin for Comparison', onClick: onPin });

  const categoryMoves = moveTargets.filter(t => !t.isTransfer);
  const transfers = moveTargets.filter(t => t.isTransfer);

  entries.push({ type: 'divider' });
  for (const t of categoryMoves) {
    entries.push({ type: 'item', key: `move-${t.label}`, label: `Move to ${t.label}`, onClick: t.action });
  }
  if (transfers.length > 0) {
    entries.push({ type: 'divider' });
    entries.push({ type: 'label', text: 'Transfer to' });
    for (const t of transfers) {
      entries.push({ type: 'item', key: `xfer-${t.label}`, label: t.label, onClick: t.action, className: 'overflow-menu-transfer' });
    }
  }
  entries.push({ type: 'divider' });
  entries.push({ type: 'item', key: 'delete', label: 'Delete', onClick: onDelete, danger: true });
  return entries;
}

/** Read-only surfaces (e.g. a pinned comparison) get the relocated items plus Pin, no edit actions. */
export function buildReadOnlyOverflowEntries(relocated: RelocatedMenuItems, onPin?: () => void): OverflowMenuEntry[] {
  const entries = relocatedMenuEntries(relocated);
  if (onPin) {
    entries.push({ type: 'divider' });
    entries.push({ type: 'item', key: 'pin', label: 'Pin for Comparison', onClick: onPin });
  }
  return entries;
}
