// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useDebateStore } from '../store';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { getRemoteRunLeaseHolder, getRunLeaseWindowId, isRunLeaseHeldLocally, subscribeRunLease } from './debateRunLease';

/** Check if an error is a daily token limit (tokens_per_day) — non-retryable. */
export function isDailyLimitError(err: unknown): boolean {
  return (err as { limitType?: string })?.limitType === 'tokens_per_day';
}

export const DAILY_LIMIT_MESSAGE = 'Daily AI usage limit reached (resets at midnight UTC). Resume tomorrow, or add your own API key in Settings to continue now.';

export let _abortController: AbortController | null = null;

/**
 * Guard against race conditions in async debate operations.
 * Captures the active debate ID *and this run's abort controller* at call time;
 * returns a checker that verifies the debate hasn't changed and this run hasn't
 * been superseded during an await.
 *
 * Capturing the controller matters when a new run replaces the module-global
 * `_abortController` via newAbortController() (e.g. Switch-model restart, t/2505):
 * a bare `_abortController.signal.aborted` read would see the *new* run's fresh
 * (un-aborted) controller and wrongly report the superseded run as still valid,
 * so the abandoned pipeline would keep writing. The captured reference stays
 * pinned to this run's controller, so cancelAndResetAbort() reliably discards it.
 */
export function createDebateGuard(get: () => { activeDebateId: string | null }): () => boolean {
  const capturedId = get().activeDebateId;
  const capturedAbort = _abortController;
  return () => {
    if (capturedAbort?.signal.aborted) return false; // this run superseded/cancelled
    if (_abortController?.signal.aborted) return false; // current run cancelled (existing behavior)
    if (capturedId !== get().activeDebateId) {
      console.warn(`[debate] Active debate changed during async operation (was ${capturedId}, now ${get().activeDebateId}). Discarding stale results.`);
      return false;
    }
    return true;
  };
}

export function cancelAndResetAbort(): void {
  _abortController?.abort();
  _abortController = null;
}

export function newAbortController(): AbortController {
  _abortController = new AbortController();
  return _abortController;
}

// Deliberate-cancellation tagging (t/2508) lives in the zero-dependency bridge module
// so both bridges and this debate-store module share one definition without an import
// cycle. Re-exported here for the debate-store consumers (generation.ts, slice catches).
export { isCancellationError, makeCancellationError } from '../../../bridge/cancellation';

// ── Single-driver guard (t/657) ────────────────────────────────────────
// While this window holds the per-debate run lease (debateRunLease.ts, t/3917), the
// driver is pinned to it. A bare claim (a pop-out's markAsPopout) can't displace it,
// per-turn releases are no-ops, and the real release happens when the lease is released.
const _driverChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('aitriad-debate-driver') : null;
const _windowId = getRunLeaseWindowId();
let _activeDriverWindow: string | null = null;
let _isPopoutWindow = false;

function holdsLeaseForActiveDebate(): boolean {
  return isRunLeaseHeldLocally(useDebateStore.getState().activeDebateId);
}

function reloadActiveDebateFromStorage(reason: string): void {
  const debateId = useDebateStore.getState().activeDebateId;
  if (!debateId) return;
  // t/3917 condition 4: never reload under this window's own running debate. The
  // in-memory state is the newest copy, and the load-guard is only a backstop.
  if (isRunLeaseHeldLocally(debateId)) {
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'run-lease', level: 'info', debate_id: debateId, message: 'Reload from storage skipped — this window holds the run lease', data: { reason } });
    return;
  }
  void useDebateStore.getState().loadDebate(debateId);
}

// Viewer refresh (t/3917 condition 5): the holder broadcasts each save; coalesce bursts
// (several saves land per turn) into one trailing reload.
const VIEWER_RELOAD_COALESCE_MS = 1_000;
let _viewerReloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleViewerReload(): void {
  if (_viewerReloadTimer) return;
  _viewerReloadTimer = setTimeout(() => {
    _viewerReloadTimer = null;
    reloadActiveDebateFromStorage('holder-saved');
  }, VIEWER_RELOAD_COALESCE_MS);
}

/**
 * Every flip of `driverIsRemote` goes through here, so a dump shows why a window became a
 * viewer and whether it was ever released (t/3967: the 10-06 dump could show neither).
 */
