// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4689: remembers which My/Community tab each tool's library page was last on. The tool's
// LibraryListPage instance unmounts whenever the user switches the rail tab away and back (App.tsx
// conditionally renders `{activeTab === 'chat' && <ChatTab/>}`), so a plain `useState` default
// resets on every return trip — the up-crumb would always land back on My even if the user had
// been reading Community. Module-scoped state (same pattern as `runningSignal.ts`'s `running`
// map) survives that remount within the session; it's a per-viewer convenience, not data that
// needs to persist across app restarts or be shared between viewers.

export type LibraryVariantKey = 'chat' | 'debate' | 'opeds' | 'inquiry';

const lastVariant = new Map<LibraryVariantKey, 'my' | 'community'>();

export function setLastVariant(tool: LibraryVariantKey, variant: 'my' | 'community'): void {
  lastVariant.set(tool, variant);
}

export function getLastVariant(tool: LibraryVariantKey): 'my' | 'community' | undefined {
  return lastVariant.get(tool);
}

/** Test-only: clears remembered state between tests. */
export function __resetLastVariantForTest(): void {
  lastVariant.clear();
}
