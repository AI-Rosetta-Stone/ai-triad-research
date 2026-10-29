// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Organization, OrganizationEdge } from '@lib/organizations/types';
import type { EntityDetail, EntitySummary, EntityListQuery } from '@lib/entities/types';
import type { ContainerMentions } from '@lib/entities/mentionTypes';
import type { EdgesFile } from '@lib/debate/taxonomyTypes';
import type { UserPreferences, BriefExportRequest, BriefExportJobView, BriefExportRecord, FetchRelevantNodesPayload, RelevantTaxonomyResult, FetchClaimAttributionPayload, ClaimAttributionResponse, GenerateTextIpcPayload, StartInquiryRequest, InquiryStatusResponse, InquiryResult, InquiryResultSummary, NodeDeleteLogEntry, RefreshModelsRequest, RefreshModelsResponse } from '../bridge/types';
import type { BriefArtifactName } from '../../../../lib/brief/types';
import type { StopReason } from '@lib/ai-client/types';
import type { OpEdSet, OpEdSetSummary } from '@lib/oped/types';
import type { SourceReference, SourceCardMeta } from '@lib/sourceIndex/types';

export interface ElectronAPI {
  // Inquiry — desktop parity (t/3579). idempotencyKey accepted for signature parity with the
  // web bridge; unused on desktop (single-process, no idempotency window to dedupe against).
  // `getInquiry` resolves null when the job is unknown (electron-bridge.ts maps this to a thrown
  // error for AppAPI parity with the web bridge's 404). Types imported from bridge/types.ts
  // (t/3582) — StartInquiryRequest/InquiryRequest and InquiryStatusResponse are structurally
  // identical to the REST contract either way; consolidated here per t/3579#1 (ElectronMain) to
  // drop the transient local duplicates from t/3579's initial landing.
  startInquiry: (request: StartInquiryRequest, idempotencyKey?: string) => Promise<{ jobId: string }>;
  getInquiry: (jobId: string) => Promise<InquiryStatusResponse | null>;
  /** "My Questions" history (t/3683) — reads the desktop-local persisted index. */
  listInquiries: () => Promise<InquiryResultSummary[]>;
  /** Export an inquiry answer via a native save dialog (t/3683). */
  exportInquiryToFile: (
    result: InquiryResult,
    title: string,
    format: 'json' | 'markdown' | 'pdf',
  ) => Promise<{ cancelled: boolean; filePath?: string }>;

  // Brief Export — desktop parity (t/2840). download returns raw bytes (the bridge wraps a Blob).
  createBriefExport: (debateId: string, body: BriefExportRequest) => Promise<{ jobId: string }>;
  getBriefExportJob: (jobId: string) => Promise<BriefExportJobView>;
  listBriefExports: (debateId: string) => Promise<BriefExportRecord[]>;
  downloadBriefArtifact: (exportId: string, name: BriefArtifactName) => Promise<Uint8Array | null>;
  deleteBriefExport: (exportId: string) => Promise<void>;
  /** t/3532: typed to match preload.cts's actual `{ ...process.versions }` spread exactly
   *  (NodeJS.ProcessVersions, augmented with `electron`/`chrome` by Electron's own ambient
   *  types) — a generic `Record<string, string | undefined>` satisfied the old one-directional
   *  check but failed the reverse: an index signature isn't assignable to a type with specific
   *  required named properties (electron, chrome, node, v8, ...). */
  processVersions: NodeJS.ProcessVersions;
  osRelease: string;
  /** t/3532: process.platform/process.arch, exposed synchronously alongside osRelease. Typed
   *  to match preload.cts's actual `process.platform`/`process.arch` values exactly — a plain
   *  `string` would satisfy preload→declared assignability but fail the reverse (mutual)
   *  direction, since not every string is a valid NodeJS.Platform/Architecture literal. */
  osPlatform: NodeJS.Platform;
  osArch: NodeJS.Architecture;
  /** t/2766: performance.now() stamp from when contextBridge.exposeInMainWorld ran. */
  preloadTimestamp: number;
  getEmbeddingInfo: () => Promise<{ backend: string; execution_provider?: string; calibration_version?: number }>;

  // User preferences (t/2118) — optional until handler confirmed present
  getPreferences?: () => Promise<UserPreferences | null>;
  setPreferences?: (prefs: UserPreferences) => Promise<void>;

