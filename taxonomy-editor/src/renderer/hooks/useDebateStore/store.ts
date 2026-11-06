// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import type { DebateStore } from './types';
import { createConfigSlice } from './slices/configSlice';
import { createSessionSlice } from './slices/sessionSlice';
import { createTopicCritiqueSlice } from './slices/topicCritiqueSlice';
import { createClarificationSlice } from './slices/clarificationSlice';
import { createArgumentNetworkSlice } from './slices/argumentNetworkSlice';
import { createSynthesisSlice } from './slices/synthesisSlice';
import { createDebateLoopSlice } from './slices/debateLoopSlice';
import { createDebatePhaseSlice } from './slices/debatePhaseSlice';
import { createRunLeaseSlice } from './slices/runLeaseSlice';
import { createDebateReflectionSlice } from './slices/debateReflectionSlice';
import { createExplorationSlice } from './slices/explorationSlice';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { api } from '@bridge';
import { PHASE_ORDER } from './shared/phaseOrder';

/** t/4905: actions that start AI generation. A read-only community debate is someone else's —
 *  saves are already blocked, so a run would bill the viewer and then be thrown away. */
export const COMMUNITY_READ_ONLY_BLOCKED_ACTIONS = [
  'askQuestion', 'beginDebate', 'compressOldTranscript', 'crossRespond', 'factCheckSelection',
  'generateNewsReport', 'reEvaluateSuggestedTopic', 'reExtractClaims', 'requestProbingQuestions',
  'requestReflections', 'requestSynthesis', 'retryEnrichment', 'retryReflectionEditAfterFix',
  'runClarification', 'runOpeningStatements', 'runTopicCritique', 'submitAnswersAndSynthesize',
  'submitUserOpening',
] as const satisfies readonly (keyof DebateStore)[];

function guardCommunityReadOnly(store: DebateStore, get: () => DebateStore): DebateStore {
  const guarded = { ...store } as Record<string, unknown>;
  for (const name of COMMUNITY_READ_ONLY_BLOCKED_ACTIONS) {
    const action = store[name] as unknown as (...args: unknown[]) => unknown;
    guarded[name] = (...args: unknown[]) => {
      if (!get().communityReadOnly) return action(...args);
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-store', level: 'warn',
        debate_id: get().activeDebateId ?? undefined,
        message: `WARN: blocked ${name} on a read-only community debate (fallback: no generation)`,
      });
      return Promise.resolve(undefined);
    };
  }
  return guarded as unknown as DebateStore;
}

export const useDebateStore = create<DebateStore>()((...a) => guardCommunityReadOnly({
  ...createConfigSlice(...a),
  ...createSessionSlice(...a),
  ...createTopicCritiqueSlice(...a),
  ...createClarificationSlice(...a),
  ...createArgumentNetworkSlice(...a),
  ...createSynthesisSlice(...a),
  ...createDebateLoopSlice(...a),
  ...createDebatePhaseSlice(...a),
  ...createRunLeaseSlice(...a),
  ...createDebateReflectionSlice(...a),
  ...createExplorationSlice(...a),
}, a[1]));

((window as unknown as { __ZUSTAND_STORES__?: Record<string, unknown> }).__ZUSTAND_STORES__ ??= {} as Record<string, unknown>).debate = useDebateStore;

const ACTIVE_DEBATE_KEY = 'activeDebateId';

export function initDebateSessions(): void {
  void useDebateStore.getState().loadSessions().then(() => {
    const stored = sessionStorage.getItem(ACTIVE_DEBATE_KEY);
    if (stored && !useDebateStore.getState().activeDebateId) {
      void useDebateStore.getState().loadDebate(stored);
    }
  });
}

// Persist activeDebateId to sessionStorage so page refresh can resume
useDebateStore.subscribe(
  (state, prev) => {
    if (state.activeDebateId === prev.activeDebateId) return;
    if (state.activeDebateId) {
      sessionStorage.setItem(ACTIVE_DEBATE_KEY, state.activeDebateId);
    } else {
      sessionStorage.removeItem(ACTIVE_DEBATE_KEY);
    }
  },
);

// Debounced auto-save: persist in-progress debate after transcript/state changes settle
let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DEBOUNCE_MS = 3000;

useDebateStore.subscribe(
  (state, prev) => {
    if (!state.activeDebate || state.activeDebate === prev.activeDebate) return;
    if (state.communityReadOnly) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
      _autoSaveTimer = null;
      void useDebateStore.getState().saveDebate('auto-save');
    }, AUTO_SAVE_DEBOUNCE_MS);
  },
);

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const state = useDebateStore.getState();
    if (!state.activeDebate) return;
    const recorder = getGlobalRecorder();

    const isGenerating = !!state.debateGenerating;
    recorder?.record({
      type: 'lifecycle',
      component: 'debate-store',
      level: 'warn',
      debate_id: state.activeDebateId ?? undefined,
      message: 'Window closed with active debate',
      data: {
        phase: state.activeDebate.phase,
        transcript_length: state.activeDebate.transcript?.length ?? 0,
        is_generating: isGenerating,
        generating_speaker: state.debateGenerating ?? null,
        an_nodes: state.activeDebate.argument_network?.nodes?.length ?? 0,
      },
    });

    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);

    if (isGenerating) {
      const round = state.activeDebate.transcript.filter(e => e.type === 'statement').length + 1;
      const session = {
        ...state.activeDebate,
        interrupted_turn: {
          speaker: state.debateGenerating!,
          phase: state.activeDebate.adaptive_staging?.phase_state?.current_phase ?? state.activeDebate.phase,
          round,
          timestamp: new Date().toISOString(),
        },
      };
      void api.saveDebateSession(session, 'beforeunload:interrupted-turn');
    } else {
      void api.saveDebateSession(state.activeDebate, 'beforeunload');
    }
  });
}

// State-clobber detection (t/194). PHASE_ORDER is shared with the t/2326 load-guard
// (sessionSlice.loadDebate) via ./shared/phaseOrder so both guards order phases
// identically.
useDebateStore.subscribe((state, prev) => {
  const curr = state.activeDebate;
  const old = prev.activeDebate;
  if (!curr || !old || curr.id !== old.id) return;

  const currPhaseIdx = PHASE_ORDER[curr.phase] ?? -1;
  const oldPhaseIdx = PHASE_ORDER[old.phase] ?? -1;
  if (currPhaseIdx >= 0 && oldPhaseIdx >= 0 && currPhaseIdx < oldPhaseIdx) {
    console.error(`[STATE-GUARD] Phase regression: ${old.phase} → ${curr.phase}`);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'state-guard', level: 'error',
      debate_id: curr.id,
      message: `Phase regression detected: ${old.phase} → ${curr.phase}`,
      data: { from: old.phase, to: curr.phase, from_idx: oldPhaseIdx, to_idx: currPhaseIdx, transcript_before: old.transcript.length, transcript_after: curr.transcript.length },
    });
  }

  if (curr.transcript.length < old.transcript.length) {
    console.error(`[STATE-GUARD] Transcript shrinkage: ${old.transcript.length} → ${curr.transcript.length}`);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'state-guard', level: 'error',
      debate_id: curr.id,
      message: `Transcript shrinkage: ${old.transcript.length} → ${curr.transcript.length}`,
      data: { before: old.transcript.length, after: curr.transcript.length, phase: curr.phase },
    });
  }
});