function setDriverIsRemote(value: boolean, reason: string, holderWindow: string | null): void {
  const state = useDebateStore.getState();
  if (state.driverIsRemote === value) return;
  useDebateStore.setState({ driverIsRemote: value });
  getGlobalRecorder()?.record({
    type: 'debate.lifecycle', component: 'run-lease', level: 'info', debate_id: state.activeDebateId ?? undefined,
    message: value ? 'Window became a viewer — another window drives this debate' : 'Viewer released — this window can drive again',
    data: { reason, holder_window: holderWindow, window: _windowId, popout: _isPopoutWindow },
  });
}

/** The lease holder this window deferred to. Kept apart from `_activeDriverWindow`, which a
 *  bare driver-channel claim can move, so the holder's lease release always unlocks us. */
let _deferredToHolder: string | null = null;

function deferToHolder(holderWindow: string, reason: string): void {
  _activeDriverWindow = holderWindow;
  _deferredToHolder = holderWindow;
  setDriverIsRemote(true, reason, holderWindow);
}

function holderGone(holderWindow: string, reason: string): void {
  if (_activeDriverWindow !== holderWindow && _deferredToHolder !== holderWindow) return;
  if (_activeDriverWindow === holderWindow) _activeDriverWindow = null;
  _deferredToHolder = null;
  setDriverIsRemote(false, reason, holderWindow);
  reloadActiveDebateFromStorage(reason);
}

const _unsubscribeRunLease = subscribeRunLease((ev) => {
  if (ev.type === 'local-released') {
    if (_activeDriverWindow === _windowId) {
      _activeDriverWindow = null;
      _driverChannel?.postMessage({ type: 'release', windowId: _windowId });
    }
    return;
  }
  if (ev.debateId !== useDebateStore.getState().activeDebateId) return;
  // Exhaustive on purpose: a lease event with no case here is how t/3967 happened (the
  // lease emitted 'remote-released' and no viewer listened). A new variant fails to compile.
  switch (ev.type) {
    case 'remote-held':
      // Another window owns this debate: defer to it, including when this is a pop-out.
      deferToHolder(ev.holder.windowId, 'holder-held');
      return;
    case 'remote-released':
      // The holder finished. The lease release is authoritative; the driver-channel
      // 'release' is only a secondary path, sent only when the holder's own driver
      // bookkeeping still points at itself (t/3967).
      holderGone(ev.windowId, 'holder-released');
      return;
    case 'remote-expired':
      // The holder died without a release. Free the driver so this window isn't a
      // permanent viewer (t/3917 condition 2), and refresh from what it last saved.
      holderGone(ev.holder.windowId, 'holder-expired');
      return;
    case 'remote-saved':
      scheduleViewerReload();
      return;
    default: {
      const unhandled: never = ev;
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'run-lease', level: 'warn', message: 'Unhandled run-lease event ignored', data: { event: unhandled } });
    }
  }
});

if (_driverChannel) {
  _driverChannel.onmessage = (e: MessageEvent) => {
    const { type, windowId, debateId } = e.data as { type: string; windowId: string; debateId?: string };
    if (type === 'claim') {
      if (windowId !== _windowId && holdsLeaseForActiveDebate()) {
        // We own the active debate's run. Re-assert so the claimer becomes a viewer.
        _activeDriverWindow = _windowId;
        _driverChannel?.postMessage({ type: 'claim', windowId: _windowId, debateId: useDebateStore.getState().activeDebateId });
        return;
      }
      _activeDriverWindow = windowId;
      // A pop-out normally ignores claims (it drives its own debate), except from the
      // lease holder of the very debate it shows.
      const fromLeaseHolderOfOurDebate = !!debateId && debateId === useDebateStore.getState().activeDebateId;
      if (windowId !== _windowId && (!_isPopoutWindow || fromLeaseHolderOfOurDebate)) {
        setDriverIsRemote(true, 'driver-claim', windowId);
      }
    }
    if (type === 'release' && _activeDriverWindow === windowId) {
      _activeDriverWindow = null;
      if (_deferredToHolder === windowId) _deferredToHolder = null;
      if (windowId !== _windowId) {
        setDriverIsRemote(false, 'driver-released', windowId);
        reloadActiveDebateFromStorage('driver-released');
      }
    }
  };
}

