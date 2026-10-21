// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { contextBridge, ipcRenderer } from 'electron';
import type { OpEdSet, OpEdSetSummary } from '../../../lib/oped/types.js';
import type { StopReason, ProviderCallDiagnostics } from '../../../lib/ai-client/index.js';
import type { ExportJobState, ExportErrorCode, BriefPreset, BriefArtifactName } from '../../../lib/brief/types.js';
// t/3532: these mirror bridge/types.ts's re-exports, imported from their true origin
// instead — bridge/types.ts is a real .ts (not .d.ts) using renderer-only `@lib/*`
// aliases that don't resolve under this file's tsconfig.main.json (nodenext), same
// issue as t/3529's BriefExportJobView/ExportJobState fix.
import type { Organization, OrganizationEdge } from '../../../lib/organizations/types.js';
import type { EntityDetail, EntitySummary, EntityListQuery } from '../../../lib/entities/types.js';
import type { ContainerMentions } from '../../../lib/entities/mentionTypes.js';
import type { ANClaimInput, RelevantTaxonomyResult } from '../../../lib/debate/relevanceSelection.js';
import type { ClaimAttributionResult } from '../../../lib/debate/argumentNetwork/attribution.js';
import type { ClaimTaxonomyAttribution } from '../../../lib/debate/types.js';
import type { UserPreferences } from '../../../lib/userPreferencesSchema.js';
import type { PovTagProposalsFile, ApplyProposalDecisionResult } from '../../../lib/schema/povTagProposals.js';
import type { InquiryRequest, InquiryResult } from '../../../lib/inquiry/index.js';
import type { NodeDeleteLogEntry } from './nodeDeleteLog.js';
import type { RecountPolicyMembersResult } from '../../../lib/policy/registryRecount.js';
import type { RefreshResult } from '../../../lib/electron-shared/modelDiscovery.js';
import type { SourceReference, SourceCardMeta } from '../../../lib/sourceIndex/types.js';

// t/3532: mirrors bridge/types.ts's FetchRelevantNodesPayload/FetchClaimAttributionPayload/
// ClaimAttributionResponse structurally (those are defined directly in bridge/types.ts, not
// re-exported from a lib file, so inlined here rather than imported for the same reason as
// above). Param sharpening constrains OUR callers (TL reasoning, t/3532#3) — genuinely
// enforced by tsc at every call site, unlike a return-type claim about data we receive.
interface FetchRelevantNodesPayload {
  pov: string;
  topic: string;
  recentTranscript: string;
  threshold?: number;
  session: {
    anClaimEmbeddings: ANClaimInput[];
    lineageFrame?: { cluster_id: string; label?: string }[];
    sourceType?: string;
    excludeGreatestHits?: boolean;
    greatestHitsList?: string[];
  };
}
interface FetchClaimAttributionPayload {
  pov: string;
  claims: { id: string; embedding?: number[]; attribution_embedding?: number[] }[];
  topN?: number;
}
interface ClaimAttributionResponse {
  attributions: Record<string, ClaimTaxonomyAttribution>;
  summary: ClaimAttributionResult;
}

// Inlined from preloadBuffer.cts — sandboxed preloads (sandbox:true) cannot
// require sibling files at runtime; inlining avoids the require('./preloadBuffer.cjs')
// that tsc emits, which throws "module not found" before exposeInMainWorld runs (t/2772).
interface LatestValueBuffer<T> {
  onIpc(value: T): void;
  onSubscribe(deliver: (value: T) => void): void;
  onUnsubscribe(): void;
}

// t/3439 (vitest 5 migration): extracted so the performance.now-missing fallback is
// unit-testable via a plain function call, not a live dynamic import with a corrupted
// global — vitest 5's Module Runner needs a working performance.now() DURING the import
// itself (its own invoke/getModuleInformation RPC path), so nulling the real global for
// the duration of `await import(...)` throws before preload.cjs's own guard ever runs.
export function resolvePreloadTimestamp(perf: { now?: unknown } | undefined = typeof performance !== 'undefined' ? performance : undefined): number {
  return (perf && typeof perf.now === 'function') ? (perf.now as () => number)() : Date.now();
}

export function createLatestValueBuffer<T>(): LatestValueBuffer<T> {
  let buffered: T | null = null;
  let active = true;
  return {
    onIpc(value: T): void { if (active) buffered = value; },
    onSubscribe(deliver: (value: T) => void): void {
      active = false;
      if (buffered !== null) {
        const value = buffered;
        buffered = null;
        queueMicrotask(() => deliver(value));
      }
    },
    onUnsubscribe(): void { active = true; },
  };
}

console.log('[preload] starting...');

// Buffer debate-window-load IPC so it isn't lost if React mounts after did-finish-load
// (happens with bootstrap.ts dynamic import indirection).
let _bufferedDebateId: string | null = null;
let _debateBufferActive = true;
let _bufferedChatId: string | null = null;
let _chatBufferActive = true;

// Buffer the diagnostics-state-update push the same way (t/2694) — see
// preloadBuffer.cts. The main window pushes the cached state once on the
// diagnostics popup's did-finish-load, but useDiagnosticsState subscribes only
// after React mounts; a push arriving first was silently dropped, and for an idle
// debate (no follow-up pushes) the window stayed on "Loading debate…" forever.
// Also covers the PovProgression window (same channel). Logic extracted to the
// pure helper so it's unit-tested (preloadBuffer.test.ts, unblocked by t/2698).
const _diagnosticsStateBuffer = createLatestValueBuffer<unknown>();

