// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// "Ask a question" store (t/3583). Own lifecycle (ask → poll → result) — deliberately NOT folded
// into useDebateStore, which is session-shaped and has none of this concept.

import { create } from 'zustand';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { deriveDebateConfig } from '@lib/debate/inquiryConfig';
import type { InquiryJobStatus, InquiryResult, InquiryStatusResponse, InquiryResultSummary } from '../bridge/types';
import type { Fidelity } from '@lib/inquiry';
import type { TagSelection } from '@lib/schema/povTags';
import type { ModelRegistry } from '@lib/ai-client/registry';
import aiModelsRegistry from '../../../../ai-models.json';

const registry = aiModelsRegistry as unknown as ModelRegistry;

/** Poll bounds (TL, t/3583#4): interval + backoff on poll errors, and a hard ceiling so a lost
 *  job (server swept it, network partition) doesn't spin forever. */
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_BACKOFF_MS = 30_000;
const POLL_CEILING_MS = 60 * 60_000; // 1 hour — comfortably above Deep fidelity's own ~45 min estimate

export type InquiryScreen = 'ask' | 'running' | 'answer' | 'list';

interface InquiryStoreState {
  question: string;
  fidelity: Fidelity;
  /** Explicit model overrides (t/3583#2 revision — both pickable on the Ask screen). Undefined = use
   *  the fidelity tier default. */
  debaterModel?: string;
  evaluatorModel?: string;
  /** Optional POV tag for one camp (t/4246, contract t/3965). Undefined = an untagged inquiry, as before. */
  tagSelection?: TagSelection;

  jobId: string | null;
  status: InquiryJobStatus | null;
  progressPct: number;
  terminationReason: string | null;
  /** Job-level failure (status === 'failed') — distinct from pollError (TL point 3: poll-error ≠
   *  job-failed). A transient network blip while polling must not read as "the inquiry failed". */
  error: string | null;
  /** Set when a POLL request itself fails (network, 5xx) — surfaced separately from `error` so the
   *  UI can show "still trying to check status" rather than a false failure. Cleared on the next
   *  successful poll. */
  pollError: string | null;
  result: InquiryResult | null;

  /** "My Questions" history list (t/3620). Explicit view flag — independent of jobId/status,
   *  since a user can browse history while a fresh inquiry has never been started. */
  viewingList: boolean;
  history: InquiryResultSummary[];
  historyLoading: boolean;
  historyError: string | null;

  setQuestion: (q: string) => void;
  setFidelity: (f: Fidelity) => void;
  setDebaterModel: (m: string | undefined) => void;
  setEvaluatorModel: (m: string | undefined) => void;
  setTagSelection: (t: TagSelection | undefined) => void;
  /** The debater/evaluator models this run will actually use — the override if set, else the
   *  fidelity tier default (single source of truth: lib/debate/inquiryConfig's deriveDebateConfig,
   *  same function the server-side pipeline uses to resolve the same request). */
  resolvedModels: () => { debaters: string; evaluator: string; callBudget: number };
  screen: () => InquiryScreen;
  startInquiry: () => Promise<void>;
  /** Returns to the Ask screen for a fresh question. Stops any in-flight poll. */
  reset: () => void;

  /** Opens the "My Questions" list screen and fetches history. */
  openList: () => void;
  /** Leaves the list screen without disturbing any in-flight ask/poll state. */
  closeList: () => void;
  fetchHistory: () => Promise<void>;
  /** Opens a past question from history directly onto the Answer screen (t/3620). */
  openFromHistory: (jobId: string) => Promise<void>;
  /** t/4562: opens a community question directly onto the Answer screen — mirrors
   *  openFromHistory, but loads the full result from the community store rather than the
   *  caller's own history. jobId stays null (not the caller's own run), which naturally hides
   *  the Share-link control (My-only) without a separate "community source" flag. */
  openCommunityResult: (id: string) => Promise<void>;

