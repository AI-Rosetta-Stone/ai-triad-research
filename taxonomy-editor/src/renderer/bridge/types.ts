// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * AppAPI — the bridge interface between the renderer and the backend.
 *
 * In Electron builds, this is implemented by delegating to window.electronAPI (IPC).
 * In web/container builds, this is implemented via REST + WebSocket calls to the server.
 *
 * Every renderer file should import `api` from '@bridge' instead of accessing
 * window.electronAPI directly.
 */

import type { StopReason, ProviderCallDiagnostics } from '@lib/ai-client/types';
import type { PovTagProposalsFile, ProposalDecision, ProposalStatus, ApplyProposalDecisionResult } from '@lib/schema/povTagProposals';
import type { RecountPolicyMembersResult } from '@lib/policy/registryRecount';
import type { RefreshResult, RefreshAccept } from '@lib/electron-shared/modelDiscovery';
import type { SourceReference as _SourceReference, SourceCardMeta as _SourceCardMeta } from '@lib/sourceIndex/types';

/**
 * What the renderer may send to a model refresh (t/4031). No argument is a plain refresh, exactly as before.
 * `accept` carries only what a person supplies: the exact proposal they were shown, their name and their reason.
 * Who is authenticated is never the renderer's to say; the host sets that (TL t/4031#2, adjustment 3).
 */
export interface RefreshModelsRequest {
  dryRun?: boolean;
  accept?: Pick<RefreshAccept, 'proposal' | 'approvedBy' | 'reason'>;
}

/**
 * t/4232 (SO e/297#4 C6): a call with no `accept` is coerced into a dry run rather than
 * silently writing. `coerced` is present and true only when that coercion happened — a caller
 * that explicitly asked for a dry run, or supplied `accept`, never gets `coerced: true`.
 */
export interface RefreshModelsResponse extends RefreshResult {
  coerced?: boolean;
}

export interface GroundingSegment {
  startIndex: number;
  endIndex: number;
  text?: string;
  confidence?: number;
}

/** Result of resolving a fact's `doc_id` to an actual source document.
 *  PDFs resolve to a fetchable `path` (local file path in Electron, API URL in web);
 *  markdown resolves to inline `content`. */
export interface SourceDocumentResolution {
  available: boolean;
  type: 'pdf' | 'markdown' | null;
  content?: string;
  path?: string;
}

export interface GroundingCitation {
  uri: string;
  title: string;
  segments: GroundingSegment[];
}

export interface SupportCaseCreatePayload {
  subject: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  systemInfo: { appVersion: string; browser: string; os: string; deploymentMode: 'web' | 'electron' };
}

export interface SupportCaseSummary {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
  responseCount: number;
}

export interface SupportCaseDetail extends SupportCaseSummary {
  description: string;
  resolvedAt?: string;
  userDisplayName?: string;
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number; uploadedAt: string }[];
  responses: { id: string; authorId: string; body: string; createdAt: string }[];
  systemInfo: SupportCaseCreatePayload['systemInfo'];
}

import type { Organization as _Organization, OrganizationEdge as _OrganizationEdge, OrganizationEdgeType as _OrganizationEdgeType, Pov as _Pov, PovAlignmentTier as _PovAlignmentTier, PovStance as _PovStance, TopicEngagement as _TopicEngagement, PolicyEngagement as _PolicyEngagement } from '@lib/organizations/types';
export type Organization = _Organization;
export type OrganizationEdge = _OrganizationEdge;
export type OrganizationEdgeType = _OrganizationEdgeType;
export type Pov = _Pov;
export type PovAlignmentTier = _PovAlignmentTier;
export type PovStance = _PovStance;
export type TopicEngagement = _TopicEngagement;
export type PolicyEngagement = _PolicyEngagement;
export type OrgPovStance = _PovStance;
export type OrgTopicEngagement = _TopicEngagement;
export type OrgPolicyEngagement = _PolicyEngagement;

import type { DebateTestedTier as _DebateTestedTier, DebateTestedRecord as _DebateTestedRecord, DebateTestedEntry as _DebateTestedEntry } from '@lib/debate/taxonomyTypes';
export type DebateTestedTier = _DebateTestedTier;
export type DebateTestedRecord = _DebateTestedRecord;
export type DebateTestedEntry = _DebateTestedEntry;

import type { DebateDelta as _DebateDelta } from '@lib/debate/types';
export type DebateDelta = _DebateDelta;

// t/3258 (T3): the relevance-selection result + AN-claim input the fetchRelevantNodes bridge method
// carries. Both transports call the SAME shared lib (selectRelevantTaxonomy) so the result is
// parity-identical by construction — this is the exact contract the server route already types against.
import type { ANClaimInput as _ANClaimInput, RelevantTaxonomyResult as _RelevantTaxonomyResult } from '@lib/debate/relevanceSelection';
export type ANClaimInput = _ANClaimInput;
import type { TagSelection as _TagSelection } from '@lib/debate/types/session';
export type TagSelection = _TagSelection;
export type RelevantTaxonomyResult = _RelevantTaxonomyResult;

/**
 * Payload for `fetchRelevantNodes` (t/3258 T3). Mirrors `SelectRelevantTaxonomyInput['session']` +
 * `params` — ONLY the per-session state the server/main cannot reconstruct crosses the wire; the
 * static corpus (nodeEmbeddings), taxonomy nodes, policyRegistry, lineage map and doctrinal
 * boundaries are derived on the server/main side. Field-for-field identical to the server route's
 * `RelevantNodesBody` (routes/relevantNodes.ts) so the two callers stay in lockstep.
 */
export interface FetchRelevantNodesPayload {
  /** POV file key: accelerationist | safetyist | skeptic. */
  pov: string;
  topic: string;
  recentTranscript: string;
  /** Default 0.45 (applied by the lib fn when omitted). */
  threshold?: number;
  session: {
    /** `argument_network.nodes[]` with embeddings — the PRIMARY scoring signal; `text` for provenance. */
    anClaimEmbeddings: ANClaimInput[];
    lineageFrame?: { cluster_id: string; label?: string }[];
    /** `debate.source_type`; lineage frame is only "expected" for `'topic'` debates. */
    sourceType?: string;
    excludeGreatestHits?: boolean;
    /** Fetched caller-side (renderer: bridge `getGreatestHits`) and passed as an array. */
    greatestHitsList?: string[];
  };
  /** POV tags (t/3957) — derived caller-side from `session.seat_tags[speaker]`; the selection
   *  pipeline never reads `seat_tags` directly. Absent = today's untagged behavior, byte-identical. */
  tagSelection?: TagSelection;
}