  // Taxonomy directories
  getTaxonomyDirs: () => Promise<string[]>;
  getActiveTaxonomyDir: () => Promise<string>;
  setTaxonomyDir: (dirName: string) => Promise<void>;

  // Taxonomy CRUD
  loadTaxonomyFile: (pov: string) => Promise<unknown>;
  saveTaxonomyFile: (pov: string, data: unknown) => Promise<void>;
  // New-edge persistence (t/1816) — unconditionally implemented since; required-ness
  // verified t/3532.
  saveEdges: (data: EdgesFile) => Promise<void>;
  loadPolicyRegistry: () => Promise<unknown>;
  // t/4034/t/4038: typed from the shared contract (lib/policy/registryRecount.ts).
  recountPolicyMembers: (ids: string[]) => Promise<import('@lib/policy/registryRecount').RecountPolicyMembersResult>;
  // t/4052/t/4054: typed from the shared contract (lib/schema/povTagProposals.ts).
  loadPovTagProposals: () => Promise<import('@lib/schema/povTagProposals').PovTagProposalsFile | null>;
  reviewPovTagProposal: (nodeId: string, decision: import('@lib/schema/povTagProposals').ProposalDecision, expectedStatus: import('@lib/schema/povTagProposals').ProposalStatus) => Promise<import('@lib/schema/povTagProposals').ApplyProposalDecisionResult>;
  loadLineageCategories: () => Promise<unknown>;
  // t/3852/t/3859: durable delete-audit log. Optional until the IPC handler lands
  // (ElectronMain) — the bridge graceful-degrades (WARN + resolve) while absent.
  logNodeDeletion?: (entry: NodeDeleteLogEntry) => Promise<void>;
  loadLineageInfo: () => Promise<Record<string, unknown>>;
  loadEdges: () => Promise<unknown>;
  getEdgeDetail: (index: number) => Promise<unknown>;
  updateEdgeStatus: (index: number, status: string) => Promise<unknown>;
  swapEdgeDirection: (index: number) => Promise<unknown>;
  bulkUpdateEdges: (indices: number[], status: string) => Promise<unknown>;
  buildNodeSourceIndex: () => Promise<unknown>;
  buildPolicySourceIndex: () => Promise<unknown>;
  // t/4335: optional — ElectronMain's IPC handler (main/ipc/taxonomyHandlers.ts + preload.cts)
  // hasn't landed yet (child ticket filed); electron-bridge.ts falls back when absent.
  getNodeSources?: (nodeId: string) => Promise<{ sources: SourceReference[]; cards: Record<string, SourceCardMeta>; indexVersion: number }>;

  // Conflict CRUD
  loadConflictFiles: () => Promise<unknown[]>;
  // Unconditionally implemented in preload.cts; required-ness verified t/3532.
  loadConflictClusters: () => Promise<unknown | null>;
  loadAggregatedCruxes: () => Promise<unknown | null>;
  saveConflictFile: (claimId: string, data: unknown) => Promise<void>;
  createConflictFile: (claimId: string, data: unknown) => Promise<void>;
  deleteConflictFile: (claimId: string) => Promise<void>;

  // Summaries & Sources
  discoverSources: () => Promise<unknown[]>;
  loadSummary: (docId: string) => Promise<unknown | null>;
  loadSnapshot: (sourceId: string) => Promise<{ content: string } | null>;
  resolveSourceDocument: (docId: string) => Promise<{ available: boolean; type: 'pdf' | 'markdown' | null; content?: string; path?: string }>;
  loadSourceEvidenceIndex: () => Promise<Record<string, unknown> | null>;
  loadDocTitles: () => Promise<Record<string, string> | null>;
  // IPC handler (`load-greatest-hits`, ElectronMain, t/1998) — unconditionally implemented
  // since; required-ness verified t/3532. electron-bridge.ts's `?.() ?? null` fallback is
  // harmless on a required function and left as-is.
  loadGreatestHits: () => Promise<{ node_ids: string[] } | null>;
  getSourceEvidence: (nodeIds: string[], pov: string) => Promise<{
    facts: unknown[]; keyPoints: unknown[]; formattedBlock: string;
    nodesCovered: string[]; totalCandidates: number;
  }>;
  runEvidenceQbaf: (claimText: string, claimId: string, model?: string) => Promise<{
    computed_strength: number;
    qbaf_iterations: number;
    evidence_items: Array<{ id: string; source_doc_id: string; text: string; relation: 'support' | 'contradict'; similarity: number }>;
    claim_id: string;
  } | null>;