// A window learns about a remote holder before it knows which debate it shows (the
// pop-out mounts, gets the holder's beat, and only then loads its debate). Re-check
// whenever the active debate changes. Subscribed lazily: this module is imported while
// the store is still being constructed.
let _unsubscribeActiveDebateWatch: (() => void) | null = null;
function ensureActiveDebateWatcher(): void {
  if (_unsubscribeActiveDebateWatch) return;
  _unsubscribeActiveDebateWatch = useDebateStore.subscribe((state, prev) => {
    if (state.activeDebateId === prev.activeDebateId || !state.activeDebateId) return;
    const holder = getRemoteRunLeaseHolder(state.activeDebateId);
    if (holder) deferToHolder(holder.windowId, 'holder-held-on-load');
  });
}

const _beforeUnloadHandler = (e: BeforeUnloadEvent) => {
  releaseDebateDriver();

  // Check for unsaved debate work (t/4640: existing guard)
  const debateState = useDebateStore.getState();
  const activeId = debateState.activeDebateId;
  if (activeId && debateState.sessions[activeId as keyof typeof debateState.sessions]?.isRunning) {
    e.preventDefault();
    e.returnValue = '';
    return;
  }

  // Check for unsaved taxonomy edits (t/4640: extend guard to prevent navigation loss)
  try {
    // Import deferred to avoid circular dependency at module init time
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, @typescript-eslint/no-unsafe-member-access
    const getTaxonomyStore = (require('../../useTaxonomyStore') as Record<string, unknown>).useTaxonomyStore as { getState: () => { dirty?: Set<string> } };
    const taxonomyState = getTaxonomyStore.getState();
    if (taxonomyState.dirty && taxonomyState.dirty.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'beforeunload-guard',
      level: 'warn',
      message: 'Failed to check unsaved taxonomy edits in beforeunload',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    /* beforeunload guard safety fallback — if import fails, allow navigation */
  }
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _driverChannel?.close();
    _unsubscribeRunLease();
    _unsubscribeActiveDebateWatch?.();
    if (_viewerReloadTimer) clearTimeout(_viewerReloadTimer);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', _beforeUnloadHandler);
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', _beforeUnloadHandler);
}

export function claimDebateDriver(): boolean {
  // The run-lease holder always drives its debate (t/3917): its lease outranks a bare
  // claim, such as the pop-out's markAsPopout.
  if (holdsLeaseForActiveDebate()) {
    _activeDriverWindow = _windowId;
    _driverChannel?.postMessage({ type: 'claim', windowId: _windowId, debateId: useDebateStore.getState().activeDebateId });
    return true;
  }
  if (_activeDriverWindow && _activeDriverWindow !== _windowId) return false;
  _activeDriverWindow = _windowId;
  _driverChannel?.postMessage({ type: 'claim', windowId: _windowId });
  return true;
}

export function releaseDebateDriver(): void {
  // Pinned while this window holds the run lease: a per-turn release mid-run would hand
  // viewers a reload-and-claim window between rounds. The 'local-released' event does
  // the real release.
  if (holdsLeaseForActiveDebate()) return;
  if (_activeDriverWindow === _windowId) {
    _activeDriverWindow = null;
    _driverChannel?.postMessage({ type: 'release', windowId: _windowId });
  }
}

function resetDebateDriverLock(): void {
  _activeDriverWindow = null;
  _deferredToHolder = null;
}

/** True in a debate pop-out window. The viewer banner words itself by it (t/3967). */
export function isDebatePopoutWindow(): boolean {
  return _isPopoutWindow;
}

export function markAsPopout(): void {
  _isPopoutWindow = true;
  _activeDriverWindow = _windowId;
  setDriverIsRemote(false, 'popout-mounted', null);
  _driverChannel?.postMessage({ type: 'claim', windowId: _windowId });
  // If another window already holds this debate's run lease, its re-assert (or its beat,
  // once our debate loads) turns this pop-out into a viewer (t/3917, Option A).
  ensureActiveDebateWatcher();
}

export function initDebatePopoutCloseHandler(api: { onDebatePopoutClosed: (cb: (debateId: string) => void) => () => void }): () => void {
  ensureActiveDebateWatcher();
  return api.onDebatePopoutClosed((debateId) => {
    // Multi-window (t/2310): only reclaim the driver + reload when the popout that closed
    // was driving THIS window's active debate. A different debate's popout closing must not
    // clobber the displayed debate's driver/reload state now that N popouts can be open.
    if (debateId !== useDebateStore.getState().activeDebateId) return;
    setDriverIsRemote(false, 'popout-closed', null);
    reloadActiveDebateFromStorage('popout-closed');
  });
}
