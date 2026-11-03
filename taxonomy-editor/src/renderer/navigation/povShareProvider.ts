// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4786: POV node share provider — static, no mint, no confirmation (the data is already
// public), no revoke. `placeOf.ts` resolves every camp AND `situations` to `tool: 'taxonomy'`
// (`taxonomy:<nodeId>`), so the only way to tell a POV node from a situation node here is the
// node id's own prefix — `acc-`/`saf-`/`skp-` for POV, `sit-` for situations (AGENTS.md's node
// id convention). Situations/policy are separate future exposures (t/1787), matching
// shareLinks.ts's existing v1 scope.

import { publicPovSharePath } from '../utils/shareLinks';
import { registerShareProvider, type ShareProvider } from './shareProvider';

const POV_NODE_ID = /^(acc|saf|skp)-/;

registerShareProvider('taxonomy', (place): ShareProvider | null => {
  const nodeId = place.placeKey.slice(place.placeKey.indexOf(':') + 1);
  if (!nodeId || nodeId === 'none' || !POV_NODE_ID.test(nodeId)) return null;
  const url = `${window.location.origin}${publicPovSharePath(nodeId)}`;
  return {
    label: 'Copy public link',
    needsConfirm: false,
    current: () => Promise.resolve(url),
    create: () => Promise.resolve(url),
  };
});
