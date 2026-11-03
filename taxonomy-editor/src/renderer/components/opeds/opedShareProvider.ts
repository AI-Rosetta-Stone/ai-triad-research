// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4786: op-ed share provider for the location bar's ⧉ button. Wraps the SAME bridge calls
// as OpEdTab.tsx's ShareOpEdControl (api.shareOpEdSet/unshareOpEdSet) — not a new endpoint.
//
// `current()`: there's no server-side "is this shared" read endpoint (publishOpedShare's
// response is the only source of a shareId), so this is a session-scoped cache populated on a
// successful create(). A share from a PRIOR session won't be detected without calling
// create() again — safe because publishOpedShare is idempotent (reuses the existing shareId,
// never mints a duplicate; see opedShareStore.ts's own doc comment), just shows the
// confirmation once per session in that case. Noted on t/4786 for the TL.

import { api } from '@bridge';
import { registerShareProvider, type ShareProvider } from '../../navigation/shareProvider';

const sharedUrlBySetId = new Map<string, string>();

function shareUrl(shareId: string): string {
  return new URL(`/share/oped/${encodeURIComponent(shareId)}`, window.location.origin).href;
}

registerShareProvider('opeds', (place): ShareProvider | null => {
  const setId = place.placeKey.slice(place.placeKey.indexOf(':') + 1);
  if (!setId || setId === 'none') return null;

  return {
    label: 'Copy public link',
    needsConfirm: true,
    contentLabel: 'op-ed',
    current: () => Promise.resolve(sharedUrlBySetId.get(setId) ?? null),
    create: async () => {
      const { shareId } = await api.shareOpEdSet(setId);
      const url = shareUrl(shareId);
      sharedUrlBySetId.set(setId, url);
      return url;
    },
    revoke: async () => {
      await api.unshareOpEdSet(setId);
      sharedUrlBySetId.delete(setId);
    },
  };
});