// t/3316 (t/3297 client half): per-claim taxonomy attribution moved server/main-side — the debate
// client stops assembling the corpus for attribution (the last synthetic-corpus fetch). Both
// transports call the SAME pure fn (computeClaimTaxonomyAttribution) — web server-side, electron
// main-side — so the result is parity-identical by construction.
import type { ClaimAttributionResult as _ClaimAttributionResult } from '@lib/debate/argumentNetwork/attribution';
import type { ClaimTaxonomyAttribution as _ClaimTaxonomyAttribution } from '@lib/debate/types';

/** Payload for `fetchClaimAttribution` (t/3316). The client sends the newly-extracted AN claims (id +
 *  embeddings); the server/main derives the same-POV candidate corpus itself. Field-for-field identical
 *  to the attribution route's body (routes/attribution.ts). */
export interface FetchClaimAttributionPayload {
  /** Speaker POV file key: accelerationist | safetyist | skeptic. */
  pov: string;
  claims: { id: string; embedding?: number[]; attribution_embedding?: number[] }[];
  topN?: number;
}

/** Response: per-claim attribution (applied verbatim to each AN node's `claim_taxonomy_attribution`) +
 *  the diagnostics summary — the 4 counts AND `decisions[]` (drives ExtractionTimelinePanel, t/3316#2). */
export interface ClaimAttributionResponse {
  attributions: Record<string, _ClaimTaxonomyAttribution>;
  summary: _ClaimAttributionResult;
}

import type { OpEdSet, OpEdSetSummary, PovKey } from '../../../../lib/oped/types';
import type { BriefPreset, ExportJobState, ExportErrorCode, BriefArtifactName } from '../../../../lib/brief/types';
import type { TagSelection as OpEdTagSelection } from '@lib/schema/povTags';

/** Op-Ed generation params (PR#2) — maps to New-OpEd cmdlet params; topic + voices
 *  travel separately in the payload (one New-OpEd call per selected voice). */
export interface CreateOpEdParams {
  url?: string;
  outlet?: string;
  wordCount?: number;
  newsHook?: string;
  thesis?: string;
  authorBio?: string;
  model?: string;
  temperature?: number;
  maxGroundingNodes?: number;
  maxSituations?: number;
  voiceOnly?: boolean;
  /** POV tag for ONE member (t/3960, t/3992). Validated by parseOpEdRequest on both create paths. */
  tagSelection?: OpEdTagSelection;
}
export interface CreateOpEdPayload { topic: string; url?: string; params: CreateOpEdParams; voices: PovKey[] }
/** One 3-stage progress tick from the Electron generation IPC (t/2575 `oped-progress`). */
export interface OpEdProgressEvent { set_id: string; voice: string; stage: string; error?: string }

// Inquiry (t/3582, T-inquiry) — client shapes of the T-inquiry REST API (server: routes/inquiry.ts,
// t/3581). Field-for-field identical to the route contract (t/3582#1) so the two stay in lockstep.
import type { InquiryResult as _InquiryResult, InquiryJobStatus as _InquiryJobStatus } from '../../../../lib/inquiry';
export type InquiryResult = _InquiryResult;
// t/3609: hoisted to lib/inquiry (single source of truth across server/main/renderer) — re-exported
// here so existing `from '../bridge/types'` imports keep working unchanged. isInquiryTerminal
// (a byte-identical duplicate of lib/inquiry's isTerminalStatus, confirmed by diff at e/196#9) is
// dropped in favor of the canonical export; it had zero call sites.
export type InquiryJobStatus = _InquiryJobStatus;
export { isTerminalStatus } from '../../../../lib/inquiry';

export interface StartInquiryRequest {
  question: string;
  fidelity: 'quick' | 'standard' | 'deep';
  situationId?: string;
  models?: { debaters?: string; evaluator?: string };
  /** Optional POV tag for one camp (t/3965, picked in the Ask panel since t/4246). The server and the
   *  desktop IPC both validate it with InquiryRequestSchema, which rejects an unregistered tag. */
  tagSelection?: import('@lib/schema/povTags').TagSelection;
}

/** `done_truncated` is a DISTINCT terminal state (budget/ceiling truncation, fails closed by
 *  design) — callers must treat it as terminal via `isTerminalStatus`, never a bare `=== 'done'`
 *  (t/3582#1). */
export interface InquiryStatusResponse {
  jobId: string;
  status: InquiryJobStatus;
  progressPct: number;
  terminationReason: string | null;
  resultId: string | null;
  error: string | null;
  /** Present on `done` / `done_truncated` (including the cross-replica persisted-result fallback). */
  result?: InquiryResult;
}

/** Cheap listing row for the "My Questions" history (t/3620). Field-for-field identical to the
 *  server's `InquiryResultSummary` (storage/inquiryResultStore.ts) so the two stay in lockstep. */
export interface InquiryResultSummary {
  jobId: string;
  question: string;
  debateId: string | null;
  truncated: boolean;
  terminationReason?: string;
  createdAt: string;
}

// Brief Export (t/2805, T7) — client shapes of the T6 REST API (server: routes/briefExports.ts).
// Consumes T6's frozen job-state names, artifact names, and error taxonomy verbatim.
export interface BriefExportRequest {
  preset: BriefPreset;
  /** Resolved model id; omit to let the server use its default. */
  model?: string;
  /** Provenance hint for the server's §6 resolution — 'global' = "Use current model". */
  modelSource?: 'global' | 'explicit';
  /** Optional maker-checker model (independently resolved server-side). */
  checkerModel?: string;
  /** When false, suppresses the framing_meta slide (classroom preset only). Default true server-side. */
  framingMeta?: boolean;
  options?: { skipNarration?: boolean };
  /** Server-stored template id (web path — t/2853). Server resolves bytes before pipeline runs. */
  templateId?: string;
}