  // Data management
  isDataAvailable: () => Promise<boolean>;
  getDataRoot: () => Promise<string>;
  cloneDataRepo: (targetPath: string) => Promise<{ success: boolean; message: string }>;
  setDataRoot: (newRoot: string) => Promise<void>;
  pickDirectory: (defaultPath?: string) => Promise<{ cancelled: boolean; path?: string }>;
  checkDataUpdates: () => Promise<unknown>;
  pullDataUpdates: () => Promise<unknown>;
  getChangedFiles: () => Promise<{ path: string; status: string }[]>;
  getFileDiff: (filePath: string) => Promise<string>;

  // AI models & keys
  loadAIModels: () => Promise<unknown>;
  refreshAIModels: (opts?: RefreshModelsRequest) => Promise<RefreshModelsResponse>;
  // Unconditionally implemented in preload.cts; required-ness verified t/3532.
  validateApiKey: (key: string, backend: string) => Promise<{ valid: boolean; error?: string }>;
  verifyStoredKeys: (backend: string) => Promise<{ results: { index: number; masked: string; valid: boolean; error?: string }[] }>;
  setApiKey: (key: string, backend?: string) => Promise<void>;
  hasApiKey: (backend?: string) => Promise<boolean>;
  addApiKey: (key: string, backend?: string) => Promise<number>;
  removeApiKey: (index: number, backend?: string) => Promise<void>;
  getApiKeys: (backend?: string) => Promise<string[]>;
  deleteApiKey: (backend?: string) => Promise<void>;
  deleteAllApiKeys: () => Promise<void>;
  // t/3532: preload.cts's actual return also carries keyCount/maskedKeys (multi-key
  // backends) — this declaration was under-specified, not preload over-claiming.
  getApiKeySummary: () => Promise<{ backend: string; hasKey: boolean; maskedKey: string | null; keyCount: number; maskedKeys: string[] }[]>;
  exportKeysForSharing: (passphrase: string) => Promise<{ dataUrl: string; payloadText: string }>;
  importKeysFromSharing: (payload: { v: number; salt: string; iv: string; data: string; tag: string }, passphrase: string) => Promise<string[]>;

  // AI generation
  // Single-payload signature (t/3528) — see GenerateTextIpcPayload. `requestId` (t/2508)
  // correlates the request so `cancelGenerate` can abort the exact in-flight provider call.
  // t/4048: servedModel is the registry id the call actually resolved to (after defaulting) —
  // present so the debate store can mark a renderer run 'tracked' (e/268#6 condition 3).
  // 'tracked' = failover-tracked, NOT provider-identity-verified; provider-side substitution
  // is the ai.model_identity FR event's job (t/3731). See bridge/types.ts generateText doc.
  generateText: (payload: GenerateTextIpcPayload) => Promise<{ text: string; stopReason?: StopReason; servedModel?: string }>;
  // Fire-and-forget cancel for an in-flight generateText (t/2508, wired t/2509) —
  // unconditionally implemented since; required-ness verified t/3532. electron-bridge.ts's
  // `?.()` call site is harmless on a required function and left as-is.
  cancelGenerate: (requestId: string) => void;
  generateTextWithSearch: (prompt: string, model?: string) => Promise<{
    text: string;
    searchQueries?: string[];
    citations?: { uri: string; title: string; segments: { startIndex: number; endIndex: number; text?: string; confidence?: number }[] }[];
  }>;
  startChatStream: (systemInstruction: string, messages: { role: 'user' | 'model'; content: string }[], model?: string, temperature?: number, urlContext?: boolean) => Promise<string>;
  onChatStreamChunk: (callback: (chunk: string) => void) => () => void;
  onChatStreamDone: (callback: (fullText: string) => void) => () => void;
  onChatStreamError: (callback: (error: string) => void) => () => void;
  onChatStreamUrlMetadata: (callback: (metadata: unknown) => void) => () => void;
  setDebateTemperature: (temp: number | null) => Promise<void>;
  onGenerateTextProgress: (callback: (progress: { attempt: number; maxRetries: number; backoffSeconds: number; limitType: string; limitMessage: string }) => void) => () => void;
  // onBriefTimeout / onBriefRetriesExhausted removed (t/2307) — brief-timeout now
  // uses a renderer-local bus in electron-bridge, not an IPC channel on electronAPI.

