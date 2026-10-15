// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { TaxonomyStore, ToolbarPanel } from '../types';
import type {
  PovTaxonomyFile,
  CrossCuttingFile as SituationsFile,
  ConflictFile,
  PovNode,
  CrossCuttingNode as SituationNode,
  Edge,
  EdgesFile,
  TabId,
  Pov,
  Category,
  ConflictInstance,
  ConflictNote,
  TextHistoryEntry,
  TextEditSource,
  Interpretation,
} from '../../../types/taxonomy';
import { interpretationText } from '../../../types/taxonomy';
import { buildPovTagBaseline, povTagMembership } from '../../../utils/povTagGate';
import { buildSituationBaseline, checkSituationBdi, type SituationBdiRefusal } from '../../../utils/situationBdiGate';
import { coerceSituationDivergence } from '../../../bridge/coerceSituationDivergence';
import { baselineAfterSave, savedPolicyNodes, allPolicyNodes } from './saveBaselines';
import { buildPolicyIdBaseline, affectedPolicyIds, runPolicyRecount, mergePolicyCounts, type PolicyRecountNotice } from '../../../utils/policyRecount';
import {
  povTaxonomyFileSchema,
  crossCuttingFileSchema as situationsFileSchema,
  conflictFileSchema,
  extractPovErrors,
  extractConflictErrors,
  ValidationErrors,
  stripInvalidLogicalForm,
} from '../../../utils/validation';
import {
  generatePovNodeId,
  generateCrossCuttingId as generateSituationId,
  generateConflictId,
  todayISO,
} from '../../../utils/idGenerator';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { normalizeNodeProperties } from '@lib/debate';
import { nodeTypeFromId, nodePovFromId } from '@lib/debate/nodeIdUtils';
import { POV_KEYS } from '@lib/debate/types';
import { validateTaxonomy } from '@lib/debate/validators';
import type { ValidationResult, ValidationIssue } from '@lib/debate/validators';
import { validatePovNodeId } from '@lib/debate/validateNodeId';
import type { AggregatedCrux as LibAggregatedCrux, CruxSource } from '@lib/debate/types/synthesis';
import { api } from '@bridge';
import { saveFailureRecord, saveErrorText } from './saveFailure';
import { loadLineageCategoriesData } from '../../../data/lineageCategories';
import { loadLineageInfoData } from '../../../data/lineageLookup';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { trackNodeMutation } from '../../../lib/analyticsEmitter';

/**
 * t/3376: re-read the on-disk POV file immediately before a whole-file save and reattach any
 * `logical_form` that's present on disk but missing in memory — the fix for the t/3375 root bug
 * (a load-time strip via `stripInvalidLogicalForm`, t/3250, mutates the SAME object living in
 * store state; a later whole-file save then persists that in-memory deletion back to disk).
 *
 * LOAD-BEARING ASSUMPTION: nothing in the renderer edits `logical_form` today (t/3378 confirmed
 * the field is unconsumed by any UI) — reattaching an on-disk value is therefore always correct,
 * never a silent revert of a real user edit. If an edit path is ever added, this reattach-on-save
 * must be replaced by an explicit tombstone (e.g. a `logical_form: null` meaning "intentionally
 * cleared") so a genuine deletion isn't reverted by this safety net.
 *
 * GENERALIZATION SEAM: this is the one choke point all whole-file POV saves pass through — any
 * future strip-at-load field should reattach HERE, not by loosening the strip itself.
 *
 * TOCTOU RESIDUAL: protection is only as strong as this re-read. It reads on-disk state
 * immediately before write but does not lock against a concurrent writer landing between the
 * read and the write — whole-file save semantics (last-writer-wins) are otherwise unchanged.
 */
async function reattachStrippedLogicalForms(
  pov: typeof POV_KEYS[number],
  file: PovTaxonomyFile,
): Promise<PovTaxonomyFile> {
  let onDisk: PovTaxonomyFile | null;
  try {
    onDisk = await api.loadTaxonomyFile(pov) as PovTaxonomyFile | null;
  } catch (err) {
    // Fail-open-but-loud: a re-read failure must not abort the user's save (the whole-file
    // write itself is unaffected — only the reattach safety net is skipped for this save).
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'taxonomy-store', level: 'warn',
      message: `logical_form reattach-on-save: re-read of ${pov} failed — skipping reattach for this save (t/3376)`,
      data: { pov },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return file;
  }
  if (!onDisk?.nodes?.length) {
    // Fallback-path logging (docs/error-handling.md): a null/empty re-read is also silent
    // fail-open without this — e.g. the web build's ADR-001 graceful-empty on a fetch miss.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'taxonomy-store', level: 'warn',
      message: `logical_form reattach-on-save: re-read of ${pov} returned null/empty — skipping reattach for this save (t/3376)`,
      data: { pov },
    });
    return file;
  }
  const onDiskById = new Map(onDisk.nodes.map((n) => [(n as unknown as Record<string, unknown>).id, n]));
  let reattachedCount = 0;
  const nodes = file.nodes.map((node) => {
    const rec = node as unknown as Record<string, unknown>;
    if (rec.logical_form !== undefined) return node;
    const diskRec = onDiskById.get(rec.id) as unknown as Record<string, unknown> | undefined;
    if (diskRec?.logical_form === undefined) return node;
    reattachedCount++;
    return { ...node, logical_form: diskRec.logical_form } as PovNode;
  });
  if (reattachedCount === 0) return file;
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'taxonomy-store',
    level: 'warn',
    message: `Reattached ${reattachedCount} logical_form frame(s) stripped in memory before save (t/3376)`,
    data: { pov, reattachedCount },
  });
  return { ...file, nodes };
}

// t/3378: a per-load strip count above this is treated as systemic (not a one-off bad frame)
// and escalated from warn to error — CL's threshold from the t/3375 observability follow-up.
const LOGICAL_FORM_STRIP_SYSTEMIC_THRESHOLD = 5;

// t/3378: aggregate summary on top of the existing per-node WARN (t/3250) — the per-node
// records identify WHICH nodes were stripped; this summary makes the LOAD-WIDE blast radius
// visible so a mass strip (the t/3375 class) doesn't require counting individual log lines to notice.
function recordLogicalFormStripSummary(pov: string, strippedCount: number): void {
  if (strippedCount === 0) return;
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'taxonomy-store',
    level: strippedCount > LOGICAL_FORM_STRIP_SYSTEMIC_THRESHOLD ? 'error' : 'warn',
    message: `logical_form strip summary: ${strippedCount} frame(s) stripped on load (t/3378)`,
    data: { pov, strippedCount },
  });
}

/** A POV node referencing a policy via its own graph_attributes.policy_actions[] entry (t/3401) —
 *  "framing" is a per-node field (how THAT node frames the policy), not on the registry entry. */
export interface PolicyReferencingNode {
  id: string;
  label: string;
  pov: Pov;
  action?: string;
  framing?: string;
}

export type PinnedData =
  | { type: 'pov'; pov: Pov; node: PovNode }
  | { type: 'situations'; node: SituationNode }
  | { type: 'conflict'; conflict: ConflictFile }
  | { type: 'policy'; policy: PolicyRegistryEntry; referencingNodes: PolicyReferencingNode[] };

export interface PolicyRegistryEntry {
  id: string;
  action: string;
  description?: string;
  source_povs: string[];
  member_count: number;
}

// `CruxSource` and the shared `AggregatedCrux` shape are owned by lib/debate
// (types/synthesis.ts). Re-export CruxSource and EXTEND the lib AggregatedCrux with the
// TE-UI-only fields rather than dual-maintaining a full copy — so shared fields like the
// t/1676 `resolution_summary.undecided?` don't require parity patches here (t/1817).
export type { CruxSource };