/** A user-uploaded .potx template stored server-side (t/2853). */
export interface BriefTemplateRecord {
  templateId: string;
  name: string;
  size: number;
  createdAt: string;
}
export interface BriefExportJobView {
  status: ExportJobState;
  progressPct: number;
  warnings: string[];
  error: string | null;
  errorCode: ExportErrorCode | null;
  exportId: string | null;
}
export interface BriefExportRecord {
  exportId: string;
  debateId: string;
  title: string;
  preset: BriefPreset;
  status: 'done' | 'failed';
  errorCode?: ExportErrorCode;
  /** Human-readable failure reason (verify message / thrown error) — shown by the export
   *  dialog's list fallback so a failed export explains WHY, not just a code (t/2888). */
  reason?: string;
  /** Populated on the server/web path only (src/server/briefExportJobs.ts,
   *  briefExportStore.ts) — absent by design on desktop, where the main-process handler
   *  never sets them (t/3532, TL ruling t/3532#3: this was a web-only concept incorrectly
   *  typed as required on a type shared with the desktop bridge). */
  narratorModel?: string;
  narratorModelSource?: string;
  checkerModel?: string | null;
  formats: string[];
  artifacts: BriefArtifactName[];
  traceCoveragePct: number;
  warnings: string[];
  createdAt: string;
}

import type { EdgesFile as _EdgesFile } from '@lib/debate/taxonomyTypes';
export type EdgesFile = _EdgesFile;

// Canonical ref-kind contract (t/1767 §5). Re-exported so renderer consumers
// (resolveRef / DetailPane, t/1775) have a single import site alongside `api`,
// without forking the shared union. Never redeclared here — pure re-export.
import type { EntityRef as _EntityRef, EntityDetail as _EntityDetail, EntitySummary as _EntitySummary, EntityListQuery as _EntityListQuery } from '@lib/entities/types';
export type EntityRef = _EntityRef;
export type EntityDetail = _EntityDetail;
export type EntitySummary = _EntitySummary;
export type EntityListQuery = _EntityListQuery;

// Mention index contract (t/1890 §5). Re-exported for the same single-import-site reason
// as the entity types above; pure re-export, never redeclared here.
import type { ContainerMentions as _ContainerMentions } from '@lib/entities/mentionTypes';
export type ContainerMentions = _ContainerMentions;

export interface OrgFilters { type?: string; pov?: string }

/**
 * Per-call options for {@link AppAPI.generateText} (t/2508, HLD t/2506#1).
 * `signal` lets a caller abort an in-flight AI request — in web builds it tears
 * down the fetch; in Electron it fires the `cancelGenerate` IPC (feature-detected).
 * `requestId` correlates the request across bridge → transport → provider so the
 * cancel channel can target the exact in-flight request. Optional throughout, so
 * no-signal callers behave exactly as before.
 */
export interface GenerateTextOptions {
  signal?: AbortSignal;
  requestId?: string;
  /** Caller-supplied stage/activity label (e.g. "brief", "Moderator is voicing each camp's
   * story") surfaced on the bridge's ai.request/ai.response/ai.error flight-recorder events
   * so a dump can attribute a slow/failed call to its call site without guessing from
   * unrelated debate.lifecycle events (t/3519). Purely diagnostic — never sent to the provider. */
  purpose?: string;
  /** Caps provider output length for this call (e.g. Fable 5's opening brief, which
   * otherwise hits the provider default ceiling and truncates mid-JSON, t/3524).
   * Optional — omitted calls use the backend/model default. */
  maxTokens?: number;
}

/**
 * Single-object payload for the `generate-text` IPC call (t/3528). Replaces a positional
 * parameter chain that grew to 6 args across `electron.d.ts` → `preload.cts` → the
 * `generate-text` handler → `embeddings.generateText`, each restating the order by hand.
 * `signal` and `purpose` (renderer-only concerns — see {@link GenerateTextOptions}) don't
 * cross the IPC boundary and are deliberately excluded.
 */
export interface GenerateTextIpcPayload {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  requestId?: string;
  maxTokens?: number;
}

// Re-exported from the shared schema (t/3534) — single source of truth for both
// read boundaries (ElectronMain get-preferences, ServerAPI GET /api/preferences),
// so Electron and web can never silently diverge on the same preferences file.
// Same names, same shape — zero renderer call-site churn.
import type { ViewMode as _ViewMode, UserPreferences as _UserPreferences } from '@lib/userPreferencesSchema';
export type ViewMode = _ViewMode;
export type UserPreferences = _UserPreferences;

/** t/3852: shared contract for the durable node-deletion audit log. Both the Electron
 *  main-process writer and the server writer append this shape to node-delete-log.jsonl
 *  under the resolved data root. */
export interface NodeDeleteLogEntry {
  nodeId: string;
  pov: string;
  label: string;
  user: string;
  /** Exhaustive counts (not sampled) of what dangles — see utils/danglingReferences.ts. */
  danglingEdges: number;
  danglingSituationRefs: number;
  danglingChildren: number;
}

export interface AppAPI {
  // --- User preferences ---
  getPreferences: () => Promise<UserPreferences | null>;
  setPreferences: (prefs: UserPreferences) => Promise<void>;

  // --- Taxonomy directories ---
  getTaxonomyDirs: () => Promise<string[]>;
  getActiveTaxonomyDir: () => Promise<string>;
  setTaxonomyDir: (dirName: string) => Promise<void>;

  // --- Taxonomy CRUD ---
  /** A plain read. It never moves the save's version cell, so use it for re-reads and viewers (t/4187). */
  loadTaxonomyFile: (pov: string) => Promise<unknown>;
  /** The editor's load (initial load, refresh, POV switch): on web it also records the file's version, which the
   *  next save sends as If-Match. Same result as loadTaxonomyFile on desktop (t/4187). */
  loadTaxonomyFileForEdit: (pov: string) => Promise<unknown>;
  /** loadTaxonomyFileForEdit for several files, all or nothing (t/4439): every file is read first, and the version
   *  cells move only if every read succeeded, so a partial failure never leaves a cell ahead of the store's content.
   *  Results are in `povs` order. Same as plain reads on desktop. */
  loadTaxonomyFilesForEdit: (povs: readonly string[]) => Promise<unknown[]>;
  /** Web: sends If-Match from the version cell; rejects with `code` 'WRITE_CONFLICT' (409) or
   *  'BASE_VERSION_REQUIRED' (428) for the UI to offer a reload. Saves to one POV are serialized (t/4187). */
  saveTaxonomyFile: (pov: string, data: unknown) => Promise<void>;
  loadPolicyRegistry: () => Promise<unknown>;
  /** t/4034: recount member_count / source_povs in policy_actions.json for these policy ids, from the POV
   *  files on disk (lib/policy/registryRecount.ts). Returns written / unchanged / refused. */
  recountPolicyMembers: (ids: string[]) => Promise<RecountPolicyMembersResult>;
  loadLineageCategories: () => Promise<unknown>;

