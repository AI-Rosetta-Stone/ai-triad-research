// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { DebateStore } from '../types';
import type { DebateAudience, SpeakerId, GapInjection, CrossCuttingProposal, TaxonomyGapAnalysis } from '../../../types/debate';
import type { StandardizedTerm, ColloquialTerm } from '@lib/dictionary/types';
import type { EntityRef } from '@lib/entities/types';
import type { ReflectionResult } from '../types';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { trackDebateAbandon } from '../../../lib/analyticsEmitter';
import { cancelAndResetAbort } from '../shared/guards';

export interface ConfigSlice {
  // Generation state
  debateGenerating: SpeakerId | null;
  debateGeneratingStartedAt: number | null;
  debateStepStartedAt: number | null;
  debateError: string | null;
  debateProgress: { attempt: number; maxRetries: number; backoffSeconds?: number; limitType?: string; limitMessage?: string; phase?: string } | null;
  debateActivity: string | null;

  // Config
  responseLength: 'claims' | 'brief' | 'medium' | 'detailed' | 'reasoning' | 'convergence' | 'why';
  // Default *display* tier for debate steps, decoupled from responseLength (t/2269, TL Option 2).
  // responseLength shapes generation verbosity (the `length` arg into the debater prompts, so it
  // sets how much the model writes); this only sets the view fallback — StatementCard renders
  // `entry.display_tier ?? defaultDisplayTier`. Kept separate so the default view can be Medium
  // without shortening what gets generated (which would make the Detailed tier no longer detailed).
  // Unpersisted, like responseLength.
  defaultDisplayTier: 'claims' | 'brief' | 'medium' | 'detailed' | 'reasoning' | 'convergence' | 'why';
  audience: DebateAudience;
  debateModel: string | null;
  debateTemperature: number | null;
  vocabularyTerms: { standardized: StandardizedTerm[]; colloquial: ColloquialTerm[] } | null;

  // Opening config
  openingOrder: Exclude<SpeakerId, 'user'>[];
  initialCrossRespondRounds: number;

  // Diagnostics
  diagnosticsEnabled: boolean;
  selectedDiagEntry: string | null;
  diagPopoutOpen: boolean;
  debateWarnings: string[];

  // Inspection
  inspectedNodeId: string | null;

  // Selected reference → right-hand DetailPane (t/1776). null = pane closed.
  selectedRef: EntityRef | null;

  // Gap analysis
  gapInjections: GapInjection[];
  crossCuttingProposals: CrossCuttingProposal[];
  taxonomyGapAnalysis: TaxonomyGapAnalysis | null;

  // Reflections
  reflections: ReflectionResult[];
  // Per-proposal disposition for propose_new items, keyed `${pover}#${proposalIndex}`.
  // Absent = pending (t/1773). Replaces the retired add-consensus clustering (ruling B).
  newItemProposalStatus: Record<string, 'approved' | 'dismissed'>;

  // Enrichment tracking — real-time status for in-session UI feedback
  enrichmentStatus: Record<string, { status: 'pending' | 'success' | 'error'; error?: string }>;

  // Community read-only mode (viewing a shared debate without copying)
  communityReadOnly: boolean;

  // Daily limit pause state
  dailyLimitPaused: boolean;

  // Remote driver state — true when another window (popout) holds the debate driver lock
  driverIsRemote: boolean;

  // News
  newsReport: string | null;
  newsReportLoading: boolean;
  newsReportError: string | null;

  // Actions
  setResponseLength: (length: 'claims' | 'brief' | 'medium' | 'detailed' | 'reasoning' | 'convergence' | 'why') => void;
  setDefaultDisplayTier: (tier: 'claims' | 'brief' | 'medium' | 'detailed' | 'reasoning' | 'convergence' | 'why') => void;
  setAudience: (audience: DebateAudience) => void;
  setEntryDisplayTier: (entryId: string, tier: 'claims' | 'brief' | 'medium' | 'detailed' | 'reasoning' | 'convergence' | 'why' | 'terms' | 'lineage' | undefined) => void;
  setOpeningOrder: (order: Exclude<SpeakerId, 'user'>[]) => void;
  setInitialCrossRespondRounds: (n: number) => void;
  clearWarnings: () => void;
  cancelDebate: () => void;
  toggleDiagnostics: () => void;
  selectDiagEntry: (entryId: string | null, force?: boolean) => void;
  setDiagPopoutOpen: (open: boolean) => void;
  inspectNode: (nodeId: string | null) => void;
  setSelectedRef: (ref: EntityRef | null) => void;
  setGenerating: (pover: SpeakerId | null) => void;
  setError: (error: string | null) => void;
  debateRetryAction: string | null;
  setErrorWithRetry: (error: string, retryAction: string) => void;
}

