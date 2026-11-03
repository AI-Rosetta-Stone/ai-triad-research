// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4786: share-provider registry for the location bar's ⧉ "copy public link" button.
// Registration, not a central switch (TL t/4786#2 point 1): each tool registers its own
// provider from its own module (OpEdTab.tsx, InquiryTab.tsx, …), so Chat and DebateUI add
// theirs later without editing this file.

import type { ReactNode } from 'react';
import type { PlaceInfo, PlaceTool } from './types';

export interface ShareProvider {
  label: string;
  /** User-generated content (op-ed, inquiry, chat, debate) confirms before first publish.
   *  False only for POV (already public, static path, no mint). */
  needsConfirm: boolean;
  /** Required when `needsConfirm` is true. Names what becomes public in the confirmation
   *  sentence: "Anyone with this link can view this {contentLabel}, without signing in." */
  contentLabel?: string;
  /** The existing public URL if this item is already shared, else null. Checked before
   *  deciding confirm-then-create vs. a direct copy (TL point 2: don't re-confirm or
   *  re-mint something already shared). */
  current(): Promise<string | null>;
  /** Mints (or returns, if already shared) the full public URL. MUST be idempotent — a
   *  second call returns the same link, never a second share (TL point 2). */
  create(): Promise<string>;
  /** Present only when a revoke control exists for this type. POV has none. */
  revoke?(): Promise<void>;
  /** A separate, confirmed action: mint a NEW link and turn the old one off. `create()` never
   *  does this on its own — on an already-shared item it always returns the same link (TL
   *  p/336#781). Present only when the type supports it (chat, t/4787). */
  replace?(): Promise<string>;
  /** Inquiry only (TL point 5): a richer preview in place of the generic confirm text, so
   *  the location bar isn't a less-informed way to publish. `onConfirm` proceeds with the
   *  normal create()+copy flow; `onCancel` returns to idle. */
  renderPreview?: (onConfirm: () => void, onCancel: () => void) => ReactNode;
}

type ShareProviderFactory = (place: PlaceInfo) => ShareProvider | null;

const registry = new Map<PlaceTool, ShareProviderFactory>();

export function registerShareProvider(tool: PlaceTool, factory: ShareProviderFactory): void {
  registry.set(tool, factory);
}

/** No provider means no button — never a disabled one (ticket point 2). */
export function getShareProvider(place: PlaceInfo): ShareProvider | null {
  return registry.get(place.tool)?.(place) ?? null;
}

/** Test-only: clears all registrations between tests. */
export function __resetShareProvidersForTest(): void {
  registry.clear();
}