  /** t/3852: durable audit record for a node deletion — appended to node-delete-log.jsonl
   *  under the data root (Electron: main-process writer via IPC; web: server endpoint).
   *  Fail-safe like the AI call log: an IO/network failure must never block the delete it's
   *  recording, so callers should not let a rejection here interrupt the delete flow. */
  logNodeDeletion: (entry: NodeDeleteLogEntry) => Promise<void>;
  loadLineageInfo: () => Promise<Record<string, unknown>>;
  loadEdges: () => Promise<unknown>;
  getEdgeDetail: (index: number) => Promise<unknown>;
  updateEdgeStatus: (index: number, status: string) => Promise<unknown>;
  swapEdgeDirection: (index: number) => Promise<unknown>;
  bulkUpdateEdges: (indices: number[], status: string) => Promise<unknown>;
  /** Persist the full edges file via a whole-file atomic write (writeEdgesFile
   *  temp→rename). The only path that APPENDS new edges — update/swap/bulk above
   *  mutate existing edges by index. New-edge persistence path (t/1816). */
  saveEdges: (data: EdgesFile) => Promise<void>;
  buildNodeSourceIndex: () => Promise<unknown>;
  buildPolicySourceIndex: () => Promise<unknown>;
  /** t/4334/t/4335: per-node source index — replaces buildNodeSourceIndex (whole-corpus)
   *  for the Sources tab's actual use case (one node at a time). */
  getNodeSources: (nodeId: string) => Promise<{ sources: _SourceReference[]; cards: Record<string, _SourceCardMeta>; indexVersion: number }>;

  // --- Conflict CRUD ---
  loadConflictFiles: () => Promise<unknown[]>;
  loadConflictClusters: () => Promise<unknown | null>;
  loadAggregatedCruxes: () => Promise<unknown | null>;
  addCruxEvidence: (cruxId: string, entry: { url: string; note?: string; added_by: string }) => Promise<void>;
  removeCruxEvidence: (cruxId: string, entryIndex: number) => Promise<void>;
  saveConflictFile: (claimId: string, data: unknown) => Promise<void>;
  createConflictFile: (claimId: string, data: unknown) => Promise<void>;
  deleteConflictFile: (claimId: string) => Promise<void>;

  // --- Summaries & Sources ---
  discoverSources: () => Promise<unknown[]>;
  loadSummary: (docId: string) => Promise<unknown | null>;
  loadSnapshot: (sourceId: string) => Promise<{ content: string } | null>;
  resolveSourceDocument: (docId: string) => Promise<SourceDocumentResolution>;

  // --- Data management ---
  isDataAvailable: () => Promise<boolean>;
  getDataRoot: () => Promise<string>;
  getCopyStatus: () => Promise<{ state: string; dir?: string; copied?: number; total?: number }>;
  cloneDataRepo: (targetPath: string) => Promise<{ success: boolean; message: string }>;
  setDataRoot: (newRoot: string) => Promise<void>;
  pickDirectory: (defaultPath?: string) => Promise<{ cancelled: boolean; path?: string }>;
  checkDataUpdates: () => Promise<unknown>;
  pullDataUpdates: () => Promise<unknown>;
  getChangedFiles: () => Promise<{ path: string; status: string }[]>;
  /** t/4052: taxonomy/Origin/pov-tag-proposals.json, or null when absent. Read-only everywhere. */
  loadPovTagProposals: () => Promise<PovTagProposalsFile | null>;
  /** t/4052: record one review decision in the side file (never pov_tags). Desktop only: hosted web answers 405.
   *  A refusal (`conflict`: someone reviewed it first; `invalid`: final fails the registry) comes back as a value. */
  reviewPovTagProposal: (nodeId: string, decision: ProposalDecision, expectedStatus: ProposalStatus) => Promise<ApplyProposalDecisionResult>;
  getFileDiff: (filePath: string) => Promise<string>;

  // --- AI models & keys ---
  loadAIModels: () => Promise<unknown>;
  /** t/4031: `opts` asks for a dry run or accepts a proposal; omit it for a plain refresh. */
  refreshAIModels: (opts?: RefreshModelsRequest) => Promise<RefreshModelsResponse>;
  validateApiKey: (key: string, backend: string) => Promise<{ valid: boolean; error?: string }>;
  verifyStoredKeys: (backend: string) => Promise<{ results: { index: number; masked: string; valid: boolean; error?: string }[] }>;
  setApiKey: (key: string, backend?: string) => Promise<void>;
  addApiKey: (key: string, backend: string) => Promise<{ count: number }>;
  removeApiKey: (index: number, backend: string) => Promise<void>;
  getApiKeys: (backend: string) => Promise<{ index: number; masked: string }[]>;
  deleteApiKey: (backend?: string) => Promise<void>;
  deleteAllApiKeys: () => Promise<void>;
  hasApiKey: (backend?: string) => Promise<boolean>;
  /**
   * Which AI backends are actually usable (key present + reachable). Backed by the
   * server's GET /api/backends/available in authed web mode; derived from local key
   * presence in anonymous (BYOK) and Electron modes. Used to gate multi-provider
   * debates so speakers are only assigned to usable backends.
   */
  getAvailableBackends: () => Promise<{ id: string; available: boolean; models?: string[]; reason?: 'tier_restricted' | 'no_key' }[]>;
  getApiKeySummary: () => Promise<{ backend: string; hasKey: boolean; maskedKey: string | null }[]>;
  exportKeysForSharing: (passphrase: string) => Promise<{ dataUrl: string; payloadText: string }>;
  importKeysFromSharing: (payload: { v: number; salt: string; iv: string; data: string; tag: string }, passphrase: string) => Promise<string[]>;