export interface CruxExternalEvidence {
  url: string;
  note?: string;
  added_by: string;
  added_at: string;
}

/**
 * Aggregated crux as consumed by the TE renderer: the shared lib shape
 * (id/statement/type/sources/linked_node_ids/frequency/resolution_summary — including the
 * t/1676 `undecided?` field) plus TE-UI-only additions that are not part of debate synthesis.
 */
export interface AggregatedCrux extends LibAggregatedCrux {
  /** TE-UI only: human-readable question phrasing shown in NodeDetail (renderer concern). */
  question_form?: string;
  /** TE-UI only: user-curated external evidence links shown in CruxesTab (renderer concern). */
  external_evidence?: CruxExternalEvidence[];
}

// ── Slice interface ──

/** Write-API patch for a situation (t/3888). The store holds `RawInterpretation` (flat legacy
 *  nodes exist on disk), but the editor may only WRITE the strict BDI shape, so a string
 *  interpretation is a compile error here. Interpretations merge per POV. */
export type SituationNodeUpdate = Omit<Partial<SituationNode>, 'interpretations'> & {
  interpretations?: Partial<Record<keyof SituationNode['interpretations'], Interpretation>>;
};

/** A blank per-POV interpretation in the required BDI shape (t/3888). */
const emptyBdi = (): Interpretation => ({ belief: '', desire: '', intention: '', summary: '' });

// t/3888 save-gate helpers. Kept at module scope so save() doesn't grow past its
// complexity-budget baseline; the rule itself lives in lib (findSituationBdiViolations).
const NO_BDI_REFUSAL: SituationBdiRefusal = { errors: {}, message: '' };

function situationBdiOutcome(nodes: SituationNode[], baseline: Record<string, string>): SituationBdiRefusal {
  return checkSituationBdi(nodes, baseline) ?? NO_BDI_REFUSAL;
}

/** The save banner: the BDI refusal names node/POV/fields; schema errors keep the generic text. */
function saveFailureMessage(bdi: SituationBdiRefusal, totalErrors: number): string {
  if (!bdi.message) return 'Validation failed. Fix errors before saving.';
  const other = totalErrors - Object.keys(bdi.errors).length;
  return other > 0 ? `${bdi.message}\nAlso fix the ${other} other highlighted field${other === 1 ? '' : 's'}.` : bdi.message;
}

/** What a cross-POV move did to the node's POV tags (t/3972), shown on the moved node. */
export interface PovMoveReport {
  fromId: string;
  toId: string;
  sourcePov: Pov;
  targetPov: Pov;
  strippedTags: string[];
}

/**
 * POV tags are POV-scoped (t/3955 spec §2.1), so a tag carried into another POV is always invalid.
 * Strip them on a cross-POV move and say so (t/3972; CL decision 3, TL t/3955#4 condition 3): the
 * WARN is the Fallback-Path Logging record, and the returned list feeds the visible move report.
 * A bare string is the PowerShell one-element unroll; it is reported as one tag, not dropped silently.
 */
function stripPovTagsForMove(node: PovNode, toId: string, sourcePov: Pov, targetPov: Pov): { node: PovNode; strippedTags: string[] } {
  const { pov_tags: carried, ...rest } = node;
  const strippedTags = Array.isArray(carried) ? carried.map(String) : carried == null ? [] : [String(carried)];
  if (strippedTags.length > 0) {
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'taxonomy-store', level: 'warn',
      message: 'Cross-POV move stripped POV tags (they do not apply in the target POV)',
      data: { from_id: node.id, to_id: toId, source_pov: sourcePov, target_pov: targetPov, stripped_tags: strippedTags },
    });
  }
  return { node: rest as PovNode, strippedTags };
}

export interface TaxonomyDataSlice {
  accelerationist: PovTaxonomyFile | null;
  safetyist: PovTaxonomyFile | null;
  skeptic: PovTaxonomyFile | null;
  situations: SituationsFile | null;
  /** t/3888: interpretations as last loaded/saved (id → key), so the save gate checks only
   *  situations whose interpretations changed. See utils/situationBdiGate.ts. */
  situationsBaseline: Record<string, string>;
  /** t/3973: pov_tags as last loaded/saved (node id → fingerprint); gates registry membership per node. */
  povTagsBaseline: Record<string, string>;
  /** t/4034: each node's policy ids as last loaded/saved; decides which registry counts a save recounts. */
  policyIdsBaseline: Record<string, string>;
  policyRegistry: PolicyRegistryEntry[] | null;
  conflicts: ConflictFile[];
  aggregatedCruxes: AggregatedCrux[] | null;

  activeTab: TabId;
  selectedNodeId: string | null;
  dirty: Set<string>;
  validationErrors: ValidationErrors;
  saveError: string | null;
  loadError: string | null;
  // t/2064: the post-save embedding refresh degraded (non-empty staleNodeIds, or the call
  // rejected). Surfaced as a coarse non-blocking banner — NOT a saveError, since the durable
  // file-save itself succeeded; only similarity/related-node results may be temporarily stale.
  embeddingsStale: boolean;
  staleEmbeddingNodeIds: string[];
  /** t/3984: untouched nodes the last successful save carried with POV tags no longer in the registry. */
  orphanedTagNodeIds: string[];
  /** t/4034: the post-save registry recount could not update these policies' counts. */
  policyRecountNotice: PolicyRecountNotice | null;
  integrityIssues: ValidationIssue[];
  fixIntegrityErrors: () => void;
  loading: boolean;
  backgroundLoading: boolean;
  loadingProgress: { completed: string[]; total: number };

  pinnedStack: PinnedData[];
  pinAtDepth: (depth: number, data: PinnedData) => void;
  closePinnedFromDepth: (depth: number) => void;

  setActiveTab: (tab: TabId) => void;
  setSelectedNodeId: (id: string | null) => void;
  navigateToNode: (tab: TabId, id: string) => void;
  /** Reverse of navigateToNode: switch to the Conflicts view and select a conflict by its claim_id. */
  navigateToConflict: (claimId: string) => void;

  loadAll: (force?: boolean) => Promise<void>;
  save: () => Promise<void>;
  dismissSaveError: () => void;
  dismissEmbeddingsStale: () => void;
  dismissOrphanedTagNotice: () => void;
  dismissPolicyRecountNotice: () => void;

  updatePovNode: (pov: Pov, nodeId: string, updates: Partial<PovNode>, editSource?: { source: TextEditSource; debateId?: string; reason?: string }) => void;
  createPovNode: (pov: Pov, category: Category) => string;
  deletePovNode: (pov: Pov, nodeId: string) => void;
  movePovNodeCategory: (pov: Pov, nodeId: string, newCategory: Category) => string | null;
  movePovNode: (sourcePov: Pov, nodeId: string, targetPov: Pov, targetCategory: Category) => void;
  /** t/3972: the last cross-POV move's tag report; NodeDetail shows it on the moved node. */
  lastPovMoveReport: PovMoveReport | null;
  clearPovMoveReport: () => void;

  updateSituationNode: (nodeId: string, updates: SituationNodeUpdate) => void;
  createSituationNode: () => string;
  deleteSituationNode: (nodeId: string) => void;

  updateConflict: (claimId: string, updates: Partial<ConflictFile>) => void;
  createConflict: (claimLabel: string) => string;
  deleteConflict: (claimId: string) => void;
  addConflictInstance: (claimId: string, instance: ConflictInstance) => void;
  removeConflictInstance: (claimId: string, index: number) => void;
  updateConflictInstance: (claimId: string, index: number, updates: Partial<ConflictInstance>) => void;
  addConflictNote: (claimId: string, note: ConflictNote) => void;
  removeConflictNote: (claimId: string, index: number) => void;
  updateConflictNote: (claimId: string, index: number, updates: Partial<ConflictNote>) => void;