// t/3529: named function (not an inline object literal) so its return shape is capturable
// via `ReturnType<>` for the compile-time conformance check against the renderer's
// `ElectronAPI` (`__typecheck__/preloadElectronApiContract.ts`) — closes the gap where this
// surface and `electron.d.ts` could silently diverge (t/3528 postmortem, t/3529). Still
// invoked INSIDE the try block below, so construction-time errors are caught exactly as
// before this change.
function buildElectronApi() {
  return {
  // Synchronous system info — available without IPC round-trip
  processVersions: { ...process.versions },
  osRelease: process.getSystemVersion?.() ?? process.platform,
  osPlatform: process.platform,
  osArch: process.arch,
  // t/2766: stamp when contextBridge.exposeInMainWorld ran — lets renderer compute
  // the preload→bridge-available delta for the bridge-available FR lifecycle event.
  preloadTimestamp: resolvePreloadTimestamp(),
  getEmbeddingInfo: (): Promise<{ backend: string; execution_provider?: string; calibration_version?: number }> =>
    ipcRenderer.invoke('get-embedding-info'),

  // User preferences (t/2118)
  // t/3536: was `Promise<unknown>` — narrowed now that the handler validates via the
  // shared lib/userPreferencesSchema.ts (t/3535) instead of returning the parsed file
  // contents as-is, making this declared type an enforced claim rather than an
  // unverified one (the t/3529/t/3532 carve-out reason this was left loose).
  getPreferences: (): Promise<UserPreferences | null> =>
    ipcRenderer.invoke('get-preferences'),
  setPreferences: (prefs: unknown): Promise<void> =>
    ipcRenderer.invoke('set-preferences', prefs),

  getTaxonomyDirs: (): Promise<string[]> =>
    ipcRenderer.invoke('get-taxonomy-dirs'),

  getActiveTaxonomyDir: (): Promise<string> =>
    ipcRenderer.invoke('get-active-taxonomy-dir'),

  setTaxonomyDir: (dirName: string): Promise<void> =>
    ipcRenderer.invoke('set-taxonomy-dir', dirName),

  loadTaxonomyFile: (pov: string): Promise<unknown> =>
    ipcRenderer.invoke('load-taxonomy-file', pov),

  saveTaxonomyFile: (pov: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('save-taxonomy-file', pov, data),

  loadPolicyRegistry: (): Promise<unknown> =>
    ipcRenderer.invoke('load-policy-registry'),

  recountPolicyMembers: (ids: string[]): Promise<RecountPolicyMembersResult> =>
    ipcRenderer.invoke('recount-policy-members', ids),

  loadPovTagProposals: (): Promise<PovTagProposalsFile | null> =>
    ipcRenderer.invoke('load-pov-tag-proposals'),

  reviewPovTagProposal: (nodeId: string, decision: unknown, expectedStatus: string): Promise<ApplyProposalDecisionResult> =>
    ipcRenderer.invoke('review-pov-tag-proposal', nodeId, decision, expectedStatus),

  loadLineageCategories: (): Promise<unknown> =>
    ipcRenderer.invoke('load-lineage-categories'),

  loadLineageInfo: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('load-lineage-info'),

  // t/3859 (Part D of t/3852): durable local audit record for a node deletion.
  logNodeDeletion: (entry: NodeDeleteLogEntry): Promise<void> =>
    ipcRenderer.invoke('log-node-deletion', entry),

  loadConflictFiles: (): Promise<unknown[]> =>
    ipcRenderer.invoke('load-conflict-files'),

  loadConflictClusters: (): Promise<unknown | null> =>
    ipcRenderer.invoke('load-conflict-clusters'),

  loadAggregatedCruxes: (): Promise<unknown | null> =>
    ipcRenderer.invoke('load-aggregated-cruxes'),

  // Summaries & Sources
  discoverSources: (): Promise<unknown[]> =>
    ipcRenderer.invoke('discover-sources'),

  loadSummary: (docId: string): Promise<unknown | null> =>
    ipcRenderer.invoke('load-summary', docId),

  loadSnapshot: (sourceId: string): Promise<{ content: string } | null> =>
    ipcRenderer.invoke('load-snapshot', sourceId),

  resolveSourceDocument: (docId: string): Promise<{ available: boolean; type: 'pdf' | 'markdown' | null; content?: string; path?: string }> =>
    ipcRenderer.invoke('source-documents:resolve', docId),

  saveConflictFile: (claimId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('save-conflict-file', claimId, data),

  createConflictFile: (claimId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('create-conflict-file', claimId, data),

  deleteConflictFile: (claimId: string): Promise<void> =>
    ipcRenderer.invoke('delete-conflict-file', claimId),

  loadDictionary: (): Promise<{ standardized: unknown[]; colloquial: unknown[]; lintViolations: unknown[] }> =>
    ipcRenderer.invoke('load-dictionary'),

  isDataAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('is-data-available'),

  getDataRoot: (): Promise<string> =>
    ipcRenderer.invoke('get-data-root'),

  cloneDataRepo: (targetPath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('clone-data-repo', targetPath),

  setDataRoot: (newRoot: string): Promise<void> =>
    ipcRenderer.invoke('set-data-root', newRoot),

  pickDirectory: (defaultPath?: string): Promise<{ cancelled: boolean; path?: string }> =>
    ipcRenderer.invoke('pick-directory', defaultPath),

  checkDataUpdates: (): Promise<unknown> =>
    ipcRenderer.invoke('check-data-updates'),

  pullDataUpdates: (): Promise<unknown> =>
    ipcRenderer.invoke('pull-data-updates'),

  getChangedFiles: (): Promise<{ path: string; status: string }[]> =>
    ipcRenderer.invoke('get-changed-files'),

  getFileDiff: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('get-file-diff', filePath),

  loadAIModels: (): Promise<unknown> =>
    ipcRenderer.invoke('load-ai-models'),

  // t/4031: opts pass through untouched (the handler validates them, t/4161); a plain refresh sends no argument.
  refreshAIModels: (opts?: unknown): Promise<RefreshResult> =>
    ipcRenderer.invoke('refresh-ai-models', ...(opts === undefined ? [] : [opts])),

  validateApiKey: (key: string, backend: string): Promise<{ valid: boolean; error?: string }> =>
    ipcRenderer.invoke('validate-api-key', key, backend),

  setApiKey: (key: string, backend?: string): Promise<void> =>
    ipcRenderer.invoke('set-api-key', key, backend),

  hasApiKey: (backend?: string): Promise<boolean> =>
    ipcRenderer.invoke('has-api-key', backend),

  getApiKeySummary: (): Promise<{ backend: string; hasKey: boolean; maskedKey: string | null; keyCount: number; maskedKeys: string[] }[]> =>
    ipcRenderer.invoke('get-api-key-summary'),

  deleteApiKey: (backend?: string): Promise<void> =>
    ipcRenderer.invoke('delete-api-key', backend),

  deleteAllApiKeys: (): Promise<void> =>
    ipcRenderer.invoke('delete-all-api-keys'),

  addApiKey: (key: string, backend?: string): Promise<number> =>
    ipcRenderer.invoke('add-api-key', key, backend),

  removeApiKey: (index: number, backend?: string): Promise<void> =>
    ipcRenderer.invoke('remove-api-key', index, backend),

  getApiKeys: (backend?: string): Promise<string[]> =>
    ipcRenderer.invoke('get-api-keys', backend),

  verifyStoredKeys: (backend: string): Promise<{ results: { index: number; masked: string; valid: boolean; error?: string }[] }> =>
    ipcRenderer.invoke('verify-stored-keys', backend),

  exportKeysForSharing: (passphrase: string): Promise<{ dataUrl: string; payloadText: string }> =>
    ipcRenderer.invoke('export-keys-for-sharing', passphrase),

  importKeysFromSharing: (payload: unknown, passphrase: string): Promise<string[]> =>
    ipcRenderer.invoke('import-keys-from-sharing', payload, passphrase),

  // t/3532: param AND return sharpened — Rosetta verified both handlers delegate to the
  // real typed functions genuinely returning these shapes (t/3532#2); the param sharpening
  // additionally constrains our own callers, enforced by tsc regardless of the internal
  // `as`-cast on the handler side (TL reasoning, t/3532#3).
  fetchRelevantNodes: (payload: FetchRelevantNodesPayload): Promise<RelevantTaxonomyResult> =>
    ipcRenderer.invoke('fetch-relevant-nodes', payload),

  computeAttribution: (payload: FetchClaimAttributionPayload): Promise<ClaimAttributionResponse> =>
    ipcRenderer.invoke('compute-attribution', payload),

  computeEmbeddings: (texts: string[], ids?: string[]): Promise<{ vectors: number[][] }> =>
    ipcRenderer.invoke('compute-embeddings', texts, ids),

  updateNodeEmbeddings: (nodes: { id: string; text: string; pov: string; exclusionText?: string }[]): Promise<{ staleNodeIds: string[] }> =>
    ipcRenderer.invoke('update-node-embeddings', nodes),

  computeQueryEmbedding: (text: string): Promise<{ vector: number[] }> =>
    ipcRenderer.invoke('compute-query-embedding', text),

  // t/3528: single payload object, forwarded unchanged — see aiHandlers.ts's
  // GenerateTextIpcPayload (renderer's electron.d.ts mirrors this shape, Rosetta scope).
  // t/3525: return type carries the normalized stopReason.
  // t/3569: return type also carries ProviderCallDiagnostics (t/3566) — FR forensics
  // only, forwarded verbatim so instrumentBridge.ts can attach it to ai.response/ai.error
  // (the desktop half of t/3568; renderer FR-event wiring is Rosetta's).
  // t/4048: servedModel is the registry id the call actually resolved to (after defaulting) —
  // desktop has no fallback chain, so it always equals the requested/defaulted model; present so
  // the debate store can mark the run 'tracked' (e/268#6 condition 3; see embeddings.ts).
  generateText: (payload: { prompt: string; model?: string; timeoutMs?: number; temperature?: number; requestId?: string; maxTokens?: number }): Promise<{ text: string; stopReason?: StopReason; diagnostics?: ProviderCallDiagnostics; servedModel?: string }> =>
    ipcRenderer.invoke('generate-text', payload),

  cancelGenerate: (requestId: string): void =>
    void ipcRenderer.invoke('ai:cancel-generate', requestId),

  setDebateTemperature: (temp: number | null): Promise<void> =>
    ipcRenderer.invoke('set-debate-temperature', temp),
  generateTextWithSearch: (prompt: string, model?: string): Promise<{
    text: string;
    searchQueries?: string[];
    citations?: { uri: string; title: string; segments: { startIndex: number; endIndex: number; text?: string; confidence?: number }[] }[];
  }> =>
    ipcRenderer.invoke('generate-text-with-search', prompt, model),

  // Harvest
  harvestCreateConflict: (conflict: Record<string, unknown>): Promise<{ created: boolean }> =>
    ipcRenderer.invoke('harvest-create-conflict', conflict),
  harvestAddDebateRef: (nodeId: string, debateId: string): Promise<{ updated: boolean }> =>
    ipcRenderer.invoke('harvest-add-debate-ref', nodeId, debateId),
  harvestUpdateSteelman: (nodeId: string, attackerPov: string, newText: string): Promise<{ updated: boolean }> =>
    ipcRenderer.invoke('harvest-update-steelman', nodeId, attackerPov, newText),
  harvestAddVerdict: (conflictId: string, verdict: Record<string, unknown>): Promise<{ updated: boolean }> =>
    ipcRenderer.invoke('harvest-add-verdict', conflictId, verdict),
  harvestQueueConcept: (concept: Record<string, unknown>): Promise<{ queued: boolean }> =>
    ipcRenderer.invoke('harvest-queue-concept', concept),

  // Calibration
  getCalibrationHistory: (): Promise<{ current: unknown; history: unknown[] }> =>
    ipcRenderer.invoke('get-calibration-history'),
  getCalibrationLog: (): Promise<{ entries: unknown[]; validationReport: unknown }> =>
    ipcRenderer.invoke('get-calibration-log'),

  // Flight recorder
  dumpFlightRecorder: (ndjson: string): Promise<{ filePath: string; filename: string }> =>
    ipcRenderer.invoke('dump-flight-recorder', ndjson),
  forwardFlightEvent: (event: unknown): void => {
    ipcRenderer.send('forward-flight-event', event);
  },
  triggerMainDump: (): Promise<{ filePath: string }> =>
    ipcRenderer.invoke('trigger-main-dump'),
  onTriggerDump: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('trigger-dump', handler);
    return () => { ipcRenderer.removeListener('trigger-dump', handler); };
  },
  sendDumpResult: (result: { filePath: string }): void => {
    ipcRenderer.send('dump-result', result);
  },
  onFlightEventFromPopup: (callback: (_e: unknown, payload: unknown) => void) => {
    ipcRenderer.on('flight-event-from-popup', callback as (...args: unknown[]) => void);
  },
  openFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('open-file', filePath).then(() => {}),
  openFlightRecorderViewer: (dumpPath: string): Promise<void> =>
    ipcRenderer.invoke('open-flight-recorder-viewer', dumpPath).then(() => {}),

  // Diagnostics window
  openDiagnosticsWindow: (): Promise<void> => ipcRenderer.invoke('open-diagnostics-window'),
  openPovProgressionWindow: (): Promise<void> => ipcRenderer.invoke('open-pov-progression-window'),
  closeDiagnosticsWindow: (): Promise<void> => ipcRenderer.invoke('close-diagnostics-window'),

  // Chat popout window
  openChatWindow: (chatId: string, source?: 'my' | 'community'): Promise<{ atCap: true } | void> => ipcRenderer.invoke('open-chat-window', chatId, source),
  onChatPopoutClosed: (callback: (chatId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chatId: string) => callback(chatId);
    ipcRenderer.on('chat-popout-closed', listener);
    return () => { ipcRenderer.removeListener('chat-popout-closed', listener); };
  },
  onChatWindowLoad: (callback: (chatId: string) => void) => {
    _chatBufferActive = false;
    if (_bufferedChatId) {
      const id = _bufferedChatId;
      _bufferedChatId = null;
      queueMicrotask(() => callback(id));
    }
    const listener = (_event: Electron.IpcRendererEvent, chatId: string) => callback(chatId);
    ipcRenderer.on('chat-window-load', listener);
    return () => {
      ipcRenderer.removeListener('chat-window-load', listener);
      _chatBufferActive = true;
    };
  },

  // Data file diff window
  openDiffWindow: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('open-diff-window', filePath),

  // Prompt Diff window
  openPromptDiffWindow: (debateId: string, entryId: string): Promise<void> =>
    ipcRenderer.invoke('open-prompt-diff-window', debateId, entryId),
  onPromptDiffContext: (callback: (ctx: { debateId: string; entryId: string }) => void) => {
    ipcRenderer.on('prompt-diff-context', (_event, ctx) => callback(ctx));
  },

  // Debate popout window
  openDebateWindow: (debateId: string, source?: unknown): Promise<{ atCap: true } | void> => ipcRenderer.invoke('open-debate-window', debateId, source),
  closeDebateWindow: (debateId: string): Promise<void> => ipcRenderer.invoke('close-debate-window', debateId),
  onDebateWindowLoad: (callback: (debateId: string) => void) => {
    // Stop buffering — the React component is now listening directly.
    _debateBufferActive = false;
    // If the IPC arrived before the React component mounted (bootstrap timing),
    // deliver the buffered ID immediately.
    if (_bufferedDebateId) {
      const id = _bufferedDebateId;
      _bufferedDebateId = null;
      queueMicrotask(() => callback(id));
    }
    const listener = (_event: Electron.IpcRendererEvent, debateId: string) => callback(debateId);
    ipcRenderer.on('debate-window-load', listener);
    return () => {
      ipcRenderer.removeListener('debate-window-load', listener);
      // Re-arm buffer so IPC arriving during the next HMR reload cycle is captured
      _debateBufferActive = true;
    };
  },
  onDebatePopoutClosed: (callback: (debateId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, debateId: string) => callback(debateId);
    ipcRenderer.on('debate-popout-closed', listener);
    return () => { ipcRenderer.removeListener('debate-popout-closed', listener); };
  },
  sendDiagnosticsState: (state: unknown): void => ipcRenderer.send('diagnostics-state-update', state),
  onDiagnosticsStateUpdate: (callback: (state: unknown) => void) => {
    // Flush a push that arrived before the component mounted (t/2694), then the
    // buffer stops; live pushes come through the listener registered below.
    _diagnosticsStateBuffer.onSubscribe(callback);
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('diagnostics-state-update', listener);
    return () => {
      ipcRenderer.removeListener('diagnostics-state-update', listener);
      _diagnosticsStateBuffer.onUnsubscribe(); // re-arm for the next reload cycle
    };
  },
  requestReExtractClaims: (entryId: string): void => ipcRenderer.send('request-re-extract-claims', entryId),
  onReExtractClaims: (callback: (entryId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entryId: string) => callback(entryId);
    ipcRenderer.on('re-extract-claims', listener);
    return () => { ipcRenderer.removeListener('re-extract-claims', listener); };
  },
  getCliFileArg: (): Promise<{ type: string; path: string } | null> =>
    ipcRenderer.invoke('get-cli-file-arg'),
  onDiagnosticsPopoutClosed: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('diagnostics-popout-closed', listener);
    return () => { ipcRenderer.removeListener('diagnostics-popout-closed', listener); };
  },
  harvestSaveManifest: (manifest: Record<string, unknown>): Promise<{ saved: boolean }> =>
    ipcRenderer.invoke('harvest-save-manifest', manifest),

  nliClassify: (pairs: Array<{ text_a: string; text_b: string }>): Promise<{ results: Array<{ nli_label: string; nli_entailment: number; nli_neutral: number; nli_contradiction: number; margin: number }> }> =>
    ipcRenderer.invoke('nli-classify', pairs),

  startChatStream: (systemInstruction: string, messages: { role: 'user' | 'model'; content: string }[], model?: string, temperature?: number, urlContext?: boolean): Promise<string> =>
    ipcRenderer.invoke('start-chat-stream', systemInstruction, messages, model, temperature, urlContext),
  onChatStreamChunk: (callback: (chunk: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: string) => callback(chunk);
    ipcRenderer.on('chat-stream-chunk', listener);
    return () => { ipcRenderer.removeListener('chat-stream-chunk', listener); };
  },
  onChatStreamDone: (callback: (fullText: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, fullText: string) => callback(fullText);
    ipcRenderer.on('chat-stream-done', listener);
    return () => { ipcRenderer.removeListener('chat-stream-done', listener); };
  },
  onChatStreamError: (callback: (error: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on('chat-stream-error', listener);
    return () => { ipcRenderer.removeListener('chat-stream-error', listener); };
  },
  onChatStreamUrlMetadata: (callback: (metadata: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, metadata: unknown) => callback(metadata);
    ipcRenderer.on('chat-stream-url-metadata', listener);
    return () => { ipcRenderer.removeListener('chat-stream-url-metadata', listener); };
  },

  onGenerateTextProgress: (callback: (progress: { attempt: number; maxRetries: number; backoffSeconds: number; limitType: string; limitMessage: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: { attempt: number; maxRetries: number; backoffSeconds: number; limitType: string; limitMessage: string }) => callback(progress);
    ipcRenderer.on('generate-text-progress', listener);
    return () => { ipcRenderer.removeListener('generate-text-progress', listener); };
  },

  // Brief-timeout events moved to a renderer-local bus (t/2307). The opening
  // pipeline runs in the renderer and the toast renders in the same window, so
  // main never produced these events — the 'brief-timeout' / 'brief-retries-exhausted'
  // IPC channels had zero senders. Removed to eliminate the dead listener.

  onReloadTaxonomy: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('reload-taxonomy', listener);
    return () => { ipcRenderer.removeListener('reload-taxonomy', listener); };
  },

  onFocusNode: (callback: (nodeId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, nodeId: string) => callback(nodeId);
    ipcRenderer.on('focus-node', listener);
    return () => { ipcRenderer.removeListener('focus-node', listener); };
  },

  focusNodeInMainWindow: (nodeId: string): void => {
    ipcRenderer.send('focus-node-in-main', nodeId);
  },

  growWindow: (deltaWidth: number): Promise<void> =>
    ipcRenderer.invoke('grow-window', deltaWidth),

  shrinkWindow: (deltaWidth: number): Promise<void> =>
    ipcRenderer.invoke('shrink-window', deltaWidth),

  isMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke('is-maximized'),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('open-external', url),

  // Node ↔ Source index
  buildNodeSourceIndex: (): Promise<unknown> =>
    ipcRenderer.invoke('build-node-source-index'),

  // Policy ↔ Source index
  buildPolicySourceIndex: (): Promise<unknown> =>
    ipcRenderer.invoke('build-policy-source-index'),

  // t/4342: per-node source index — Electron leg of t/4335's transport trio.
  getNodeSources: (nodeId: string): Promise<{ sources: SourceReference[]; cards: Record<string, SourceCardMeta>; indexVersion: number }> =>
    ipcRenderer.invoke('get-node-sources', nodeId),

  // Edges
  loadEdges: (): Promise<unknown> =>
    ipcRenderer.invoke('load-edges'),

  getEdgeDetail: (index: number): Promise<unknown> =>
    ipcRenderer.invoke('load-edge-detail', index),

  updateEdgeStatus: (index: number, status: string): Promise<unknown> =>
    ipcRenderer.invoke('update-edge-status', index, status),

  swapEdgeDirection: (index: number): Promise<unknown> =>
    ipcRenderer.invoke('swap-edge-direction', index),

  bulkUpdateEdges: (indices: number[], status: string): Promise<unknown> =>
    ipcRenderer.invoke('bulk-update-edges', indices, status),

  // Whole-file edge persistence (t/1816) — desktop transport for saveEdges.
  // electron-bridge delegates here; strongly typed on the renderer side (electron.d.ts).
  saveEdges: (data: unknown): Promise<void> =>
    ipcRenderer.invoke('save-edges', data),

  // Chat sessions
  listChatSessions: (): Promise<unknown[]> =>
    ipcRenderer.invoke('list-chat-sessions'),

  loadChatSession: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('load-chat-session', id),

  saveChatSession: (session: unknown): Promise<void> =>
    ipcRenderer.invoke('save-chat-session', session),

  deleteChatSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('delete-chat-session', id),

  // Source evidence (main process filesystem access)
  // t/3529: was `Promise<unknown>` — tightened to match the handler's real return shape
  // (`loadEvidenceIndex` in sourceHandlers.ts returns `null` on a missing/corrupt index
  // file, not just the index object), which the conformance check caught as a mismatch
  // against `electron.d.ts`'s already-correct `Promise<Record<string, unknown> | null>`.
  loadSourceEvidenceIndex: (): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('load-source-evidence-index'),
  loadDocTitles: (): Promise<Record<string, string> | null> =>
    ipcRenderer.invoke('load-doc-titles'),
  loadGreatestHits: (): Promise<{ node_ids: string[] } | null> =>
    ipcRenderer.invoke('load-greatest-hits'),
  // t/3529: both return types were `Promise<unknown>` — tightened to match the handlers'
  // real return shapes (sourceHandlers.ts / debateHandlers.ts always resolve one of these
  // exact shapes, never an arbitrary value), which the conformance check caught as
  // mismatches against electron.d.ts's already-correct declared types.
  getSourceEvidence: (nodeIds: string[], pov: string): Promise<{
    facts: unknown[]; keyPoints: unknown[]; formattedBlock: string;
    nodesCovered: string[]; totalCandidates: number;
  }> =>
    ipcRenderer.invoke('get-source-evidence', nodeIds, pov),
  runEvidenceQbaf: (claimText: string, claimId: string, model?: string): Promise<{
    computed_strength: number;
    qbaf_iterations: number;
    evidence_items: Array<{ id: string; source_doc_id: string; text: string; relation: 'support' | 'contradict'; similarity: number }>;
    claim_id: string;
  } | null> =>
    ipcRenderer.invoke('run-evidence-qbaf', claimText, claimId, model),

  // Debate sessions
  listDebateSessions: (): Promise<unknown[]> =>
    ipcRenderer.invoke('list-debate-sessions'),

  loadDebateSession: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('load-debate-session', id),

  saveDebateSession: (session: unknown, caller: string): Promise<void> =>
    ipcRenderer.invoke('save-debate-session', session, caller),

  deleteDebateSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('delete-debate-session', id),

  exportDebateToFile: (session: unknown, format?: string, exportOptions?: { includeTaxonomyRefs?: boolean; includeReasoning?: boolean }): Promise<{ cancelled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('export-debate-to-file', session, format, exportOptions),

  printBriefToPdf: (html: string): Promise<{ cancelled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('brief:html-to-pdf', html),

  // t/3529: format union was missing 'json' — the export-chat-to-file handler
  // (chatHandlers.ts) and bridge/types.ts's AppAPI both already support it; preload's
  // local type had simply never been updated. Caught by the conformance check, though
  // electron.d.ts's own (looser `string`/`unknown[]`) declaration for this method is a
  // separate, pre-existing imprecision not fixed here — flagged to Rosetta alongside t/3532.
  exportChatToFile: (
    entries: { id: string; timestamp: string; speaker: string; content: string; taxonomy_refs: { node_id: string; label?: string; relevance: string }[] }[],
    format: 'markdown' | 'text' | 'pdf' | 'json',
    options: { title: string; mode: 'brainstorm' | 'inform' | 'decide'; pov: 'accelerationist' | 'safetyist' | 'skeptic' },
  ): Promise<{ cancelled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('export-chat-to-file', entries, format, options),

  // Organizations (t/1544)
  // t/3532: return types were `Promise<unknown[]>`/`Promise<unknown>` — sharpened after
  // Rosetta verified organizationHandlers.ts delegates to typed functions returning these
  // exact shapes verbatim (t/3532#2).
  listOrganizations: (filters?: { type?: string; pov?: string }): Promise<Organization[]> =>
    ipcRenderer.invoke('list-organizations', filters),
  getOrganization: (id: string): Promise<Organization> =>
    ipcRenderer.invoke('get-organization', id),
  getOrganizationsByPov: (pov: string): Promise<Organization[]> =>
    ipcRenderer.invoke('get-organizations-by-pov', pov),
  getOrganizationsByTopic: (topicRef: string): Promise<Organization[]> =>
    ipcRenderer.invoke('get-organizations-by-topic', topicRef),
  getOrganizationsByPolicy: (policyId: string): Promise<Organization[]> =>
    ipcRenderer.invoke('get-organizations-by-policy', policyId),
  getOrganizationEdges: (orgId: string): Promise<OrganizationEdge[]> =>
    ipcRenderer.invoke('get-organization-edges', orgId),

  // Entity ref resolution (t/1809) — desktop transport for getEntity (t/1775).
  // t/3532: sharpened to EntityDetail — the handler is already explicitly typed this way
  // (Rosetta, t/3532#2), matching electron.d.ts exactly.
  getEntity: (ref: string): Promise<EntityDetail> =>
    ipcRenderer.invoke('entity-resolve', ref),

  // Entity list (t/1889) — desktop transport for listEntities (entity browser).
  // t/3532: sharpened to EntitySummary[] (handler explicitly typed this way).
  listEntities: (query?: EntityListQuery): Promise<EntitySummary[]> =>
    ipcRenderer.invoke('list-entities', query),

  // Container mentions (t/1903) — desktop transport for getContainerMentions.
  // t/3532: sharpened to ContainerMentions | null (handler explicitly typed this way).
  getContainerMentions: (containerId: string): Promise<ContainerMentions | null> =>
    ipcRenderer.invoke('get-container-mentions', containerId),

  loadDebateComments: (debateId: string): Promise<unknown> =>
    ipcRenderer.invoke('load-debate-comments', debateId),

  saveDebateComments: (debateId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('save-debate-comments', debateId, data),

  generateNewsReport: (debateId: string): Promise<{ article: string }> =>
    ipcRenderer.invoke('generate-news-report', debateId),

  // URL fetch (from main process to avoid CSP)
  fetchUrlContent: (url: string): Promise<{ content: string; error?: string }> =>
    ipcRenderer.invoke('fetch-url-content', url),

  // Community submit (from main process to avoid renderer CORS against the remote server)
  // t/3529: 'oped' was missing here — the IPC schema (communitySubmitSchema.ts) and
  // bridge/types.ts's AppAPI already accept it (t/2986 fixed those two; this one was
  // simply never updated), so a desktop op-ed share would have failed only at the type
  // level while working fine at runtime. Caught by the preload/electron.d.ts conformance check.
  communitySubmit: (
    baseUrl: string,
    payload: { type: 'chat' | 'debate' | 'oped' | 'inquiry'; data: unknown; note?: string },
  ): Promise<{ submissionId: string }> =>
    ipcRenderer.invoke('community-submit', baseUrl, payload),

  // File picker
  pickDocumentFile: (): Promise<{ cancelled: boolean; filePath?: string; content?: string }> =>
    ipcRenderer.invoke('pick-document-file'),

  // Taxonomy proposals (for batch approve UI)
  listProposals: (): Promise<unknown[]> =>
    ipcRenderer.invoke('list-proposals'),
  saveProposal: (filename: string, data: unknown): Promise<{ saved?: boolean; error?: string }> =>
    ipcRenderer.invoke('save-proposal', filename, data),

  // PowerShell prompt files (for Prompt Inspector)
  readPsPrompt: (promptName: string, dir = 'ps'): Promise<{ text: string | null; error?: string }> =>
    ipcRenderer.invoke('read-ps-prompt', promptName, dir),
  listPsPrompts: (): Promise<string[]> =>
    ipcRenderer.invoke('list-ps-prompts'),

  // Research file access (path-validated)
  readResearchFile: (relativePath: string): Promise<unknown> =>
    ipcRenderer.invoke('read-research-file', relativePath),
  writeResearchFile: (relativePath: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('write-research-file', relativePath, data),

  // Synthetic corpus
  loadSyntheticCorpus: (pov: string): Promise<unknown | null> =>
    ipcRenderer.invoke('load-synthetic-corpus', pov),
  updateSyntheticEmbeddings: (nodeId: string, pov: string, vectors: number[][]): Promise<void> =>
    ipcRenderer.invoke('update-synthetic-embeddings', nodeId, pov, vectors),
  loadSyntheticEmbeddings: (): Promise<Record<string, { pov: string; vectors: number[][] }> | null> =>
    ipcRenderer.invoke('load-synthetic-embeddings'),

  // Feedback & error reporting
  submitFeedback: (rating: string, text?: string, category?: string, context?: Record<string, unknown>): Promise<{ ok: boolean; id?: string }> =>
    ipcRenderer.invoke('submit-feedback', rating, text, category, context),
  reportError: (error: Record<string, unknown>, context?: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('report-error', error, context),

  // Clipboard (Electron 40: renderer clipboard API deprecated)
  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard-write-text', text),

  // Screenshot capture
  captureScreenshot: (opts?: { width?: number; height?: number; defaultName?: string }): Promise<{ cancelled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('capture-screenshot', opts),

  // Terminal
  terminalSpawn: (): Promise<void> =>
    ipcRenderer.invoke('terminal:spawn'),
  terminalWrite: (data: string): Promise<void> =>
    ipcRenderer.invoke('terminal:write', data),
  terminalResize: (cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', cols, rows),
  terminalKill: (): Promise<void> =>
    ipcRenderer.invoke('terminal:kill'),
  onTerminalData: (callback: (data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on('terminal:data', handler);
    return () => { ipcRenderer.removeListener('terminal:data', handler); };
  },
  onTerminalExit: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('terminal:exit', handler);
    return () => { ipcRenderer.removeListener('terminal:exit', handler); };
  },

  // Community review (Azure Blob — desktop admin)
  adminReviewConfigured: (): Promise<boolean> =>
    ipcRenderer.invoke('admin-review-configured'),
  adminReviewQueue: (): Promise<unknown> =>
    ipcRenderer.invoke('admin-review-queue'),
  adminReviewStats: (): Promise<unknown> =>
    ipcRenderer.invoke('admin-review-stats'),
  adminReviewDetail: (groupId: string): Promise<unknown> =>
    ipcRenderer.invoke('admin-review-detail', groupId),
  adminReviewAction: (action: unknown): Promise<void> =>
    ipcRenderer.invoke('admin-review-action', action),
  adminRemoveCommunityItem: (type: string, id: string, reason?: string): Promise<void> =>
    ipcRenderer.invoke('admin-remove-community-item', type, id, reason),

  // Op-Ed Studio (t/2575, t/2591)
  createOpEdSet: (payload: { topic: string; url?: string; params: unknown; voices: string[] }): Promise<{ set_id: string }> =>
    ipcRenderer.invoke('create-oped-set', payload),
  cancelOpEdSet: (setId: string): void =>
    void ipcRenderer.invoke('cancel-oped-set', setId),
  exportOpEdSet: (setId: string): Promise<{ cancelled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('export-oped-set', setId),
  onOpEdProgress: (callback: (event: { set_id: string; voice: string; stage: string; error?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { set_id: string; voice: string; stage: string; error?: string }) => callback(data);
    ipcRenderer.on('oped-progress', listener);
    return () => { ipcRenderer.removeListener('oped-progress', listener); };
  },
  listOpEdSets: (): Promise<OpEdSetSummary[]> =>
    ipcRenderer.invoke('list-oped-sets'),
  loadOpEdSet: (setId: string): Promise<OpEdSet> =>
    ipcRenderer.invoke('load-oped-set', setId),
  deleteOpEdSet: (setId: string): Promise<void> =>
    ipcRenderer.invoke('delete-oped-set', setId),
  saveOpEdSet: (set: OpEdSet): Promise<void> =>
    ipcRenderer.invoke('save-oped-set', set),

  // Brief Export — desktop parity (t/2840). Mirrors the web AppAPI; download returns raw bytes
  // that the electron-bridge wraps into a Blob (Blob-returning AppAPI in both builds).
  createBriefExport: (debateId: string, body: unknown): Promise<{ jobId: string }> =>
    ipcRenderer.invoke('create-brief-export', debateId, body),
  // t/3529: was `Promise<unknown>` — tightened to match the handler's real return shape
  // (briefExportHandlers.ts's get-brief-export-job always resolves this exact shape or
  // throws). Mirrors electron.d.ts's `BriefExportJobView` structurally, importing the two
  // literal-union types from the shared lib/brief/types.js (safe under both tsconfigs)
  // rather than importing BriefExportJobView itself from renderer/bridge/types.ts — that
  // file is a real .ts (not .d.ts), so tsconfig.main.json's stricter nodenext resolution
  // would fully type-check it and hit its renderer-only `@lib/*` path aliases, which don't
  // resolve under main's config. Caught only under the RENDERER tsconfig, not
  // tsconfig.main.json — this check must run under both, not just one.
  getBriefExportJob: (jobId: string): Promise<{
    status: ExportJobState; progressPct: number; warnings: string[];
    error: string | null; errorCode: ExportErrorCode | null; exportId: string | null;
  }> =>
    ipcRenderer.invoke('get-brief-export-job', jobId),
  // t/3532: was `Promise<unknown[]>` — sharpened to mirror electron.d.ts's BriefExportRecord
  // structurally (defined directly in bridge/types.ts, inlined here for the same reason as
  // BriefExportJobView in t/3529). narratorModel/narratorModelSource are optional: they're
  // populated only on the server/web path (src/server/briefExportJobs.ts,
  // briefExportStore.ts) — this desktop handler never sets them by design, not a gap
  // (TL ruling, t/3532#3; Rosetta made the shared type optional to match).
  listBriefExports: (debateId: string): Promise<{
    exportId: string; debateId: string; title: string; preset: BriefPreset;
    status: 'done' | 'failed'; errorCode?: ExportErrorCode; reason?: string;
    narratorModel?: string; narratorModelSource?: string; checkerModel?: string | null;
    formats: string[]; artifacts: BriefArtifactName[]; traceCoveragePct: number;
    warnings: string[]; createdAt: string;
  }[]> =>
    ipcRenderer.invoke('list-brief-exports', debateId),
  downloadBriefArtifact: (exportId: string, name: string): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('download-brief-artifact', exportId, name),
  deleteBriefExport: (exportId: string): Promise<void> =>
    ipcRenderer.invoke('delete-brief-export', exportId),

  // Inquiry — desktop parity (t/3579). Response field names match the web REST contract's
  // InquiryStatusResponse verbatim (Rosetta Stone t/3582#2) so the bridge polls both builds
  // identically. `idempotencyKey` is accepted for signature parity with the web bridge but
  // unused here — desktop is single-user/single-process, so there is no idempotency window
  // to dedupe against (mirrors briefExportHandlers.ts dropping server-only concerns).
  startInquiry: (request: InquiryRequest, _idempotencyKey?: string): Promise<{ jobId: string }> =>
    ipcRenderer.invoke('start-inquiry', request),
  getInquiry: (jobId: string): Promise<{
    jobId: string;
    status: 'queued' | 'grounding' | 'debating' | 'judging' | 'synthesizing' | 'done' | 'done_truncated' | 'failed';
    progressPct: number;
    terminationReason: string | null; resultId: string | null; error: string | null;
    result?: InquiryResult;
  } | null> =>
    ipcRenderer.invoke('get-inquiry', jobId),
  // "My Questions" history + export (t/3683). listInquiries reads the local persisted index
  // (survives the get-inquiry job's TTL sweep / an app restart); exportInquiryToFile shows a
  // native save dialog and writes the requested format (PDF rendered via printToPDF).
  listInquiries: (): Promise<{
    jobId: string; question: string; debateId: string | null;
    truncated: boolean; terminationReason?: string; createdAt: string;
  }[]> =>
    ipcRenderer.invoke('list-inquiries'),
  exportInquiryToFile: (
    result: InquiryResult, title: string, format: 'json' | 'markdown' | 'pdf',
  ): Promise<{ cancelled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('export-inquiry-to-file', result, title, format),
  };
}

export type PreloadElectronAPI = ReturnType<typeof buildElectronApi>;

try {
  contextBridge.exposeInMainWorld('electronAPI', buildElectronApi());
  console.log('[preload] electronAPI exposed');
  ipcRenderer.send('forward-flight-event', {
    type: 'lifecycle', component: 'preload', level: 'info',
    message: 'contextBridge.exposeInMainWorld completed',
  });
} catch (e) {
  ipcRenderer.send('forward-flight-event', {
    type: 'system.error', component: 'preload', level: 'error',
    message: 'contextBridge.exposeInMainWorld failed — window.electronAPI will not be set',
    error: { name: e instanceof Error ? e.name : 'Error', message: String(e) },
  });
  throw e;
}

// Wire IPC listeners AFTER exposeInMainWorld so window.electronAPI is always set
// even if a listener registration throws (t/2772).
try {
  ipcRenderer.on('debate-window-load', (_event, debateId: string) => {
    if (_debateBufferActive) _bufferedDebateId = debateId;
  });
  ipcRenderer.on('chat-window-load', (_event, chatId: string) => {
    if (_chatBufferActive) _bufferedChatId = chatId;
  });
  ipcRenderer.on('diagnostics-state-update', (_event, state: unknown) => {
    _diagnosticsStateBuffer.onIpc(state);
  });
} catch (e) {
  console.error('[preload] listener wiring failed', e);
}