  // Embeddings & NLI
  computeEmbeddings: (texts: string[], ids?: string[]) => Promise<{ vectors: number[][] }>;
  updateNodeEmbeddings: (nodes: { id: string; text: string; pov: string; exclusionText?: string }[]) => Promise<{ staleNodeIds: string[] }>;
  computeQueryEmbedding: (text: string) => Promise<{ vector: number[] }>;
  // t/3258 (T3): the renderer's view of the main-process handler ElectronMain implements in preload —
  // mirrors routes/relevantNodes.ts via the shared lib (parity by construction). Contract shared with
  // the web transport through bridge/types.ts.
  fetchRelevantNodes: (payload: FetchRelevantNodesPayload) => Promise<RelevantTaxonomyResult>;
  // t/3316: the renderer's view of the main-process attribution handler ElectronMain implements (t/3322)
  // — computes from the LOCAL corpus via the same pure fn. Contract shared with web via bridge/types.ts.
  computeAttribution: (payload: FetchClaimAttributionPayload) => Promise<ClaimAttributionResponse>;
  nliClassify: (pairs: Array<{ text_a: string; text_b: string }>) => Promise<{ results: Array<{ nli_label: string; nli_entailment: number; nli_neutral: number; nli_contradiction: number; margin: number }> }>;

  // Debate sessions
  listDebateSessions: () => Promise<unknown[]>;
  loadDebateSession: (id: string) => Promise<unknown>;
  saveDebateSession: (session: unknown, caller: string) => Promise<void>;
  deleteDebateSession: (id: string) => Promise<void>;
  exportDebateToFile: (session: unknown, format?: string, exportOptions?: { includeTaxonomyRefs?: boolean; includeReasoning?: boolean }) => Promise<{ cancelled: boolean; filePath?: string }>;
  printBriefToPdf: (html: string) => Promise<{ cancelled: boolean; filePath?: string }>;
  loadDebateComments: (debateId: string) => Promise<unknown>;
  saveDebateComments: (debateId: string, data: unknown) => Promise<void>;
  generateNewsReport: (debateId: string) => Promise<{ article: string }>;

  // Chat sessions
  listChatSessions: () => Promise<unknown[]>;
  loadChatSession: (id: string) => Promise<unknown>;
  saveChatSession: (session: unknown) => Promise<void>;
  deleteChatSession: (id: string) => Promise<void>;
  exportChatToFile: (
    entries: { id: string; timestamp: string; speaker: string; content: string; taxonomy_refs: { node_id: string; label?: string; relevance: string }[] }[],
    format: 'markdown' | 'text' | 'pdf' | 'json',
    options: { title: string; mode: 'brainstorm' | 'inform' | 'decide'; pov: 'accelerationist' | 'safetyist' | 'skeptic' },
  ) => Promise<{ cancelled: boolean; filePath?: string }>;

  // Op-Ed Studio (t/2575, t/2576, t/2591) — declared t/3532; preload.cts implemented these
  // unconditionally, but electron.d.ts never declared them, forcing 3 renderer call sites to
  // bypass this interface with local ad-hoc types / an `as unknown as` cast (t/3529 conformance
  // check finding). `params: unknown` on createOpEdSet matches preload.cts's actual (looser)
  // implementation — AppAPI's CreateOpEdPayload types it as CreateOpEdParams, an unverified
  // claim about IPC-handler-side validation; restating that here would just be conformance
  // theatre (t/3529#6 reasoning) without adding real safety, since preload also allows any value.
  createOpEdSet: (payload: { topic: string; url?: string; params: unknown; voices: string[] }) => Promise<{ set_id: string }>;
  cancelOpEdSet: (setId: string) => void;
  exportOpEdSet: (setId: string) => Promise<{ cancelled: boolean; filePath?: string }>;
  onOpEdProgress: (callback: (event: { set_id: string; voice: string; stage: string; error?: string }) => void) => () => void;
  listOpEdSets: () => Promise<OpEdSetSummary[]>;
  loadOpEdSet: (setId: string) => Promise<OpEdSet>;
  deleteOpEdSet: (setId: string) => Promise<void>;
  saveOpEdSet: (set: OpEdSet) => Promise<void>;