  getAllNodeIds: () => string[];
  getAllConflictIds: () => string[];
  getLabelForId: (id: string) => string;
  getDescriptionForId: (id: string) => string;
  lookupPinnedData: (id: string) => PinnedData | null;

  edgesFile: EdgesFile | null;
  edgesLoading: boolean;
  relatedNodeId: string | null;
  selectedEdge: Edge | null;
  loadEdges: () => Promise<void>;
  showRelatedEdges: (nodeId: string | null) => void;
  selectEdge: (edge: Edge | null) => void;

  toolbarPanel: ToolbarPanel;
  setToolbarPanel: (panel: ToolbarPanel) => void;
  pendingLineageValue: string | null;
  navigateToLineage: (value: string) => void;
  pendingSearchRelatedId: string | null;
  navigateToSearchRelated: (nodeId: string) => void;
  previousView: { panel: ToolbarPanel; nodeId: string | null } | null;
  navigateBack: () => void;

  cruxDetailId: string | null;
  showCruxDetail: (id: string | null) => void;
}

// ── Slice creator ──

export const createTaxonomyDataSlice: StateCreator<TaxonomyStore, [], [], TaxonomyDataSlice> = (set, get) => ({
  accelerationist: null,
  safetyist: null,
  skeptic: null,
  situations: null,
  situationsBaseline: {},
  povTagsBaseline: {},
  policyIdsBaseline: {},
  policyRegistry: null,
  conflicts: [],
  aggregatedCruxes: null,

  activeTab: 'accelerationist',
  selectedNodeId: null,
  lastPovMoveReport: null,
  dirty: new Set(),
  validationErrors: {},
  saveError: null,
  loadError: null,
  embeddingsStale: false,
  staleEmbeddingNodeIds: [],
  orphanedTagNodeIds: [],
  policyRecountNotice: null,
  integrityIssues: [],
  loading: false,
  backgroundLoading: false,
  loadingProgress: { completed: [], total: 0 },

  pinnedStack: [],
  pinAtDepth: (depth, data) => set((state) => ({
    pinnedStack: [...state.pinnedStack.slice(0, depth), data],
  })),
  closePinnedFromDepth: (depth) => set((state) => ({
    pinnedStack: state.pinnedStack.slice(0, depth),
  })),

  setActiveTab: (tab) => {
    const prev = get().activeTab;
    set({ activeTab: tab, selectedNodeId: null, validationErrors: {} });
    getGlobalRecorder()?.record({ type: 'ui.navigate', component: 'tab-bar', level: 'info', message: 'tab.switch', data: { from: prev, to: tab } });
    api.trackEvent('view_change', tab, { from: prev });
  },
  setSelectedNodeId: (id) => {
    set({ selectedNodeId: id, validationErrors: {} });
    getGlobalRecorder()?.record({ type: 'ui.select', component: 'node-list', level: 'debug', message: 'node.select', data: { nodeId: id } });
  },
  navigateToNode: (tab, id) => {
    const prev = get().activeTab;
    set({ activeTab: tab, selectedNodeId: id, validationErrors: {} });
    getGlobalRecorder()?.record({ type: 'ui.navigate', component: 'tab-bar', level: 'info', message: 'node.navigate', data: { from: prev, to: tab, nodeId: id } });
  },
  navigateToConflict: (claimId) => {
    const prev = get().activeTab;
    // The Conflicts view selects by claim_id via the shared selectedNodeId field;
    // ConflictsTab/ConflictListItem handle showing + scrolling the selected conflict.
    set({ activeTab: 'conflicts', selectedNodeId: claimId, validationErrors: {} });
    getGlobalRecorder()?.record({ type: 'ui.navigate', component: 'tab-bar', level: 'info', message: 'conflict.navigate', data: { from: prev, to: 'conflicts', claimId } });
  },

  loadAll: async (force = false) => {
    const state = get();
    if (state.loading) return;
    if (!force && state.accelerationist) return;
    const steps = [
      'Accelerationist', 'Safetyist', 'Skeptic', 'Situations',
      'Policy Registry',
    ];
    set({ loading: true, backgroundLoading: false, loadError: null, loadingProgress: { completed: [], total: steps.length } });

    const track = <T,>(label: string, promise: Promise<T>): Promise<T> =>
      promise.then((result) => {
        set((s) => ({
          loadingProgress: {
            ...s.loadingProgress,
            completed: [...s.loadingProgress.completed, label],
          },
        }));
        return result;
      });

    try {
      // t/4187: an editor load — sets the bridge's version cell so save() can carry If-Match.
      // The pre-save re-read in reattachStrippedLogicalForms below must stay on plain
      // loadTaxonomyFile (never touch the cell) or the precondition would always pass.
      const acc = await track(steps[0], api.loadTaxonomyFileForEdit('accelerationist'));
      const accFile = acc as PovTaxonomyFile;
      if (accFile?.nodes) {
        let accStrippedCount = 0;
        for (const node of accFile.nodes) {
          const rec = node as unknown as Record<string, unknown>;
          normalizeNodeProperties(rec);
          // t/3250: graceful-degrade a malformed proposed logical_form (WARN + omit, never drop the node).
          const lf = stripInvalidLogicalForm(rec);
          if (lf.removed) {
            accStrippedCount++;
            getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Stripped malformed node.logical_form (t/3250)', data: { pov: 'accelerationist', node_id: rec.id, issue: lf.issue } });
          }
        }
        recordLogicalFormStripSummary('accelerationist', accStrippedCount);
      }
      set({
        accelerationist: accFile,
        povTagsBaseline: buildPovTagBaseline((accFile as PovTaxonomyFile | null)?.nodes ?? []),
        policyIdsBaseline: buildPolicyIdBaseline((accFile as PovTaxonomyFile | null)?.nodes ?? []),
        loading: false,
        backgroundLoading: true,
        dirty: new Set(),
        embeddingCache: new Map(),
        embeddingDirty: true,
      });

      const [saf, skp, cc, polReg] = await Promise.all([
        track(steps[1], api.loadTaxonomyFileForEdit('safetyist')),
        track(steps[2], api.loadTaxonomyFileForEdit('skeptic')),
        track(steps[3], api.loadTaxonomyFileForEdit('situations')),
        track(steps[4], api.loadPolicyRegistry()),
      ]);
      // Defer conflict file load — on cold starts this triggers 1,242 individual
      // API reads (5s). Let critical taxonomy data render first; the server-side
      // cache warm will likely complete before this fires.
      setTimeout(() => {
        void api.loadConflictFiles().then((c) => set({ conflicts: c as ConflictFile[] })).catch((err) => {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to load conflict files (deferred)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        });
      }, 3000);
      void api.loadConflictClusters().then((d) => {
        const clusters = d && typeof d === 'object' && Array.isArray((d as { clusters: unknown }).clusters)
          ? (d as { clusters: { label: string; nodeIds: string[] }[] }).clusters : null;
        set({ conflictClusters: clusters });
      }).catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to load conflict clusters (deferred)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      });
      void api.loadAggregatedCruxes().then((d) => {
        const cruxes = d && typeof d === 'object' && Array.isArray((d as { cruxes: unknown }).cruxes)
          ? (d as { cruxes: AggregatedCrux[] }).cruxes : null;
        set({ aggregatedCruxes: cruxes });
      }).catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to load aggregated cruxes (deferred)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      });
      void loadLineageCategoriesData();
      void loadLineageInfoData();
      const regData = polReg as { policies: PolicyRegistryEntry[] } | null;
      for (const povFile of [saf, skp] as PovTaxonomyFile[]) {
        if (povFile?.nodes) {
          let povStrippedCount = 0;
          for (const node of povFile.nodes) {
            const rec = node as unknown as Record<string, unknown>;
            normalizeNodeProperties(rec);
            // t/3250: graceful-degrade a malformed proposed logical_form (WARN + omit, never drop the node).
            const lf = stripInvalidLogicalForm(rec);
            if (lf.removed) {
              povStrippedCount++;
              getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Stripped malformed node.logical_form (t/3250)', data: { pov: povFile.pov, node_id: rec.id, issue: lf.issue } });
            }
          }
          recordLogicalFormStripSummary(povFile.pov, povStrippedCount);
        }
      }
      const situationsFile = coerceSituationDivergence(cc) as SituationsFile; // t/3002: guard interpretation_divergence type at load
      set({
        safetyist: saf as PovTaxonomyFile,
        skeptic: skp as PovTaxonomyFile,
        situations: situationsFile,
        situationsBaseline: buildSituationBaseline(situationsFile?.nodes ?? []),
        povTagsBaseline: { ...get().povTagsBaseline, ...buildPovTagBaseline([...((saf as PovTaxonomyFile | null)?.nodes ?? []), ...((skp as PovTaxonomyFile | null)?.nodes ?? [])]) },
        policyIdsBaseline: { ...get().policyIdsBaseline, ...buildPolicyIdBaseline([...((saf as PovTaxonomyFile | null)?.nodes ?? []), ...((skp as PovTaxonomyFile | null)?.nodes ?? []), ...(situationsFile?.nodes ?? [])]) },
        policyRegistry: regData?.policies ?? null,
        backgroundLoading: false,
        embeddingDirty: true,
      });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'Failed to load taxonomy data', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      const msg = mapErrorToUserMessage(err);
      set({ loading: false, backgroundLoading: false, saveError: msg, loadError: msg });
    }
  },

  dismissSaveError: () => set({ saveError: null, integrityIssues: [] }),
  dismissEmbeddingsStale: () => set({ embeddingsStale: false, staleEmbeddingNodeIds: [] }),
  dismissOrphanedTagNotice: () => set({ orphanedTagNodeIds: [] }),
  dismissPolicyRecountNotice: () => set({ policyRecountNotice: null }),

  fixIntegrityErrors: () => {
    const state = get();
    const issues = state.integrityIssues.filter(i => i.severity === 'error');
    if (issues.length === 0) return;

    const dirtyPovs = new Set<string>();
    const povKeys = ['accelerationist', 'safetyist', 'skeptic'] as const;

    // Valid edge endpoints / reference targets = all POV nodes + all situation nodes
    // (mirrors checkReferentialIntegrity's allIds set in validators.ts).
    const validNodeIds = new Set<string>();
    for (const p of povKeys) {
      const f = state[p] as PovTaxonomyFile | null;
      if (f) for (const n of f.nodes) validNodeIds.add(n.id);
    }
    const sitIds = new Set(state.situations?.nodes.map(n => n.id) ?? []);
    for (const id of sitIds) validNodeIds.add(id);

    for (const issue of issues) {
      // Edge-dangling errors are handled in bulk below — they have no owning node to mutate.
      if (issue.code === 'EDGE_DANGLING_SOURCE' || issue.code === 'EDGE_DANGLING_TARGET') continue;

      const entityPov = nodePovFromId(issue.entityId);
      const file = entityPov ? state[entityPov as keyof typeof state] as PovTaxonomyFile | null : null;
      if (!file) continue;
      const node = file.nodes.find(n => n.id === issue.entityId);
      if (!node) continue;

      if (issue.code === 'DANGLING_CHILD') {
        const match = issue.message.match(/Child '([^']+)'/);
        if (match) {
          node.children = node.children.filter(id => validNodeIds.has(id));
          if (entityPov) dirtyPovs.add(entityPov);
        }
      } else if (issue.code === 'DANGLING_PARENT') {
        node.parent_id = null;
        if (entityPov) dirtyPovs.add(entityPov);
      } else if (issue.code === 'DANGLING_SITUATION_REF') {
        node.situation_refs = node.situation_refs.filter(id => sitIds.has(id));
        if (entityPov) dirtyPovs.add(entityPov);
      }
    }

    // Edge integrity: drop any edge whose source or target no longer resolves to a node.
    let removedEdges = 0;
    let repairedEdgesFile = state.edgesFile;
    const hasEdgeIssues = issues.some(i => i.code === 'EDGE_DANGLING_SOURCE' || i.code === 'EDGE_DANGLING_TARGET');
    if (hasEdgeIssues && state.edgesFile) {
      const kept = state.edgesFile.edges.filter(e => validNodeIds.has(e.source) && validNodeIds.has(e.target));
      removedEdges = state.edgesFile.edges.length - kept.length;
      if (removedEdges > 0) {
        repairedEdgesFile = { ...state.edgesFile, edges: kept };
      }
    }

    if (dirtyPovs.size > 0 || removedEdges > 0) {
      const dirty = new Set(state.dirty);
      for (const p of dirtyPovs) dirty.add(p);
      if (removedEdges > 0) dirty.add('edges');
      getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'info', message: 'integrity.auto-fix', data: { fixed: issues.length, removed_edges: removedEdges, dirty: [...dirty] } });
      set({ dirty, edgesFile: repairedEdgesFile, saveError: null, integrityIssues: [], embeddingDirty: true });
    }
  },

  save: async () => {
    const state = get();
    const errors: ValidationErrors = {};
    const dirtyKeys = state.dirty;
    const saveStart = performance.now();

    getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'info', message: 'save.called', data: { dirty: [...dirtyKeys] } });
    if (dirtyKeys.size === 0) return;
    const orphanedTagNodeIds: string[] = []; // t/3984
    let bdi = NO_BDI_REFUSAL; // t/3888 — set in the situations branch below

    for (const key of dirtyKeys) {
      if ((POV_KEYS as readonly string[]).includes(key)) {
        const file = state[key as typeof POV_KEYS[number]];
        if (!file) continue;
        const result = povTaxonomyFileSchema.safeParse(file);
        if (!result.success) {
          Object.assign(errors, extractPovErrors(result.error, file.nodes));
        }
        const membership = povTagMembership(file.nodes, state.povTagsBaseline);
        Object.assign(errors, membership.errors);
        orphanedTagNodeIds.push(...membership.orphanedNodeIds); // t/3984: shown after a successful save
      } else if (key === 'situations') {
        const file = state.situations;
        if (!file) continue;
        const result = situationsFileSchema.safeParse(file);
        if (!result.success) {
          Object.assign(errors, extractPovErrors(result.error, file.nodes));
        }
        // t/3888: BDI gate on situations whose interpretations changed since load/save. The
        // structural Zod check above stays permissive on purpose (SO e/244#2 Finding 1): flat
        // legacy nodes exist on disk, so whole-file strictness would block every save.
        bdi = situationBdiOutcome(file.nodes, state.situationsBaseline);
        Object.assign(errors, bdi.errors);
      } else if (key.startsWith('conflict-')) {
        const conflict = state.conflicts.find(c => c.claim_id === key);
        if (!conflict) continue;
        const result = conflictFileSchema.safeParse(conflict);
        if (!result.success) {
          Object.assign(errors, extractConflictErrors(result.error, key));
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      getGlobalRecorder()?.record({ type: 'state.error', component: 'taxonomy-store', level: 'error', message: 'save.validation', data: { stage: 'schema', error_count: Object.keys(errors).length, situation_bdi_error_count: Object.keys(bdi.errors).length, errors, duration_ms: Math.round(performance.now() - saveStart) } });
      set({ validationErrors: errors, saveError: saveFailureMessage(bdi, Object.keys(errors).length) });
      return;
    }

    if (state.accelerationist && state.safetyist && state.skeptic && state.situations) {
      const taxData = {
        accelerationist: { nodes: state.accelerationist.nodes },
        safetyist: { nodes: state.safetyist.nodes },
        skeptic: { nodes: state.skeptic.nodes },
        situations: { nodes: state.situations.nodes },
        edges: state.edgesFile?.edges ?? [],
      };
      const integrity: ValidationResult = validateTaxonomy(taxData);
      const integrityErrors = integrity.issues.filter(i => i.severity === 'error');
      if (integrityErrors.length > 0) {
        const byCode = new Map<string, Map<string, number>>();
        for (const i of integrityErrors) {
          let entities = byCode.get(i.code);
          if (!entities) { entities = new Map(); byCode.set(i.code, entities); }
          entities.set(i.entityId, (entities.get(i.entityId) ?? 0) + 1);
        }
        const lines: string[] = [];
        for (const [code, entities] of byCode) {
          const ids = [...entities.entries()];
          if (ids.length <= 3) {
            lines.push(`${code}: ${ids.map(([id, n]) => n > 1 ? `${id} (×${n})` : id).join(', ')}`);
          } else {
            const shown = ids.slice(0, 2).map(([id, n]) => n > 1 ? `${id} (×${n})` : id).join(', ');
            lines.push(`${code}: ${shown} + ${ids.length - 2} more (${integrityErrors.filter(e => e.code === code).length} total)`);
          }
        }
        const errorSummary = lines.join('\n');
        getGlobalRecorder()?.record({ type: 'state.error', component: 'taxonomy-store', level: 'error', message: 'save.validation', data: { stage: 'integrity', error_count: integrityErrors.length, entities: integrityErrors.slice(0, 10).map(i => `${i.code}: ${i.entityId}`), duration_ms: Math.round(performance.now() - saveStart) } });
        set({
          validationErrors: errors,
          integrityIssues: integrityErrors,
          saveError: `Integrity check failed (${integrityErrors.length} error${integrityErrors.length > 1 ? 's' : ''}):\n${errorSummary}`,
        });
        return;
      }
      const integrityWarnings = integrity.issues.filter(i => i.severity === 'warning');
      if (integrityWarnings.length > 0) {
        getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'warn', message: 'save.validation', data: { stage: 'integrity', warning_count: integrityWarnings.length, entities: integrityWarnings.slice(0, 10).map(i => `${i.code}: ${i.entityId}`) } });
      }
    }

    set({ saveError: null, validationErrors: {} });

    try {
      const promises: Promise<void>[] = [];

      for (const key of dirtyKeys) {
        if ((POV_KEYS as readonly string[]).includes(key)) {
          const file = state[key as typeof POV_KEYS[number]];
          if (file) {
            const povKey = key as typeof POV_KEYS[number];
            promises.push(
              reattachStrippedLogicalForms(povKey, file).then((f) => api.saveTaxonomyFile(povKey, f)),
            );
          }
        } else if (key === 'situations') {
          const file = state.situations;
          if (file) {
            promises.push(api.saveTaxonomyFile('situations', file));
          }
        } else if (key.startsWith('conflict-')) {
          const conflict = state.conflicts.find(c => c.claim_id === key);
          if (conflict) {
            promises.push(api.saveConflictFile(key, conflict));
          }
        } else if (key === 'edges') {
          // New-edge persistence (t/1816). The whole edges file is dirty-marked by the
          // edge-mutating paths — integrity auto-fix, node-id rename, and acceptConsensus's
          // convergence edges — but `save()` had no edges branch, so `dirty` was cleared
          // without ever writing them (the latent no-op). Persist via the frozen
          // `saveEdges` bridge method (web PUT /api/edges / electron save-edges IPC →
          // writeEdgesFile atomic temp→rename). Whole-file, mirroring update/swap/bulk.
          if (state.edgesFile) {
            promises.push(api.saveEdges(state.edgesFile));
          }
        }
      }

      await Promise.all(promises);
      // t/4034: recount the registry for policy ids this save changed, BEFORE the commit so it lands with the edit.
      const policyRecount = await runPolicyRecount(affectedPolicyIds(savedPolicyNodes(dirtyKeys, state), allPolicyNodes(state), state.policyIdsBaseline), api.recountPolicyMembers, { leavesRegistryUncommitted: import.meta.env.VITE_TARGET !== 'web' });

      const commitResult = await api.syncCommit();
      // save.completed = file write + git commit done — the durable save point (`dirty` is
      // cleared next). The post-save embedding refresh below is a SEPARATE, non-fatal phase
      // that emits its own save.embedding-refresh-{dispatched,failed} events, never
      // save.failed. So save.failed can ONLY be a file-write/commit failure and fires
      // BEFORE this event — never after it. (t/1710; the non-fatal boundary is t/1707.)
      getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'info', message: 'save.completed', data: { files_written: promises.length, duration_ms: Math.round(performance.now() - saveStart), commitSha: commitResult.commitSha, filesCommitted: commitResult.filesCommitted } });
      api.trackEvent('taxonomy_save', 'taxonomy', { files: promises.length });
      // t/3888: the saved snapshot is now what's on disk, so it becomes the gate's baseline.
      set({ dirty: new Set(), orphanedTagNodeIds, ...baselineAfterSave(dirtyKeys, state), policyRegistry: mergePolicyCounts(get().policyRegistry, policyRecount.updates), policyRecountNotice: policyRecount.notice });

      // Post-save embedding refresh — NON-FATAL, own boundary (t/1707).
      // The file write, commit, and `dirty` clear above have already succeeded. A throw
      // while building or dispatching the embedding batch must NOT surface as
      // "Save failed" (a trust-eroding false negative — the edit IS saved). Record it as
      // a non-blocking event and leave `saveError` untouched. The null-guards below fix
      // today's instance (undefined `node.description`); this boundary fixes the class.
      try {
        const stripExcludes = (text: string | undefined) => (text ?? '').replace(/\s*Excludes:.*/s, '').trim();
        const extractExcludesText = (text: string | undefined): string | undefined => {
          const match = (text ?? '').match(/\bExcludes:\s*([\s\S]*?)\.?\s*$/);
          return match?.[1]?.trim() || undefined;
        };
        const nodesToEmbed: { id: string; text: string; pov: string; exclusionText?: string }[] = [];
        for (const key of dirtyKeys) {
          if ((POV_KEYS as readonly string[]).includes(key)) {
            const file = state[key as typeof POV_KEYS[number]];
            if (file) {
              for (const node of file.nodes) {
                nodesToEmbed.push({ id: node.id, text: node.description, pov: key, exclusionText: extractExcludesText(node.description) });
              }
            }
          } else if (key === 'situations') {
            const file = state.situations;
            if (file) {
              for (const node of file.nodes) {
                nodesToEmbed.push({
                  id: node.id,
                  text: `[situations]\nID: ${node.id}\nLabel: ${node.label}\nDescription: ${stripExcludes(node.description)}\nAccelerationist interpretation: ${interpretationText(node.interpretations.accelerationist)}\nSafetyist interpretation: ${interpretationText(node.interpretations.safetyist)}\nSkeptic interpretation: ${interpretationText(node.interpretations.skeptic)}`,
                  pov: 'situations',
                  exclusionText: extractExcludesText(node.description),
                });
              }
            }
          }
        }
        if (nodesToEmbed.length > 0) {
          // Positive marker that the post-save embedding phase started — distinct from
          // save.completed (file write), pairs with save.embedding-refresh-failed (t/1710).
          getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'info', message: 'save.embedding-refresh-dispatched', data: { node_count: nodesToEmbed.length } });
          // t/2064: consume the resolved { staleNodeIds } instead of swallowing the outcome.
          // Non-blocking (per TL): the durable file-save already succeeded above — any degradation
          // is surfaced via the embeddingsStale store flag (a coarse banner), never as saveError.
          api.updateNodeEmbeddings(nodesToEmbed)
            .then((result) => {
              const stale = result?.staleNodeIds ?? [];
              if (stale.length > 0) {
                getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'warn', message: 'save.embedding-refresh-stale', data: { stale_count: stale.length, node_count: nodesToEmbed.length } });
                set({ embeddingsStale: true, staleEmbeddingNodeIds: stale });
              } else if (get().embeddingsStale) {
                set({ embeddingsStale: false, staleEmbeddingNodeIds: [] }); // full success clears prior degradation
              }
            })
            .catch((err) => {
              // Reject: cannot confirm the refresh — degrade (flag) rather than swallow (t/2064).
              getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to update node embeddings after save', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
              console.warn('[save] Failed to update embeddings:', err);
              set({ embeddingsStale: true, staleEmbeddingNodeIds: nodesToEmbed.map(n => n.id) });
            });
        }
      } catch (embedErr) {
        // Non-fatal: the save already succeeded. Surface as a warning, never as saveError.
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'save.embedding-refresh-failed', error: { name: (embedErr as Error).name ?? 'Error', message: String(embedErr), stack: (embedErr as Error).stack } });
        console.warn('[save] Post-save embedding refresh failed (save itself succeeded):', embedErr);
      }
    } catch (err) {
      getGlobalRecorder()?.record(saveFailureRecord(err, saveStart));
      set({ saveError: saveErrorText(err) });
    }
  },

  updatePovNode: (pov, nodeId, updates, editSource) => {
    getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'debug', message: 'updatePovNode.called', data: { pov, nodeId, fields: Object.keys(updates), editSource: editSource?.source ?? 'manual' } });
    trackNodeMutation('edit', pov, nodeId);
    if (updates.category) {
      const validation = validatePovNodeId(nodeId, updates.category);
      if (!validation.valid) {
        console.error(`[taxonomy-store] updatePovNode rejected: ${validation.error}`);
        return;
      }
    }
    set((state) => {
      const file = state[pov];
      if (!file) return state;
      const date = todayISO();
      const source = editSource?.source ?? 'interactive';
      const newNodes = file.nodes.map(n => {
        if (n.id !== nodeId) return n;
        const patched = { ...n, ...updates };
        if ('label' in updates && updates.label !== n.label) {
          const entry: TextHistoryEntry = { date, previous: n.label, value: updates.label!, source, ...(editSource?.debateId ? { debate_id: editSource.debateId } : {}), ...(editSource?.reason ? { reason: editSource.reason } : {}) };
          patched.label_history = [...(n.label_history ?? []), entry];
        }
        if ('description' in updates && updates.description !== n.description) {
          const entry: TextHistoryEntry = { date, previous: n.description, value: updates.description!, source, ...(editSource?.debateId ? { debate_id: editSource.debateId } : {}), ...(editSource?.reason ? { reason: editSource.reason } : {}) };
          patched.description_history = [...(n.description_history ?? []), entry];
          patched.plain_description = null;
        }
        return patched;
      });
      const newFile: PovTaxonomyFile = {
        ...file,
        last_modified: date,
        nodes: newNodes,
      };
      const newDirty = new Set(state.dirty);
      newDirty.add(pov);
      return { [pov]: newFile, dirty: newDirty, embeddingDirty: true };
    });
  },

  createPovNode: (pov, category) => {
    const state = get();
    const file = state[pov];
    if (!file) {
      getGlobalRecorder()?.record({ type: 'state.error', component: 'taxonomy-store', level: 'warn', message: 'createPovNode: POV file not loaded', data: { pov, category } });
      return '';
    }
    const existingIds = file.nodes.map(n => n.id);
    const newId = generatePovNodeId(pov, category, existingIds);
    const validation = validatePovNodeId(newId, category);
    if (!validation.valid) {
      console.error(`[taxonomy-store] createPovNode rejected: ${validation.error}`);
      getGlobalRecorder()?.record({ type: 'state.error', component: 'taxonomy-store', level: 'warn', message: 'createPovNode: validation failed', data: { pov, category, error: validation.error } });
      return '';
    }
    const newNode: PovNode = {
      id: newId,
      category,
      label: '',
      description: '',
      parent_id: null,
      children: [],
      situation_refs: [],
    };
    const newFile: PovTaxonomyFile = {
      ...file,
      last_modified: todayISO(),
      nodes: [...file.nodes, newNode],
    };
    const newDirty = new Set(state.dirty);
    newDirty.add(pov);
    set({ [pov]: newFile, dirty: newDirty, selectedNodeId: newId, embeddingDirty: true });
    trackNodeMutation('create', pov, newId);
    return newId;
  },

  deletePovNode: (pov, nodeId) => {
    trackNodeMutation('delete', pov, nodeId);
    set((state) => {
      const file = state[pov];
      if (!file) return state;
      const newNodes = file.nodes.filter(n => n.id !== nodeId);
      const newFile: PovTaxonomyFile = {
        ...file,
        last_modified: todayISO(),
        nodes: newNodes,
      };
      const newDirty = new Set(state.dirty);
      newDirty.add(pov);
      return {
        [pov]: newFile,
        dirty: newDirty,
        embeddingDirty: true,
        selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      };
    });
  },

  movePovNodeCategory: (pov, nodeId, newCategory) => {
    let resultId: string | null = null;
    set((state) => {
      const file = state[pov];
      if (!file) return state;
      const oldNode = file.nodes.find(n => n.id === nodeId);
      if (!oldNode) return state;

      const oldId = oldNode.id;
      const existingIds = file.nodes.map(n => n.id);
      const newId = generatePovNodeId(pov, newCategory, existingIds);
      const validation = validatePovNodeId(newId, newCategory);
      if (!validation.valid) {
        console.error(`[taxonomy-store] movePovNodeCategory rejected: ${validation.error}`);
        return state;
      }
      resultId = newId;

      const newNode: PovNode = {
        ...oldNode,
        id: newId,
        category: newCategory,
      };

      const replaceId = (id: string) => (id === oldId ? newId : id);
      const newNodes = file.nodes.map(n => {
        if (n.id === oldId) return newNode;
        let changed = false;
        let updatedParent = n.parent_id;
        let updatedChildren = n.children;
        if (n.parent_id === oldId) {
          updatedParent = newId;
          changed = true;
        }
        if ((n.children ?? []).includes(oldId)) {
          updatedChildren = (n.children ?? []).map(replaceId);
          changed = true;
        }
        return changed ? { ...n, parent_id: updatedParent, children: updatedChildren } : n;
      });
      const newFile: PovTaxonomyFile = {
        ...file,
        last_modified: todayISO(),
        nodes: newNodes,
      };

      const newDirty = new Set(state.dirty);
      newDirty.add(pov);

      let newSituations = state.situations;
      if (newSituations) {
        let ccChanged = false;
        const ccNodes = newSituations.nodes.map(n => {
          if ((n.linked_nodes ?? []).includes(oldId)) {
            ccChanged = true;
            return { ...n, linked_nodes: (n.linked_nodes ?? []).map(replaceId) };
          }
          return n;
        });
        if (ccChanged) {
          newSituations = { ...newSituations, last_modified: todayISO(), nodes: ccNodes };
          newDirty.add('situations');
        }
      }

      let newConflicts = state.conflicts;
      let conflictsChanged = false;
      newConflicts = newConflicts.map(c => {
        if ((c.linked_taxonomy_nodes ?? []).includes(oldId)) {
          conflictsChanged = true;
          newDirty.add(c.claim_id);
          return { ...c, linked_taxonomy_nodes: (c.linked_taxonomy_nodes ?? []).map(replaceId) };
        }
        return c;
      });

      return {
        [pov]: newFile,
        situations: newSituations,
        conflicts: conflictsChanged ? newConflicts : state.conflicts,
        dirty: newDirty,
        selectedNodeId: newId,
        embeddingDirty: true,
      };
    });
    return resultId;
  },

  clearPovMoveReport: () => set({ lastPovMoveReport: null }),

  movePovNode: (sourcePov, nodeId, targetPov, targetCategory) => {
    if (sourcePov === targetPov) {
      get().movePovNodeCategory(sourcePov, nodeId, targetCategory);
      return;
    }

    set((state) => {
      const sourceFile = state[sourcePov];
      const targetFile = state[targetPov];
      if (!sourceFile || !targetFile) return state;

      const oldNode = sourceFile.nodes.find(n => n.id === nodeId);
      if (!oldNode) return state;

      const oldId = oldNode.id;
      const targetExistingIds = targetFile.nodes.map(n => n.id);
      const newId = generatePovNodeId(targetPov, targetCategory, targetExistingIds);
      const validation = validatePovNodeId(newId, targetCategory);
      if (!validation.valid) {
        console.error(`[taxonomy-store] movePovNode rejected: ${validation.error}`);
        return state;
      }

      const { node: untagged, strippedTags } = stripPovTagsForMove(oldNode, newId, sourcePov, targetPov);
      const newNode: PovNode = {
        ...untagged,
        id: newId,
        category: targetCategory,
        parent_id: null,
        children: [],
      };
      const lastPovMoveReport: PovMoveReport = { fromId: oldId, toId: newId, sourcePov, targetPov, strippedTags };

      const newSourceNodes = sourceFile.nodes
        .filter(n => n.id !== oldId)
        .map(n => {
          if (n.parent_id === oldId) return { ...n, parent_id: null };
          if ((n.children ?? []).includes(oldId)) return { ...n, children: (n.children ?? []).filter(c => c !== oldId) };
          return n;
        });

      const newTargetNodes = [...targetFile.nodes, newNode];

      const replaceId = (id: string) => (id === oldId ? newId : id);
      const newDirty = new Set(state.dirty);
      newDirty.add(sourcePov);
      newDirty.add(targetPov);

      let newSituations = state.situations;
      if (newSituations) {
        let ccChanged = false;
        const ccNodes = newSituations.nodes.map(n => {
          if ((n.linked_nodes ?? []).includes(oldId)) {
            ccChanged = true;
            return { ...n, linked_nodes: (n.linked_nodes ?? []).map(replaceId) };
          }
          return n;
        });
        if (ccChanged) {
          newSituations = { ...newSituations, last_modified: todayISO(), nodes: ccNodes };
          newDirty.add('situations');
        }
      }

      let newConflicts = state.conflicts;
      let conflictsChanged = false;
      newConflicts = newConflicts.map(c => {
        if ((c.linked_taxonomy_nodes ?? []).includes(oldId)) {
          conflictsChanged = true;
          newDirty.add(c.claim_id);
          return { ...c, linked_taxonomy_nodes: (c.linked_taxonomy_nodes ?? []).map(replaceId) };
        }
        return c;
      });

      let newEdgesFile = state.edgesFile;
      if (newEdgesFile) {
        let edgesChanged = false;
        const newEdges = newEdgesFile.edges.map(e => {
          const srcMatch = e.source === oldId;
          const tgtMatch = e.target === oldId;
          if (srcMatch || tgtMatch) {
            edgesChanged = true;
            return {
              ...e,
              source: srcMatch ? newId : e.source,
              target: tgtMatch ? newId : e.target,
            };
          }
          return e;
        });
        if (edgesChanged) {
          newEdgesFile = { ...newEdgesFile, edges: newEdges };
          newDirty.add('edges');
        }
      }

      return {
        lastPovMoveReport,
        [sourcePov]: { ...sourceFile, last_modified: todayISO(), nodes: newSourceNodes },
        [targetPov]: { ...targetFile, last_modified: todayISO(), nodes: newTargetNodes },
        situations: newSituations,
        conflicts: conflictsChanged ? newConflicts : state.conflicts,
        edgesFile: newEdgesFile,
        dirty: newDirty,
        selectedNodeId: newId,
        embeddingDirty: true,
      };
    });
  },

  updateSituationNode: (nodeId, updates) => {
    set((state) => {
      const file = state.situations;
      if (!file) return state;
      const { interpretations: interpPatch, ...rest } = updates;
      const newNodes = file.nodes.map(n => {
        if (n.id !== nodeId) return n;
        // t/3888: interpretations merge per POV; untouched POVs keep their stored (Raw) value.
        const patched: SituationNode = {
          ...n, ...rest,
          ...(interpPatch ? { interpretations: { ...n.interpretations, ...interpPatch } } : {}),
        };
        if ('description' in updates && updates.description !== n.description) {
          patched.plain_description = null;
        }
        return patched;
      });
      const newFile: SituationsFile = {
        ...file,
        last_modified: todayISO(),
        nodes: newNodes,
      };
      const newDirty = new Set(state.dirty);
      newDirty.add('situations');
      return { situations: newFile, dirty: newDirty, embeddingDirty: true };
    });
  },

  createSituationNode: () => {
    const state = get();
    const file = state.situations;
    if (!file) return '';
    const existingIds = file.nodes.map(n => n.id);
    const newId = generateSituationId(existingIds);
    const newNode: SituationNode = {
      id: newId,
      label: '',
      description: '',
      // t/3888: mint the BDI shape so the editor opens its four-field BDI editor. Typed strict:
      // a string here is a compile error. The save gate refuses it until B/D/I are filled.
      interpretations: { accelerationist: emptyBdi(), safetyist: emptyBdi(), skeptic: emptyBdi() },
      linked_nodes: [],
      conflict_ids: [],
    };
    const newFile: SituationsFile = {
      ...file,
      last_modified: todayISO(),
      nodes: [...file.nodes, newNode],
    };
    const newDirty = new Set(state.dirty);
    newDirty.add('situations');
    set({ situations: newFile, dirty: newDirty, selectedNodeId: newId, embeddingDirty: true });
    trackNodeMutation('create', 'situations', newId);
    return newId;
  },

  deleteSituationNode: (nodeId) => {
    trackNodeMutation('delete', 'situations', nodeId);
    set((state) => {
      const file = state.situations;
      if (!file) return state;
      const newNodes = file.nodes.filter(n => n.id !== nodeId);
      const newFile: SituationsFile = {
        ...file,
        last_modified: todayISO(),
        nodes: newNodes,
      };
      const newDirty = new Set(state.dirty);
      newDirty.add('situations');
      return {
        situations: newFile,
        dirty: newDirty,
        embeddingDirty: true,
        selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      };
    });
  },

  updateConflict: (claimId, updates) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId ? { ...c, ...updates } : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  createConflict: (claimLabel) => {
    const state = get();
    const existingIds = state.conflicts.map(c => c.claim_id);
    const newId = generateConflictId(claimLabel, existingIds);
    const newConflict: ConflictFile = {
      claim_id: newId,
      claim_label: claimLabel,
      description: '',
      status: 'open',
      linked_taxonomy_nodes: [],
      instances: [],
      human_notes: [],
    };
    const newDirty = new Set(state.dirty);
    newDirty.add(newId);
    set({
      conflicts: [...state.conflicts, newConflict],
      dirty: newDirty,
      selectedNodeId: newId,
      embeddingDirty: true,
    });
    return newId;
  },

  deleteConflict: (claimId) => {
    set((state) => {
      const newConflicts = state.conflicts.filter(c => c.claim_id !== claimId);
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return {
        conflicts: newConflicts,
        dirty: newDirty,
        embeddingDirty: true,
        selectedNodeId: state.selectedNodeId === claimId ? null : state.selectedNodeId,
      };
    });
  },

  addConflictInstance: (claimId, instance) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId
          ? { ...c, instances: [...c.instances, instance] }
          : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  removeConflictInstance: (claimId, index) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId
          ? { ...c, instances: c.instances.filter((_, i) => i !== index) }
          : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  updateConflictInstance: (claimId, index, updates) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId
          ? {
              ...c,
              instances: c.instances.map((inst, i) =>
                i === index ? { ...inst, ...updates } : inst,
              ),
            }
          : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  addConflictNote: (claimId, note) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId
          ? { ...c, human_notes: [...c.human_notes, note] }
          : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  removeConflictNote: (claimId, index) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId
          ? { ...c, human_notes: c.human_notes.filter((_, i) => i !== index) }
          : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  updateConflictNote: (claimId, index, updates) => {
    set((state) => {
      const newConflicts = state.conflicts.map(c =>
        c.claim_id === claimId
          ? {
              ...c,
              human_notes: c.human_notes.map((note, i) =>
                i === index ? { ...note, ...updates } : note,
              ),
            }
          : c,
      );
      const newDirty = new Set(state.dirty);
      newDirty.add(claimId);
      return { conflicts: newConflicts, dirty: newDirty, embeddingDirty: true };
    });
  },

  getAllNodeIds: () => {
    const state = get();
    const ids: string[] = [];
    for (const pov of POV_KEYS) {
      const file = state[pov];
      if (file) ids.push(...file.nodes.map(n => n.id));
    }
    if (state.situations) {
      ids.push(...state.situations.nodes.map(n => n.id));
    }
    return ids;
  },

  getAllConflictIds: () => {
    return get().conflicts.map(c => c.claim_id);
  },

  getLabelForId: (id: string) => {
    const state = get();
    if (id.startsWith('pol-')) {
      const pol = state.policyRegistry?.find(p => p.id === id);
      return pol?.action || '';
    }
    if (nodeTypeFromId(id) === 'situation') {
      const node = state.situations?.nodes.find(n => n.id === id);
      return node?.label || '';
    }
    if (id.startsWith('conflict-')) {
      const conflict = state.conflicts.find(c => c.claim_id === id);
      return conflict?.claim_label || '';
    }
    for (const pov of POV_KEYS) {
      const file = state[pov];
      if (file) {
        const node = file.nodes.find(n => n.id === id);
        if (node) return node.label;
      }
    }
    return '';
  },

  getDescriptionForId: (id: string) => {
    const state = get();
    if (id.startsWith('pol-')) {
      const pol = state.policyRegistry?.find(p => p.id === id);
      return pol?.description || '';
    }
    if (nodeTypeFromId(id) === 'situation') {
      const node = state.situations?.nodes.find(n => n.id === id);
      return node?.description || '';
    }
    for (const pov of POV_KEYS) {
      const file = state[pov];
      if (file) {
        const node = file.nodes.find(n => n.id === id);
        if (node) return node.description;
      }
    }
    return '';
  },

  lookupPinnedData: (id: string): PinnedData | null => {
    const state = get();
    if (nodeTypeFromId(id) === 'situation') {
      const node = state.situations?.nodes.find(n => n.id === id);
      if (node) return { type: 'situations', node: structuredClone(node) };
      return null;
    }
    if (id.startsWith('conflict-')) {
      const conflict = state.conflicts.find(c => c.claim_id === id);
      if (conflict) return { type: 'conflict', conflict: structuredClone(conflict) };
      return null;
    }
    // t/3401: pol-* ids live in policy_actions.json (policyRegistry), not the Perspective files —
    // the popup previously fell through every branch to "Node not found." Reuses the already-loaded
    // registry (same source getLabelForId/getDescriptionForId already dispatch on, above).
    if (id.startsWith('pol-')) {
      const policy = state.policyRegistry?.find(p => p.id === id);
      if (!policy) return null;
      const referencingNodes: PolicyReferencingNode[] = [];
      for (const pov of POV_KEYS) {
        const file = state[pov];
        if (!file?.nodes) continue;
        for (const n of file.nodes) {
          const match = n.graph_attributes?.policy_actions?.find(p => p.policy_id === id);
          if (match) referencingNodes.push({ id: n.id, label: n.label, pov, action: match.action, framing: match.framing });
        }
      }
      return { type: 'policy', policy: structuredClone(policy), referencingNodes: structuredClone(referencingNodes) };
    }
    for (const pov of POV_KEYS) {
      const file = state[pov];
      if (file) {
        const node = file.nodes.find(n => n.id === id);
        if (node) return { type: 'pov', pov, node: structuredClone(node) };
      }
    }
    return null;
  },

  edgesFile: null,
  edgesLoading: false,
  relatedNodeId: null,
  selectedEdge: null,

  loadEdges: async () => {
    if (get().edgesFile) return;
    set({ edgesLoading: true });
    try {
      const raw = await api.loadEdges();
      set({ edgesFile: raw as EdgesFile | null, edgesLoading: false });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'Failed to load edges file', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ edgesLoading: false });
    }
  },

  showRelatedEdges: (nodeId) => {
    set({ relatedNodeId: nodeId, selectedEdge: nodeId ? get().selectedEdge : null, ...(nodeId ? { toolbarPanel: 'related' as const } : { toolbarPanel: null }) });
    if (nodeId && !get().edgesFile) {
      void get().loadEdges();
    }
  },

  selectEdge: (edge) => set({ selectedEdge: edge }),

  toolbarPanel: null,
  setToolbarPanel: (panel) => {
    const state = get();
    set({ toolbarPanel: panel, previousView: { panel: state.toolbarPanel, nodeId: state.selectedNodeId } });
    getGlobalRecorder()?.record({ type: 'ui.toggle', component: 'toolbar', level: 'info', message: 'toolbar.panel', data: { panel, prev: state.toolbarPanel } });
  },
  pendingLineageValue: null,
  navigateToLineage: (value) => {
    const state = get();
    set({
      toolbarPanel: 'lineage',
      pendingLineageValue: value,
      previousView: { panel: state.toolbarPanel, nodeId: state.selectedNodeId },
    });
  },
  pendingSearchRelatedId: null,
  navigateToSearchRelated: (nodeId) => {
    const state = get();
    set({
      toolbarPanel: 'search',
      pendingSearchRelatedId: nodeId,
      previousView: { panel: state.toolbarPanel, nodeId: state.selectedNodeId },
    });
  },
  previousView: null,
  navigateBack: () => {
    const prev = get().previousView;
    if (!prev) {
      set({ toolbarPanel: null, previousView: null });
      return;
    }
    set({
      toolbarPanel: prev.panel,
      previousView: null,
      ...(prev.nodeId ? { selectedNodeId: prev.nodeId } : {}),
    });
  },

  cruxDetailId: null,
  showCruxDetail: (id) => set({ cruxDetailId: id }),
});
