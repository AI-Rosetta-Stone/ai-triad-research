import os from 'os';
import { loadApiKey as _loadApiKey } from './apiKeyStore.js';
import { PROJECT_ROOT } from './fileIO.js';
import {
  refreshAIModels as _refreshAIModels,
  type RefreshResult,
  type ModelEntry,
  type AIModelsConfig,
  type ModelDiscoveryDeps,
} from '../../../lib/electron-shared/modelDiscovery.js';
import type { RefreshModelsRequestInput } from './ipc/refreshModelsRequestSchema.js';

export type { RefreshResult, ModelEntry, AIModelsConfig, ModelDiscoveryDeps };

/**
 * t/4161: `opts.accept` carries only what a person supplies (proposal, approvedBy,
 * reason) — the renderer bridge contract never lets the client say who it is. The
 * authenticated identity is HOST-SET (t/4160): on desktop, there is no separate
 * signed-in session distinct from the OS account (os.userInfo, mirrors
 * ipc/taxonomyHandlers.ts's review-pov-tag-proposal reviewedBy), so `principal` and
 * `osUser` are both the OS username.
 */
export async function refreshAIModels(opts: RefreshModelsRequestInput = {}): Promise<RefreshResult> {
  const osUser = os.userInfo().username;
  return _refreshAIModels({
    loadApiKey: (backend: string) => _loadApiKey(backend as Parameters<typeof _loadApiKey>[0]),
    repoRoot: PROJECT_ROOT,
  }, {
    dryRun: opts.dryRun,
    ...(opts.accept ? { accept: { ...opts.accept, principal: osUser, osUser } } : {}),
  });
}
