// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4044 (t/4040 SO conditions e/268#4 item 3, e/265#30): through the REAL creation path into
// extractCalibrationData and replicationSet, with the real eligibleDebateBackends and
// resolveMultiProviderModels. No hand-built eligible lists.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { setLiveModelRegistry, STAGE_DEFAULT_SPEAKER_TOKEN } from '../shared/sessionFingerprint';
import { eligibleDebateBackends, resolveMultiProviderModels } from '@lib/ai-client/modelRouter';
import { computeModelFingerprint } from '@lib/debate/debateEngine/modelFingerprint';
import type { ModelRegistry } from '@lib/ai-client/registry';
import { extractCalibrationData } from '@lib/debate/calibrationLogger/extract';
import { replicationSet, fixedConfigKey } from '@lib/debate/calibrationLogger/replicationGate';
import type { CalibrationDataPoint } from '@lib/debate/calibrationLogger/schema';
import type { DebateSession } from '@lib/debate/types';
import aiModels from '../../../../../../ai-models.json';

const registry = aiModels as unknown as ModelRegistry;
const AI_SEATS = ['accelerationist', 'safetyist', 'skeptic'] as const;
const BACKENDS = ['gemini', 'claude', 'groq'];
const BASE_MODEL = registry.debateTiers!.basic.gemini;

async function create(options?: Record<string, unknown>): Promise<DebateSession> {
  await useDebateStore.getState().createDebate('Should frontier labs pause?', [...AI_SEATS], false, 'topic', '', '', BASE_MODEL, undefined, undefined, undefined, options);
  return useDebateStore.getState().activeDebate as DebateSession;
}

/** The logger stamps working_tree_state after extraction; emulate a clean tree so the only exclusion reason left is failover_tracking. */
function cleanRow(session: DebateSession): CalibrationDataPoint {
  return { ...extractCalibrationData(session, 'test'), working_tree_state: 'clean' };
}

// File-scoped: lets the not-loaded arm assert the fallback WARN. createDebate also calls setEventContext.
const { mockRecord } = vi.hoisted(() => ({ mockRecord: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord, setEventContext: vi.fn() }) }));

beforeEach(() => { mockRecord.mockClear(); setLiveModelRegistry(registry); });

describe('renderer session fingerprint (t/4044)', () => {
  it('multi-provider: non-empty model_pool + initial_speaker_models, survives extraction, excluded as unavailable', async () => {
    const eligibleBackends = eligibleDebateBackends('advanced', BACKENDS, registry);
    const speakerModels = resolveMultiProviderModels('advanced', BACKENDS, [...AI_SEATS], registry);
    expect(eligibleBackends.length).toBeGreaterThan(0);

    const session = await create({ speakerModels, modelTier: 'advanced', eligibleBackends });
    expect(session.model_pool).toMatch(/^advanced\|.+=.+:.+/);
    for (const b of eligibleBackends) expect(session.model_pool).toContain(`${b}=${registry.debateTiers!.advanced[b]}:`);
    expect(session.model_api_id).toBeUndefined();
    expect(session.initial_speaker_models).toEqual(speakerModels);
    expect(session.failover_tracking).toBe('unavailable');

    const row = cleanRow(session);
    expect(row.model_pool).toBe(session.model_pool);
    expect(row.failover_tracking).toBe('unavailable');
    expect(replicationSet([row], fixedConfigKey(row))).toEqual([]);
    // Control: the same row claiming 'tracked' IS counted, so the exclusion is the tracking claim alone.
    const tracked = { ...row, failover_tracking: 'tracked' as const };
    expect(replicationSet([tracked], fixedConfigKey(tracked))).toEqual([tracked]);
  });

  it('single-model: model_api_id = registryId:apiModelId, no pool, still unavailable', async () => {
    const session = await create();
    const apiModelId = registry.models.find(m => m.id === BASE_MODEL)!.apiModelId;
    expect(session.model_api_id).toBe(`${BASE_MODEL}:${apiModelId}`);
    expect(session.model_pool).toBeUndefined();
    expect(session.initial_speaker_models).toBeUndefined();
    const row = cleanRow(session);
    expect(row.model_api_id).toBe(session.model_api_id);
    expect(replicationSet([row], fixedConfigKey(row))).toEqual([]);
  });

  it('is computed at creation: a re-save after a registry repoint keeps the original key', async () => {
    const session = await create();
    const original = session.model_api_id;
    setLiveModelRegistry({ ...registry, models: registry.models.map(m => (m.id === BASE_MODEL ? { ...m, apiModelId: 'repointed' } : m)) });
    await useDebateStore.getState().saveDebate();
    const saved = mockApi.saveDebateSession.mock.calls.at(-1)![0] as DebateSession;
    expect(saved.model_api_id).toBe(original);
    expect(saved.model_api_id).not.toContain('repointed');
  });

  it('live registry not loaded: NO fingerprint fields, a WARN, still unavailable, and the row is excluded (CL e/268#17, SO e/268#19)', async () => {
    setLiveModelRegistry(null);
    const eligibleBackends = eligibleDebateBackends('advanced', BACKENDS, registry);
    const speakerModels = resolveMultiProviderModels('advanced', BACKENDS, [...AI_SEATS], registry);
    const session = await create({ speakerModels, modelTier: 'advanced', eligibleBackends });
    expect(session.model_pool).toBeUndefined();
    expect(session.model_api_id).toBeUndefined();
    expect(session.initial_speaker_models).toEqual(speakerModels);
    expect(session.failover_tracking).toBe('unavailable');
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('live model registry not loaded') }));
    const row = cleanRow(session);
    expect(row.failover_tracking).toBe('unavailable');
    // An explicit 'unavailable' is excluded whether or not the row is fingerprinted (SO e/268#19 condition 2).
    expect(replicationSet([row], fixedConfigKey(row))).toEqual([]);
  });
});