  // Harvest
  harvestCreateConflict: (conflict: Record<string, unknown>) => Promise<{ created: boolean }>;
  harvestAddDebateRef: (nodeId: string, debateId: string) => Promise<{ updated: boolean }>;
  harvestUpdateSteelman: (nodeId: string, attackerPov: string, newText: string) => Promise<{ updated: boolean }>;
  harvestAddVerdict: (conflictId: string, verdict: Record<string, unknown>) => Promise<{ updated: boolean }>;
  harvestQueueConcept: (concept: Record<string, unknown>) => Promise<{ queued: boolean }>;
  harvestSaveManifest: (manifest: Record<string, unknown>) => Promise<{ saved: boolean }>;

  // Dictionary
  loadDictionary: () => Promise<{ standardized: unknown[]; colloquial: unknown[]; lintViolations: unknown[] }>;

  // Proposals
  listProposals: () => Promise<unknown[]>;
  saveProposal: (filename: string, data: unknown) => Promise<{ saved?: boolean; error?: string }>;

  // PowerShell prompts
  readPsPrompt: (promptName: string, dir?: string) => Promise<{ text: string | null; error?: string }>;
  listPsPrompts: () => Promise<string[]>;

  // Research file access
  readResearchFile: (relativePath: string) => Promise<unknown>;
  writeResearchFile: (relativePath: string, data: unknown) => Promise<void>;

  // Synthetic corpus
  loadSyntheticCorpus: (pov: string) => Promise<unknown | null>;
  loadSyntheticEmbeddings: () => Promise<Record<string, { pov: string; vectors: number[][] }> | null>;
  updateSyntheticEmbeddings: (nodeId: string, pov: string, vectors: number[][]) => Promise<void>;

  // Feedback & error reporting
  submitFeedback: (rating: string, text?: string, category?: string, context?: Record<string, unknown>) => Promise<{ ok: boolean; id?: string }>;
  reportError: (error: { name: string; message: string; stack?: string; componentStack?: string }, context?: Record<string, unknown>) => Promise<{ ok: boolean }>;

  // Calibration
  getCalibrationHistory: () => Promise<{ current: unknown; history: unknown[] }>;
  getCalibrationLog: () => Promise<{ entries: unknown[]; validationReport: unknown }>;

  // Diagnostics
  openDiagnosticsWindow: () => Promise<void>;
  openPovProgressionWindow: () => Promise<void>;
  closeDiagnosticsWindow: () => Promise<void>;
  // t/4642: main.ts's IPC handler only ever resolves 'focused' or 'not-open' — electron-bridge.ts
  // decides 'inline' itself (narrow-window drawer) before this is ever called.
  focusDiagnosticsWindow: () => Promise<'focused' | 'not-open'>;
  sendDiagnosticsState: (state: unknown) => void;
  onDiagnosticsStateUpdate: (callback: (state: unknown) => void) => () => void;
  onDiagnosticsPopoutClosed: (callback: () => void) => () => void;

  // Debate popout
  openDebateWindow: (debateId: string, source?: string) => Promise<{ atCap: true } | void>;
  closeDebateWindow: (debateId: string) => Promise<void>;
  getCliFileArg: () => Promise<{ type: string; path: string; data?: unknown; error?: string } | null>;
  onDebateWindowLoad: (callback: (debateId: string) => void) => () => void;
  onDebatePopoutClosed: (callback: (debateId: string) => void) => () => void;
  requestReExtractClaims: (entryId: string) => void;
  onReExtractClaims: (callback: (entryId: string) => void) => () => void;

  // Data file diff popout
  openDiffWindow: (filePath: string) => Promise<void>;

  // Prompt Diff popout
  openPromptDiffWindow: (debateId: string, entryId: string) => Promise<void>;
  onPromptDiffContext: (callback: (ctx: { debateId: string; entryId: string }) => void) => void;

  // Chat popout
  openChatWindow: (chatId: string, source?: 'my' | 'community') => Promise<{ atCap: true } | void>;
  onChatPopoutClosed: (callback: (chatId: string) => void) => () => void;
  onChatWindowLoad: (callback: (chatId: string) => void) => () => void;

