// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure helper: compute the model fingerprint for one debate run (t/4040).
 *
 * replicationGate reads only stored row fields (model_pool / model_api_id) and
 * never resolves against the current registry. That guarantees an apiModelId
 * repoint doesn't rewrite old rows' keys.
 */

import { getGlobalRecorder } from '../../flight-recorder/index.js';
import type { ModelRegistry } from '../../ai-client/registry.js';

/**
 * Build the ";st=…" suffix from explicit stage-model overrides (t/4127).
 * Returns "" when there are no overrides (fingerprint unchanged for default runs).
 */
function buildStageSuffix(registry: ModelRegistry, stageModels: Record<string, string>): string {
  const entries = Object.entries(stageModels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, registryId]) => {
      const entry = registry.models?.find(m => m.id === registryId);
      if (!entry?.apiModelId) {
        getGlobalRecorder()?.record({
          type: 'system.info',
          component: 'model-fingerprint',
          level: 'warn',
          message: `model-fingerprint: apiModelId missing for stage override stage=${stage} registryId=${registryId} — using registryId as key component`,
        });
      }
      return `${stage}=${registryId}:${entry?.apiModelId ?? registryId}`;
    });
  return entries.length > 0 ? `;st=${entries.join(',')}` : '';
}

/**
 * Compute the model fingerprint for one debate run.
 *
 * Multi-provider path (tier + eligible provided):
 *   Returns `model_pool = "tierName|b1=regId1:apiId1,b2=regId2:apiId2,…"` sorted.
 *   If `eligible` is absent: WARNs and returns {} (row goes to model-mixed bucket).
 *
 * Single-model path (tier undefined):
 *   Returns `model_api_id = "registryId:apiModelId"`.
 *
 * When `stageModels` is provided (explicit config-time overrides only, not the resolved
 * session map), appends ";st=stage=regId:apiId,…" sorted by stage name (t/4127).
 * No overrides → fingerprint is byte-identical to today.
 *
 * @param registry     Model registry at run time. If absent: WARNs and returns {}.
 * @param tier         modelTier for multi-provider runs; undefined for single-model runs.
 * @param eligible     Backend IDs eligible for this run (availableBackends ∩ tierMap).
 *                     Must be provided for multi-provider runs.
 * @param model        Base model registry ID (used for single-model fingerprint).
 * @param stageModels  Explicit stage-model overrides from config (t/4127). Only pass
 *                     entries that are explicitly set; omit undefined keys.
 */
export function computeModelFingerprint(
  registry: ModelRegistry | undefined,
  tier: string | undefined,
  eligible: string[] | undefined,
  model: string,
  stageModels?: Record<string, string>,
): { model_pool?: string; model_api_id?: string } {
  if (!registry) {
    getGlobalRecorder()?.record({
      type: 'system.info',
      component: 'model-fingerprint',
      level: 'warn',
      message: `model-fingerprint: registry absent for model=${model} — row will land in model-mixed bucket`,
    });
    return {};
  }

  const stageSuffix = stageModels && Object.keys(stageModels).length > 0
    ? buildStageSuffix(registry, stageModels)
    : '';

  if (tier !== undefined) {
    // Multi-provider path.
    if (!eligible) {
      getGlobalRecorder()?.record({
        type: 'system.info',
        component: 'model-fingerprint',
        level: 'warn',
        message: `model-fingerprint: modelTier=${tier} but eligibleBackends absent — row will land in model-mixed bucket; pass eligibleBackends from resolveMultiProviderModels`,
      });
      return {};
    }

    const tierMap = registry.debateTiers?.[tier];
    if (tierMap) {
      const entries = eligible
        .filter(backendId => Object.prototype.hasOwnProperty.call(tierMap, backendId))
        .map(backendId => {
          const registryId = tierMap[backendId];
          const entry = registry.models?.find(m => m.id === registryId);
          if (!entry?.apiModelId) {
            getGlobalRecorder()?.record({
              type: 'system.info',
              component: 'model-fingerprint',
              level: 'warn',
              message: `model-fingerprint: apiModelId missing for registryId=${registryId} (backend=${backendId}, tier=${tier}) — using registryId as key component`,
            });
          }
          return `${backendId}=${registryId}:${entry?.apiModelId ?? registryId}`;
        })
        .sort();

      if (entries.length > 0) {
        return { model_pool: `${tier}|${entries.join(',')}${stageSuffix}` };
      }

      getGlobalRecorder()?.record({
        type: 'system.info',
        component: 'model-fingerprint',
        level: 'warn',
        message: `model-fingerprint: no eligible backends found in tier=${tier} after filtering — row will land in model-mixed bucket`,
      });
      return {};
    }
  }

  // Single-model path.
  const entry = registry.models?.find(m => m.id === model);
  if (!entry?.apiModelId) {
    getGlobalRecorder()?.record({
      type: 'system.info',
      component: 'model-fingerprint',
      level: 'warn',
      message: `model-fingerprint: apiModelId missing for model=${model} — using registryId as key component`,
    });
  }
  return { model_api_id: `${model}:${entry?.apiModelId ?? model}${stageSuffix}` };
}