// t/4128 (design t/4098 #1-#2, CL): stage-model overrides and the multi-provider stage-default token, through
// the real createDebate path. Byte-identity with the engine half (t/4127) is proven by comparing against the
// engine's own computeModelFingerprint on the same live registry and config.
describe('renderer session fingerprint: stage overrides and stage-default token (t/4128)', () => {
  const OVERRIDE_A = registry.debateTiers!.basic.claude;
  const OVERRIDE_B = registry.debateTiers!.basic.groq;
  const multiProvider = () => ({
    eligibleBackends: eligibleDebateBackends('advanced', BACKENDS, registry),
    speakerModels: resolveMultiProviderModels('advanced', BACKENDS, [...AI_SEATS], registry),
    modelTier: 'advanced' as const,
  });
  const engine = (stageModels?: Record<string, string>, mp?: ReturnType<typeof multiProvider>) =>
    computeModelFingerprint(registry, mp?.modelTier, mp?.eligibleBackends, BASE_MODEL, stageModels);

  it('single-model, no overrides: byte-identical to the pre-t/4128 key', async () => {
    const apiModelId = registry.models.find(m => m.id === BASE_MODEL)!.apiModelId;
    const session = await create();
    expect(session.model_api_id).toBe(`${BASE_MODEL}:${apiModelId}`);
    expect(session.model_api_id).not.toContain(';');
  });

  it('multi-provider, no overrides: the pool string plus ";sd=speaker"', async () => {
    const mp = multiProvider();
    const session = await create(mp);
    expect(session.model_pool).toBe(`${engine(undefined, mp).model_pool}${STAGE_DEFAULT_SPEAKER_TOKEN}`);
    expect(STAGE_DEFAULT_SPEAKER_TOKEN).toBe(';sd=speaker');
  });

  it('one stage overridden (single-model): the suffix appears and matches the engine byte for byte', async () => {
    const session = await create({ stageModels: { brief: OVERRIDE_A } });
    expect(session.model_api_id).toBe(engine({ brief: OVERRIDE_A }).model_api_id);
    expect(session.model_api_id).toContain(`;st=brief=${OVERRIDE_A}:`);
    expect(session.model_api_id).not.toContain('|');
  });

  it('multi-provider with an override: engine pool + stage suffix, then ";sd=speaker" last', async () => {
    const mp = multiProvider();
    const session = await create({ ...mp, stageModels: { cite: OVERRIDE_B } });
    expect(session.model_pool).toBe(`${engine({ cite: OVERRIDE_B }, mp).model_pool}${STAGE_DEFAULT_SPEAKER_TOKEN}`);
    expect(session.model_pool!.endsWith(`;st=cite=${OVERRIDE_B}:${registry.models.find(m => m.id === OVERRIDE_B)!.apiModelId};sd=speaker`)).toBe(true);
  });

  it('overrides given in a different order produce the same string', async () => {
    const a = await create({ stageModels: { plan: OVERRIDE_B, brief: OVERRIDE_A } });
    const b = await create({ stageModels: { brief: OVERRIDE_A, plan: OVERRIDE_B } });
    expect(a.model_api_id).toBe(b.model_api_id);
    expect(a.model_api_id).toContain(`;st=brief=${OVERRIDE_A}:`);
  });

  it('unset dialog stages (empty strings) are dropped: brief set, plan and cite empty names brief only (CL t/4128#1)', async () => {
    const session = await create({ stageModels: { brief: OVERRIDE_A, plan: '', cite: '' } });
    expect(session.model_api_id).toBe(engine({ brief: OVERRIDE_A }).model_api_id);
    expect(session.model_api_id).not.toMatch(/plan=|cite=|=:/);
  });

  it('all dialog stages empty: no suffix at all, so default runs keep their group', async () => {
    const session = await create({ stageModels: { brief: '', plan: '', cite: '' } });
    expect(session.model_api_id).toBe(engine().model_api_id);
    expect(session.model_api_id).not.toContain(';st=');
  });
});