  /** Internal — exposed for the unmount-cleanup effect in InquiryTab.tsx. */
  _stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollStartedAt = 0;
let consecutivePollFailures = 0;

function clearPollTimer(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** Same formula schedulePoll() uses — shared so the poll-failed FR event can report the exact
 *  backoff it's about to apply, instead of forcing a reader to recompute it (t/3725). */
function computeBackoffDelay(failures: number): number {
  return failures === 0
    ? POLL_INTERVAL_MS
    : Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_POLL_BACKOFF_MS);
}

export const useInquiryStore = create<InquiryStoreState>((set, get) => {
  function schedulePoll(jobId: string): void {
    clearPollTimer();
    const delay = computeBackoffDelay(consecutivePollFailures);
    pollTimer = setTimeout(() => void poll(jobId), delay);
  }

  async function poll(jobId: string): Promise<void> {
    // Ceiling: a lost job (swept server-side, or a stuck desktop process) must not poll forever.
    if (performance.now() - pollStartedAt > POLL_CEILING_MS) {
      clearPollTimer();
      set({
        status: 'failed',
        error: 'Timed out waiting for a status update — the inquiry may still be running server-side, but this client gave up polling.',
      });
      return;
    }
    // Stale poll guard: a reset()/new startInquiry() during this poll's flight must not clobber
    // the newer state when this response lands.
    if (get().jobId !== jobId) return;

    let view: InquiryStatusResponse;
    try {
      view = await api.getInquiry(jobId);
    } catch (err) {
      // A 404 means the job definitively does not exist (e.g. the server process was replaced
      // while the inquiry was in flight, t/3723) — not a transient error. Retrying it can never
      // succeed, so unlike other poll failures this terminates the loop on first occurrence
      // instead of backing off and retrying.
      const httpStatus = (err as { httpStatus?: number }).httpStatus;
      if (httpStatus === 404) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'inquiry-store',
          level: 'warn',
          message: `Inquiry ${jobId} not found (HTTP 404) — stopping poll`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          data: { attempt: consecutivePollFailures + 1, backoff_interval_ms: null, is_terminal: true },
        });
        clearPollTimer();
        if (get().jobId === jobId) {
          set({
            status: 'failed',
            error: 'This inquiry is no longer available. The server restarted while it was running, so the run was lost. Starting a new inquiry will re-run it.',
            pollError: null,
          });
        }
        return;
      }

      consecutivePollFailures++;
      const backoffIntervalMs = computeBackoffDelay(consecutivePollFailures);
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'inquiry-store',
        level: 'warn',
        message: `Poll failed for inquiry ${jobId} (attempt ${consecutivePollFailures})`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { attempt: consecutivePollFailures, backoff_interval_ms: backoffIntervalMs, is_terminal: false },
      });
      if (get().jobId === jobId) {
        set({ pollError: err instanceof Error ? err.message : String(err) });
        schedulePoll(jobId);
      }
      return;
    }
    if (get().jobId !== jobId) return; // superseded while this request was in flight

    consecutivePollFailures = 0;
    set({
      status: view.status,
      progressPct: view.progressPct,
      terminationReason: view.terminationReason,
      error: view.status === 'failed' ? view.error : null,
      result: view.result ?? null,
      pollError: null,
    });

    if (view.status === 'done' || view.status === 'done_truncated' || view.status === 'failed') {
      clearPollTimer();
      return;
    }
    schedulePoll(jobId);
  }

  return {
    question: '',
    fidelity: 'standard',
    debaterModel: undefined,
    evaluatorModel: undefined,
    tagSelection: undefined,
    jobId: null,
    status: null,
    progressPct: 0,
    terminationReason: null,
    error: null,
    pollError: null,
    result: null,

    // t/4562: the library page (My/Community) is now the tab's default landing view, matching
    // Op-Eds/Chats/Debates — true rather than false. A fresh startInquiry()/openFromHistory()
    // flips this to false explicitly; reset() returns here too ("Ask another question"/"+ New
    // Question" from any screen).
    viewingList: true,
    history: [],
    historyLoading: false,
    historyError: null,

    setQuestion: (q) => set({ question: q }),
    setFidelity: (f) => set({ fidelity: f }),
    setDebaterModel: (m) => set({ debaterModel: m }),
    setEvaluatorModel: (m) => set({ evaluatorModel: m }),
    setTagSelection: (t) => set({ tagSelection: t }),

    resolvedModels: () => {
      const { fidelity, debaterModel, evaluatorModel } = get();
      const { derivation } = deriveDebateConfig(
        { question: '_', fidelity, models: { debaters: debaterModel, evaluator: evaluatorModel } },
        registry,
      );
      return { debaters: derivation.models.debaters, evaluator: derivation.models.evaluator, callBudget: derivation.callBudget };
    },

    screen: () => {
      const { jobId, status, viewingList } = get();
      if (viewingList) return 'list';
      if (jobId === null) return 'ask';
      if (status === 'done' || status === 'done_truncated' || status === 'failed') return 'answer';
      return 'running';
    },

    startInquiry: async () => {
      const { question, fidelity, debaterModel, evaluatorModel, tagSelection } = get();
      set({ error: null, pollError: null, result: null, status: 'queued', progressPct: 0, terminationReason: null });
      try {
        const { jobId } = await api.startInquiry({
          question,
          fidelity,
          models: (debaterModel || evaluatorModel) ? { debaters: debaterModel, evaluator: evaluatorModel } : undefined,
          ...(tagSelection ? { tagSelection } : {}),
        });
        set({ jobId });
        clearPollTimer();
        consecutivePollFailures = 0;
        pollStartedAt = performance.now();
        void poll(jobId);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'inquiry-store',
          level: 'error',
          message: 'startInquiry failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        set({
          jobId: null,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    reset: () => {
      clearPollTimer();
      consecutivePollFailures = 0;
      set({
        jobId: null, status: null, progressPct: 0, terminationReason: null,
        error: null, pollError: null, result: null, viewingList: false,
      });
    },

    openList: () => {
      set({ viewingList: true });
      void get().fetchHistory();
    },

    closeList: () => set({ viewingList: false }),

    fetchHistory: async () => {
      set({ historyLoading: true, historyError: null });
      try {
        const history = await api.listInquiries();
        set({ history, historyLoading: false });
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'inquiry-store',
          level: 'error',
          message: 'fetchHistory failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        set({ historyLoading: false, historyError: err instanceof Error ? err.message : String(err) });
      }
    },

    openFromHistory: async (jobId: string) => {
      clearPollTimer();
      consecutivePollFailures = 0;
      set({ viewingList: false, error: null, pollError: null, result: null, jobId, status: 'queued', progressPct: 0, terminationReason: null });
      try {
        const view = await api.getInquiry(jobId);
        set({
          status: view.status,
          progressPct: view.progressPct,
          terminationReason: view.terminationReason,
          error: view.status === 'failed' ? view.error : null,
          result: view.result ?? null,
        });
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'inquiry-store',
          level: 'error',
          message: `openFromHistory failed for ${jobId}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        set({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    },

    openCommunityResult: async (id: string) => {
      clearPollTimer();
      consecutivePollFailures = 0;
      set({ viewingList: false, error: null, pollError: null, result: null, jobId: null, status: 'queued', progressPct: 0, terminationReason: null });
      try {
        const result = await api.loadCommunityInquiry(id);
        set({ status: 'done', progressPct: 100, result });
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'inquiry-store',
          level: 'error',
          message: `openCommunityResult failed for ${id}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        set({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    },

    _stopPolling: () => { clearPollTimer(); },
  };
});