export const createConfigSlice: StateCreator<DebateStore, [], [], ConfigSlice> = (set, get) => ({
  debateGenerating: null,
  debateGeneratingStartedAt: null,
  debateStepStartedAt: null,
  debateError: null,
  debateProgress: null,
  debateActivity: null,
  responseLength: 'detailed',
  defaultDisplayTier: 'medium',
  audience: 'policymakers' as DebateAudience,
  debateModel: null,
  debateTemperature: null,
  vocabularyTerms: null,
  openingOrder: [],
  initialCrossRespondRounds: 3,
  diagnosticsEnabled: false,
  selectedDiagEntry: null,
  diagPopoutOpen: false,
  debateWarnings: [],
  inspectedNodeId: null,
  selectedRef: null,
  gapInjections: [],
  crossCuttingProposals: [],
  taxonomyGapAnalysis: null,
  reflections: [],
  newItemProposalStatus: {},
  enrichmentStatus: {},
  communityReadOnly: false,
  dailyLimitPaused: false,
  driverIsRemote: false,
  debateRetryAction: null,
  newsReport: null,
  newsReportLoading: false,
  newsReportError: null,

  setResponseLength: (length) => {
    set({ responseLength: length });
    const debate = get().activeDebate;
    if (debate) {
      let changed = false;
      for (const entry of debate.transcript) {
        if (entry.display_tier) {
          entry.display_tier = undefined;
          changed = true;
        }
      }
      if (changed) set({ activeDebate: { ...debate } });
    }
  },
  // Sets the default *display* tier for statements (the header Text/Analysis control,
  // t/2269) — distinct from responseLength (generation verbosity). Clears per-entry
  // display_tier overrides so every statement snaps to the new default, mirroring
  // setResponseLength. StatementCard renders `entry.display_tier ?? defaultDisplayTier`.
  setDefaultDisplayTier: (tier) => {
    set({ defaultDisplayTier: tier });
    const debate = get().activeDebate;
    if (debate) {
      let changed = false;
      for (const entry of debate.transcript) {
        if (entry.display_tier) {
          entry.display_tier = undefined;
          changed = true;
        }
      }
      if (changed) set({ activeDebate: { ...debate } });
    }
  },
  setAudience: (audience) => {
    set({ audience });
    const debate = get().activeDebate;
    if (debate) {
      debate.audience = audience;
      set({ activeDebate: { ...debate } });
    }
  },
  setEntryDisplayTier: (entryId, tier) => {
    const debate = get().activeDebate;
    if (!debate) return;
    const entry = debate.transcript.find(e => e.id === entryId);
    if (!entry) return;
    entry.display_tier = tier;
    set({ activeDebate: { ...debate } });
  },
  setOpeningOrder: (order) => set({ openingOrder: order }),
  setInitialCrossRespondRounds: (n) => set({ initialCrossRespondRounds: n }),
  clearWarnings: () => set({ debateWarnings: [] }),
  cancelDebate: () => {
    const debateId = get().activeDebateId;
    cancelAndResetAbort();
    set({ debateGenerating: null, debateGeneratingStartedAt: null, debateStepStartedAt: null, debateActivity: null });
    if (debateId) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: debateId, message: 'debate.ended', data: { reason: 'cancelled' } });
      trackDebateAbandon(debateId, 'cancelled');
    }
  },
  toggleDiagnostics: () => {
    const enabled = !get().diagnosticsEnabled;
    set({ diagnosticsEnabled: enabled });
    if (enabled && get().activeDebate && !get().activeDebate!.diagnostics) {
      const updated = {
        ...get().activeDebate!,
        diagnostics: {
          enabled: true,
          entries: {},
          overview: { total_ai_calls: 0, total_response_time_ms: 0, claims_accepted: 0, claims_rejected: 0, move_type_counts: {}, disagreement_type_counts: {} },
        },
      };
      set({ activeDebate: updated });
    }
    if (enabled) {
      void api.openDiagnosticsWindow().then(() => {
        set({ diagPopoutOpen: true });
        setTimeout(() => {
          api.sendDiagnosticsState({ debate: get().activeDebate, selectedEntry: get().selectedDiagEntry });
        }, 1000);
      }).catch((err) => { getGlobalRecorder()?.record({ type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Failed to open diagnostics window', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });
    } else {
      try { void api.closeDiagnosticsWindow?.(); } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Failed to close diagnostics window', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
      set({ diagPopoutOpen: false });
    }
  },
  selectDiagEntry: (entryId, force) => {
    set({ selectedDiagEntry: entryId });
    try {
      const debate = get().activeDebate;
      api.sendDiagnosticsState({ debate, selectedEntry: entryId, forceSelect: !!force });
    } catch (e) { const _debate = get().activeDebate; getGlobalRecorder()?.record({ type: 'system.error', debate_id: _debate?.id, component: 'debate-store', level: 'warn', message: 'Diagnostics state broadcast to popout failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
  },
  setDiagPopoutOpen: (open) => set({ diagPopoutOpen: open }),
  inspectNode: (nodeId) => set({ inspectedNodeId: nodeId }),
  setSelectedRef: (ref) => set({ selectedRef: ref }),
  setGenerating: (pover) => {
    const { debateStepStartedAt } = get();
    set({
      debateGenerating: pover,
      debateGeneratingStartedAt: pover !== null ? Date.now() : null,
      // Step-scoped timer: set once when a step begins, cleared when it ends.
      // Per-phase generateTextWithProgress calls don't reset this.
      debateStepStartedAt: pover !== null ? (debateStepStartedAt ?? Date.now()) : null,
    });
  },
  setError: (error) => set({ debateError: error, debateRetryAction: error ? get().debateRetryAction : null, dailyLimitPaused: error ? get().dailyLimitPaused : false }),
  setErrorWithRetry: (error, retryAction) => set({ debateError: error, debateRetryAction: retryAction }),
});