  // --- AI generation ---
  /** `stopReason` (t/3525) is the provider's normalized finish reason — 'max_tokens' means the
   *  text is truncated and callers must not attempt to parse it as complete JSON. Undefined when
   *  the backend hasn't reported one (web builds, until ServerAPI threads it through the REST
   *  response) — never fabricated. */
  /** `diagnostics` (t/3568 item 2) rides the resolved value on the SUCCESS path only — providers
   *  throw before returning a ProviderResult on a non-2xx/timeout, so there is nothing to attach
   *  on a rejected generateText call yet (see instrumentBridge.ts's extractResultMeta). */
  /** `servedModel` (t/4048, e/268#6 condition 3) is the registry id that actually answered, set
   *  only on success and never echoed from the request — absent means untracked (older backend
   *  or an error path), never filled in from the requested model. Desktop always equals the
   *  requested/defaulted model (no fallback chain there, e/275); web is unset until ServerAPI's
   *  own `servedModel` lands (its chain in `aiBackends.ts` is where failover is real).
   *
   *  WHAT IT DOES NOT CLAIM: "answered" means which link of OUR model routing answered (failover
   *  tracking). It does NOT verify that the PROVIDER served that model. Provider-side substitution
   *  (sent X, provider reports Y) is detected separately by the `ai.model_identity` flight-recorder
   *  event (t/3677, t/3731), not here. `ProviderResult.providerReportedModel` is deliberately NOT
   *  the source: it is a raw provider string (a different namespace from registry ids), and it is
   *  forensics-only. Reading it here would lapse its no-consumer exemption. So a run marked
   *  'tracked' on this field is failover-tracked, NOT identity-verified (TL review, #3061). */
  generateText: (prompt: string, model?: string, timeoutMs?: number, temperature?: number, opts?: GenerateTextOptions) => Promise<{ text: string; stopReason?: StopReason; tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }; diagnostics?: ProviderCallDiagnostics; servedModel?: string }>;
  generateTextWithSearch: (prompt: string, model?: string) => Promise<{
    text: string;
    searchQueries?: string[];
    citations?: GroundingCitation[];
  }>;
  startChatStream: (systemInstruction: string, messages: { role: 'user' | 'model'; content: string }[], model?: string, temperature?: number, urlContext?: boolean, context?: { chatSessionId?: string; linkedDebateId?: string }) => Promise<string>;
  onChatStreamChunk: (callback: (chunk: string) => void) => () => void;
  onChatStreamDone: (callback: (fullText: string) => void) => () => void;
  onChatStreamError: (callback: (error: string) => void) => () => void;
  /** url_context grounding metadata (t/2462). Both bridges implement it; a no-op unsubscribe
   *  when the backend never emits metadata, so consumers need no optional-chaining. */
  onChatStreamUrlMetadata: (callback: (metadata: unknown) => void) => () => void;
  setDebateTemperature: (temp: number | null) => Promise<void>;

  // --- Proxy tier & usage ---
  getProxyTier?: () => Promise<{ level: string; limits: { requestsPerMinute: number; tokensPerDay: number }; allowedBackends: string[]; principalName: string | null; serverProvidedKey?: boolean; pinnedModel?: string }>;
  getProxyUsage?: () => Promise<{ tier: string; limits: { requestsPerMinute: number; tokensPerDay: number }; usage: { requestsInWindow: number; tokensToday: number } }>;

  // --- Embeddings & NLI ---
  computeEmbeddings: (texts: string[], ids?: string[]) => Promise<{ vectors: number[][] }>;
  // Resolves { staleNodeIds } — requested nodes whose embedding couldn't be refreshed (empty =
  // full success). Consumers surface a non-blocking "embeddings stale" warning on non-empty
  // (t/2060). Electron computes it; the web transport returns [] (server backend doesn't DML-OOM).
  updateNodeEmbeddings: (nodes: { id: string; text: string; pov: string; exclusionText?: string }[]) => Promise<{ staleNodeIds: string[] }>;
  computeQueryEmbedding: (text: string) => Promise<{ vector: number[] }>;
  // t/3258 (T3): server/main-side taxonomy relevance selection — the debate client stops fetching
  // the corpus to score locally. Both transports run the SAME shared lib (selectRelevantTaxonomy),
  // so the result is parity-identical by construction. Web → REST POST /api/taxonomy/relevant-nodes;
  // Electron → IPC → a main handler mirroring routes/relevantNodes.ts (packaged Electron has no
  // embedded server). Only per-session state crosses the wire; the corpus is assembled server/main-side.
  fetchRelevantNodes: (payload: FetchRelevantNodesPayload) => Promise<RelevantTaxonomyResult>;
  // t/3316 (t/3297 client half): server/main-side per-claim taxonomy attribution — the debate client
  // stops assembling the corpus for attribution. Both transports run the SAME pure fn
  // (computeClaimTaxonomyAttribution). Web → REST POST /api/argument-network/attribution; Electron →
  // IPC → a main handler (window.electronAPI.computeAttribution, t/3322) computing from the LOCAL corpus.
  fetchClaimAttribution: (payload: FetchClaimAttributionPayload) => Promise<ClaimAttributionResponse>;
  nliClassify: (pairs: Array<{ text_a: string; text_b: string }>) => Promise<{
    results: Array<{
      nli_label: string;
      nli_entailment: number;
      nli_neutral: number;
      nli_contradiction: number;
      margin: number;
    }>;
  }>;

  // --- Source evidence ---
  loadSourceEvidenceIndex: () => Promise<Record<string, unknown> | null>;
  loadDocTitles: () => Promise<Record<string, string> | null>;
  /** Greatest-hits exclusion node IDs from calibration/greatest-hits.json (t/1998). Null when the file is absent. */
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

  // --- Debate sessions ---
  getDebateQuotaStatus: () => Promise<{ allowed: boolean; resource: string; current: number; limit: number }>;
  listDebateSessions: () => Promise<unknown[]>;
  listDebateSessionsMeta: () => Promise<unknown[]>;
  loadDebateSession: (id: string) => Promise<unknown>;
  saveDebateSession: (session: unknown, caller: string) => Promise<void>;
  /** Incremental save (web-only optimization; Electron delegates to a full save).
   *  Sends only the surfaces that changed since the last synced version. The server
   *  accepts the delta only if `delta.baseVersion` matches the stored `_saveVersion`
   *  and returns the new authoritative version. On a version mismatch the web bridge
   *  falls back to a full `saveDebateSession` PUT (see web-bridge.ts). */
  saveDebateDelta: (delta: DebateDelta) => Promise<{ newVersion: number }>;
  deleteDebateSession: (id: string) => Promise<void>;
  exportDebateToFile: (session: unknown, format?: 'json' | 'markdown' | 'text' | 'pdf' | 'package', exportOptions?: { includeTaxonomyRefs?: boolean; includeReasoning?: boolean }) => Promise<{ cancelled: boolean; filePath?: string }>;
  loadDebateComments: (debateId: string) => Promise<unknown>;
  saveDebateComments: (debateId: string, data: unknown) => Promise<void>;

  // --- Inquiry (t/3582 — "Ask a question"; both builds) ---
  startInquiry: (request: StartInquiryRequest, idempotencyKey?: string) => Promise<{ jobId: string }>;
  getInquiry: (jobId: string) => Promise<InquiryStatusResponse>;
  /** "My Questions" history list (t/3620). Desktop may reject until the ElectronMain IPC leg
   *  lands (t/3582 precedent — see electron-bridge.ts's rejectOpEdIpc pattern). */
  listInquiries: () => Promise<InquiryResultSummary[]>;
  /** Export an inquiry answer as JSON/MD/PDF (t/3624). Desktop rejects until the ElectronMain
   *  IPC leg lands — no fake success (same precedent as listInquiries above). */
  exportInquiryToFile: (
    result: InquiryResult,
    title: string,
    format: 'json' | 'markdown' | 'pdf',
  ) => Promise<{ cancelled: boolean; filePath?: string }>;
  /** Public no-login share link (t/3626/t/3653, t/3654). Mirrors shareOpEdSet/unshareOpEdSet
   *  exactly — desktop rejects (t/3654: hide the Share control on Electron entirely, per
   *  rejectOpEdIpc precedent — same web-only posture as op-ed sharing). */
  shareInquiry: (jobId: string) => Promise<{ shareId: string; url: string }>;
  unshareInquiry: (jobId: string) => Promise<{ ok: boolean }>;
  /** t/4562: loads a full community inquiry result for the library page's Open/Export actions —
   *  mirrors loadCommunityOpEd exactly. Web-only; community browsing itself is already web-only
   *  (useCommunityStore.fetchInquiries short-circuits on Electron), so desktop rejects. */
  loadCommunityInquiry: (id: string) => Promise<InquiryResult>;

  // --- Brief Export (t/2805, T7 — client of the T6 REST API; web-only v1, Electron parity tracked) ---
  createBriefExport: (debateId: string, body: BriefExportRequest) => Promise<{ jobId: string }>;
  getBriefExportJob: (jobId: string) => Promise<BriefExportJobView>;
  listBriefExports: (debateId: string) => Promise<BriefExportRecord[]>;
  downloadBriefArtifact: (exportId: string, name: BriefArtifactName) => Promise<Blob>;
  deleteBriefExport: (exportId: string) => Promise<void>;
  /** Print brief.html to PDF. Electron: shows save dialog + uses printToPDF. Web: opens in new window for browser print. */
  printBriefToPdf: (html: string) => Promise<{ cancelled: boolean; filePath?: string }>;
  // --- Brief Templates (t/2853) — upload/list/delete stored .potx templates (web); desktop returns stubs ---
  uploadBriefTemplate: (file: File) => Promise<BriefTemplateRecord>;
  listBriefTemplates: () => Promise<BriefTemplateRecord[]>;
  deleteBriefTemplate: (templateId: string) => Promise<void>;

  // --- Op-Ed Studio (t/2576; personal library — submit/copy route via community store) ---
  listOpEdSets: () => Promise<OpEdSetSummary[]>;
  loadOpEdSet: (id: string) => Promise<OpEdSet>;
  saveOpEdSet: (set: OpEdSet) => Promise<void>;
  deleteOpEdSet: (id: string) => Promise<void>;
  // PR#2 create flow — Electron-only (New-OpEd is PowerShell); web rejects with a desktop-only error.
  createOpEdSet: (payload: CreateOpEdPayload) => Promise<{ set_id: string }>;
  cancelOpEdSet: (setId: string) => void;
  onOpEdProgress: (callback: (event: OpEdProgressEvent) => void) => () => void;
  /** t/2728: publish a durable public share link for an op-ed set. Web-only (the public
   *  URL is served by the hosted server, GET /api/public/oped/:shareId); Electron rejects. */
  shareOpEdSet: (setId: string) => Promise<{ shareId: string; url: string }>;
  /** t/2728: revoke a public share (owner-only). */
  unshareOpEdSet: (setId: string) => Promise<{ ok: boolean }>;
  /** t/3315: publish a public share link for a COMMUNITY op-ed (any submitter — community is public).
   *  Same public /share/oped view as own-op-ed share. Web-only; Electron rejects. */
  shareCommunityOpEd: (id: string) => Promise<{ shareId: string; url: string }>;

  // --- News Report ---
  generateNewsReport: (debateId: string) => Promise<{ article: string }>;

  // --- Chat sessions ---
  listChatSessions: () => Promise<unknown[]>;
  loadChatSession: (id: string) => Promise<unknown>;
  saveChatSession: (session: unknown) => Promise<void>;
  deleteChatSession: (id: string) => Promise<void>;
  exportChatToFile: (
    entries: { id: string; timestamp: string; speaker: string; content: string; taxonomy_refs: { node_id: string; label?: string; relevance: string }[] }[],
    format: 'markdown' | 'text' | 'pdf' | 'json',
    options: { title: string; mode: 'brainstorm' | 'inform' | 'decide'; pov: 'accelerationist' | 'safetyist' | 'skeptic' },
  ) => Promise<{ cancelled: boolean; filePath?: string }>;

  // --- Harvest ---
  harvestCreateConflict: (conflict: Record<string, unknown>) => Promise<{ created: boolean }>;
  harvestAddDebateRef: (nodeId: string, debateId: string) => Promise<{ updated: boolean }>;
  harvestUpdateSteelman: (nodeId: string, attackerPov: string, newText: string) => Promise<{ updated: boolean }>;
  harvestAddVerdict: (conflictId: string, verdict: Record<string, unknown>) => Promise<{ updated: boolean }>;
  harvestQueueConcept: (concept: Record<string, unknown>) => Promise<{ queued: boolean }>;
  harvestSaveManifest: (manifest: Record<string, unknown>) => Promise<{ saved: boolean }>;

  // --- Dictionary ---
  loadDictionary: () => Promise<{ standardized: unknown[]; colloquial: unknown[]; lintViolations: unknown[] }>;

  // --- Proposals ---
  listProposals: () => Promise<unknown[]>;
  saveProposal: (filename: string, data: unknown) => Promise<{ saved?: boolean; error?: string }>;

  // --- PowerShell prompts ---
  readPsPrompt: (promptName: string, dir?: string) => Promise<{ text: string | null; error?: string }>;
  listPsPrompts: () => Promise<string[]>;

  // --- Research file access ---
  readResearchFile: (relativePath: string) => Promise<unknown>;
  writeResearchFile: (relativePath: string, data: unknown) => Promise<void>;

  // --- Synthetic corpus ---
  loadSyntheticCorpus: (pov: string) => Promise<unknown | null>;
  loadSyntheticEmbeddings: () => Promise<Record<string, { pov: string; vectors: number[][] }> | null>;
  updateSyntheticEmbeddings: (nodeId: string, pov: string, vectors: number[][]) => Promise<void>;

  // --- Feedback & error reporting ---
  submitFeedback: (rating: 'up' | 'down', text?: string, category?: 'bug' | 'feature_request' | 'confusing' | 'general', context?: Record<string, unknown>) => Promise<{ ok: boolean; id?: string }>;
  reportError: (error: { name: string; message: string; stack?: string; componentStack?: string }, context?: Record<string, unknown>) => Promise<{ ok: boolean }>;

  // --- Telemetry ---
  trackEvent: (type: string, view?: string, metadata?: Record<string, unknown>) => void;

  // --- Community Library ---
  listCommunityChats: () => Promise<unknown[]>;
  listCommunityDebates: () => Promise<unknown[]>;
  submitToCommunity: (type: 'chat' | 'debate' | 'oped' | 'inquiry', itemData: unknown, note?: string) => Promise<{ submissionId: string }>;
  copyFromCommunity: (type: 'chats' | 'debates', communityId: string) => Promise<{ newId: string }>;
  loadCommunityDebateSession: (id: string) => Promise<unknown>;
  loadCommunityOpEd: (id: string) => Promise<OpEdSet>;
  loadCommunityChatSession: (id: string) => Promise<unknown>;
  // Submit to a remote community server. In Electron this is proxied through the main
  // process (net.fetch) so it is not blocked by browser CORS; baseUrl is the server origin.
  communitySubmit: (baseUrl: string, payload: { type: 'chat' | 'debate' | 'oped' | 'inquiry'; data: unknown; note?: string }) => Promise<{ submissionId: string }>;

  // --- Support cases ---
  createSupportCase: (payload: SupportCaseCreatePayload) => Promise<{ id: string }>;
  listSupportCases: () => Promise<SupportCaseSummary[]>;
  getSupportCaseDetail: (caseId: string) => Promise<SupportCaseDetail>;
  uploadCaseAttachment: (caseId: string, file: File) => Promise<{ id: string; filename: string }>;
  downloadCaseAttachment: (caseId: string, attachmentId: string) => Promise<Blob>;
  listAdminSupportCases: () => Promise<SupportCaseSummary[]>;
  respondToSupportCase: (caseId: string, body: string) => Promise<{ id: string }>;
  updateSupportCaseStatus: (caseId: string, status: string) => Promise<void>;

  // --- Organizations ---
  listOrganizations: (filters?: OrgFilters) => Promise<Organization[]>;
  getOrganization: (id: string) => Promise<Organization>;
  getOrganizationsByPov: (pov: string) => Promise<Organization[]>;
  getOrganizationsByTopic: (topicRef: string) => Promise<Organization[]>;
  getOrganizationsByPolicy: (policyId: string) => Promise<Organization[]>;
  getOrganizationEdges: (orgId: string) => Promise<OrganizationEdge[]>;

  // --- Entity / ref resolution (t/1775) ---
  /**
   * Resolve a raw entity-ref token to its {@link EntityDetail} via the server
   * (`GET /api/entity/:ref`). Used by `resolveRef` for the SERVER-ONLY kinds
   * (`org-*`, `ent-*`, `term:*`); the client-side kinds (node/situation/policy)
   * resolve from the taxonomy store without a round-trip. Follows merge tombstones
   * server-side, stamping `redirected_from` on the result.
   */
  getEntity: (ref: string) => Promise<EntityDetail>;

  /**
   * List entity summary rows for the entity browser (`GET /api/entities`, t/1883).
   * v1 accepts search/sort/type/status query params for forward-compat but the
   * server returns the full list (client-side filtered — TL t/1766#7 Q6).
   */
  listEntities: (query?: EntityListQuery) => Promise<EntitySummary[]>;

  /**
   * Fetch stored entity-name mentions for one container (`GET /api/container-mentions/:id`,
   * t/1901). Container ids are prefix-namespaced (`sei:<node_id>` / `node:<node_id>`), so the
   * id is URL-encoded. Resolves `null` when the container has no mentions index yet — the
   * file is a derived artifact, so absence means "no links", not an error. Consumed by the
   * Phase 2-E renderer (t/1898). Backends: web route t/1902, electron IPC t/1903.
   */
  getContainerMentions: (containerId: string) => Promise<ContainerMentions | null>;

  // --- Calibration ---
  getCalibrationHistory: () => Promise<{ current: unknown; history: unknown[] }>;
  getCalibrationLog: () => Promise<{ entries: unknown[]; validationReport: unknown }>;

  // --- Diagnostics ---
  openDiagnosticsWindow: () => Promise<void>;
  openPovProgressionWindow: () => Promise<void>;
  closeDiagnosticsWindow: () => Promise<void>;
  sendDiagnosticsState: (state: unknown) => void;
  /**
   * t/4642: brings an already-open diagnostics surface to the front. 'inline' means diagnostics
   * is shown in the narrow-window drawer (no separate window to focus, no notice needed);
   * 'not-open' means no window reference / BrowserWindow exists to focus.
   */
  focusDiagnosticsWindow: () => Promise<'focused' | 'not-open' | 'inline'>;

  // --- Data file diff popout ---
  openDiffWindow: (filePath: string) => Promise<void>;

  // --- Prompt Diff popout ---
  openPromptDiffWindow: (debateId: string, entryId: string) => Promise<void>;

  // --- Debate popout ---
  // `source` (e.g. 'community') is propagated to the popout hash so it loads the
  // correct endpoint — community debates must route to the community load path (t/2399).
  openDebateWindow: (debateId: string, source?: string) => Promise<{ atCap: true } | void>;
  closeDebateWindow: (debateId: string) => Promise<void>;
  getCliFileArg: () => Promise<{ type: string; path: string; data?: unknown; error?: string } | null>;

  // --- Terminal ---
  terminalSpawn: () => Promise<void>;
  terminalWrite: (data: string) => Promise<void>;
  terminalResize: (cols: number, rows: number) => Promise<void>;
  terminalKill: () => Promise<void>;

  // --- File operations ---
  fetchUrlContent: (url: string) => Promise<{ content: string; error?: string }>;
  pickDocumentFile: () => Promise<{ cancelled: boolean; filePath?: string; content?: string }>;
  clipboardWriteText: (text: string) => Promise<void>;

  // --- Window control ---
  growWindow: (deltaWidth: number) => Promise<void>;
  shrinkWindow: (deltaWidth: number) => Promise<void>;
  isMaximized: () => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;

  // --- Sync ---
  /** Flush overlay writes to GitHub via Trees API batch commit. No-op in filesystem/Electron mode. */
  syncCommit: (message?: string) => Promise<{ ok: boolean; commitSha: string | null; filesCommitted: number }>;

  // --- Flight recorder ---
  dumpFlightRecorder: (ndjson: string, dumpId?: string) => Promise<{ filePath: string; filename: string }>;
  openFile: (filePath: string) => Promise<void>;
  openFlightRecorderViewer: (dumpPath: string) => Promise<void>;

  // --- Event listeners (return unsubscribe function) ---
  onDiagnosticsStateUpdate: (callback: (state: unknown) => void) => () => void;
  onDiagnosticsPopoutClosed: (callback: () => void) => () => void;
  openChatWindow: (chatId: string, source?: 'my' | 'community') => Promise<{ atCap: true } | void>;
  onChatPopoutClosed: (callback: (chatId: string) => void) => () => void;
  onChatWindowLoad: (callback: (chatId: string) => void) => () => void;
  requestReExtractClaims: (entryId: string) => void;
  onReExtractClaims: (callback: (entryId: string) => void) => () => void;
  onDebateWindowLoad: (callback: (debateId: string) => void) => () => void;
  onDebatePopoutClosed: (callback: (debateId: string) => void) => () => void;
  onGenerateTextProgress: (callback: (progress: {
    attempt: number;
    maxRetries: number;
    backoffSeconds: number;
    limitType: string;
    limitMessage: string;
  }) => void) => () => void;
  onReloadTaxonomy: (callback: () => void) => () => void;
  onFocusNode: (callback: (nodeId: string) => void) => () => void;
  onTaxonomyUpdated: (callback: (evt: { user: string; nodeCount: number; povs: string[] }) => void) => () => void;
  focusNodeInMainWindow: (nodeId: string) => void;
  onTerminalData: (callback: (data: string) => void) => () => void;
  onTerminalExit: (callback: () => void) => () => void;

  // --- Brief-timeout events (t/2218) ---
  // Electron: IPC from ElectronMain preload. Web: browser-local bus in web-bridge.ts.
  onBriefTimeout: (callback: (e: { debateId: string; speaker: string; attempt: number; maxAttempts: number; currentModel: string }) => void) => () => void;
  onBriefRetriesExhausted: (callback: (e: { debateId: string; speaker: string; totalAttempts: number; currentModel: string }) => void) => () => void;

  // --- Screenshot capture ---
  captureScreenshot: (opts?: { width?: number; height?: number; defaultName?: string }) => Promise<{ cancelled: boolean; filePath?: string }>;

  // --- Feature flags ---
  getFlags: () => Promise<Record<string, boolean>>;

  // --- Admin Error Dashboard ---
  getErrorSummary: () => Promise<{
    total: number; today: number; last7d: number; last30d: number;
    topErrors: Array<{ key: string; count: number; lastSeen: string; affectedUsers: number }>;
    byDay: Array<{ date: string; count: number }>;
  }>;
  listErrors: (opts?: { since?: string; until?: string; userId?: string; errorName?: string; limit?: number; offset?: number }) => Promise<{
    items: Array<{ id: string; name: string; message: string; timestamp: string; userId?: string; context?: Record<string, unknown> }>;
    total: number; hasMore: boolean;
  }>;
  getErrorDetail: (id: string) => Promise<{
    entry: { id: string; name: string; message: string; timestamp: string; userId?: string; context?: Record<string, unknown>; stack?: string };
    relatedDumps: Array<{ dumpId: string; kind: string; timestamp: string }>;
  } | null>;

  // --- UsageID registry ---
  getUsageRegistry: () => Promise<Record<string, { description: string; model: string; temperature?: number; maxTokens?: number; timeoutMs?: number; tags?: string[]; _extends?: string }>>;

  // --- Deep-link URL ---
  getWebAppUrl: () => Promise<string | null>;

  // --- Admin Review (Azure Blob in Electron, HTTP in web) ---
  adminReviewConfigured: () => Promise<boolean>;
  adminReviewQueue: () => Promise<{ items: { id: string; domain: string; submitter: string; submitterDisplay: string; submittedAt: string; summary: string; itemCount: number; status: string }[] }>;
  adminReviewStats: () => Promise<{ total: number; byDomain: Record<string, number> }>;
  adminReviewDetail: (groupId: string) => Promise<unknown>;
  adminReviewAction: (action: { domain: string; groupId: string; action: string; itemIds: string[]; reason?: string; edits?: Record<string, unknown> }) => Promise<void>;
  adminRemoveCommunityItem: (type: 'chats' | 'debates' | 'opeds' | 'inquiries', id: string, reason?: string) => Promise<void>;
}