  // Flight recorder
  dumpFlightRecorder: (ndjson: string, dumpId?: string) => Promise<{ filePath: string; filename: string }>;
  openFile: (filePath: string) => Promise<void>;
  openFlightRecorderViewer: (dumpPath: string) => Promise<void>;
  // Unconditionally implemented in preload.cts; required-ness verified t/3532.
  forwardFlightEvent: (event: unknown) => void;
  triggerMainDump: () => Promise<{ filePath: string }>;
  onTriggerDump: (callback: () => void) => () => void;
  sendDumpResult: (result: { filePath: string }) => void;
  /** t/3532: raw `ipcRenderer.on` passthrough (event, payload) — the popout window's flight
   *  events forwarded to the main window, unwrapped like other on* handlers below. */
  onFlightEventFromPopup: (callback: (_e: unknown, payload: unknown) => void) => void;

  // Terminal
  terminalSpawn: () => Promise<void>;
  terminalWrite: (data: string) => Promise<void>;
  terminalResize: (cols: number, rows: number) => Promise<void>;
  terminalKill: () => Promise<void>;
  onTerminalData: (callback: (data: string) => void) => () => void;
  onTerminalExit: (callback: () => void) => () => void;

  // File operations
  fetchUrlContent: (url: string) => Promise<{ content: string; error?: string }>;
  pickDocumentFile: () => Promise<{ cancelled: boolean; filePath?: string; content?: string }>;
  clipboardWriteText: (text: string) => Promise<void>;

  // Window control
  growWindow: (deltaWidth: number) => Promise<void>;
  shrinkWindow: (deltaWidth: number) => Promise<void>;
  isMaximized: () => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;

  // Event listeners
  onReloadTaxonomy: (callback: () => void) => () => void;
  onFocusNode: (callback: (nodeId: string) => void) => () => void;
  focusNodeInMainWindow: (nodeId: string) => void;
  captureScreenshot: (opts?: { width?: number; height?: number; defaultName?: string }) => Promise<{ cancelled: boolean; filePath?: string }>;

  // Community
  communitySubmit: (baseUrl: string, payload: { type: 'chat' | 'debate' | 'oped' | 'inquiry'; data: unknown; note?: string }) => Promise<{ submissionId: string }>;

  // Admin Review
  adminReviewConfigured: () => Promise<boolean>;
  adminReviewQueue: () => Promise<unknown>;
  adminReviewStats: () => Promise<unknown>;
  adminReviewDetail: (groupId: string) => Promise<unknown>;
  adminReviewAction: (action: unknown) => Promise<void>;
  adminRemoveCommunityItem: (type: string, id: string, reason?: string) => Promise<void>;

  // Organizations. Were marked optional pending ElectronMain wiring; all unconditionally
  // implemented in preload.cts now — verified + sharpened from Promise<unknown> t/3532,
  // required-ness verified t/3532 (mutual-assignability flip).
  listOrganizations: (filters?: { type?: string; pov?: string }) => Promise<Organization[]>;
  getOrganization: (id: string) => Promise<Organization>;
  getOrganizationsByPov: (pov: string) => Promise<Organization[]>;
  getOrganizationsByTopic: (topicRef: string) => Promise<Organization[]>;
  getOrganizationsByPolicy: (policyId: string) => Promise<Organization[]>;
  getOrganizationEdges: (orgId: string) => Promise<OrganizationEdge[]>;

  // Entity / ref resolution (t/1775, wired t/1809) — unconditionally implemented since;
  // required-ness verified t/3532.
  getEntity: (ref: string) => Promise<EntityDetail>;

  // Entity list/browser (t/1883) — unconditionally implemented since; required-ness
  // verified t/3532.
  listEntities: (query?: EntityListQuery) => Promise<EntitySummary[]>;

  // Container mentions (t/1901, wired t/1903) — unconditionally implemented since;
  // required-ness verified t/3532.
  getContainerMentions: (id: string) => Promise<ContainerMentions | null>;

  // User preferences (t/2117). Optional — wired by ElectronMain in t/2118.
  // Until then the bridge degrades gracefully (returns null / no-ops).
  getPreferences?: () => Promise<UserPreferences | null>;
  setPreferences?: (prefs: UserPreferences) => Promise<void>;

  // Deep-link URL
  getWebAppUrl?: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
