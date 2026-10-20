// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Taxonomy graph data handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// Taxonomy files, policy/lineage/conflict/crux reads, dictionary, proposals,
// source-index builders, edges, and synthetic corpus/embeddings. Behavior is
// unchanged — handler bodies are moved verbatim behind the same channel names.

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readTaxonomyFile,
  writeTaxonomyFile,
  readAllConflictFiles,
  readConflictClusters,
  writeConflictFile,
  createConflictFile,
  deleteConflictFile,
  readEdgesFile,
  writeEdgesFile,
  getTaxonomyDirs,
  getActiveTaxonomyDirName,
  setActiveTaxonomyDir,
  buildNodeSourceIndex,
  buildPolicySourceIndex,
  getNodeSources,
  readPolicyRegistry,
  acquirePolicyRegistryLock,
  releasePolicyRegistryLock,
  writePolicyRegistryRaw,
  readPovTagProposals,
  writePovTagProposals,
  readAggregatedCruxes,
  readLineageCategories,
  readLineageEnrichments,
  loadSyntheticCorpus,
  loadSyntheticEmbeddings,
  updateSyntheticEmbeddings,
  getDataRootPath,
  loadDataConfig,
} from '../fileIO.js';
import { parsePovTagProposals, applyProposalDecision, type ProposalDecision, type ProposalStatus } from '../../../../lib/schema/povTagProposals.js';
import { ActionableError, errorMessage } from '../../../../lib/debate/errors.js';
import { findSituationBdiViolations, validateBdiFields, type SituationNode } from '../../../../lib/debate/taxonomyTypes.js';
import { mergeEdgesPreservingRationale, ABSENT_BASELINE, type EdgesData, type EdgeMergeWarn } from '../../../../lib/edges/mergeEdgesPreservingRationale.js';
import { renameSyncWithRetry } from '../../../../lib/debate/persistence.js';
import { recordLockHolder } from '../../../../lib/debate/lockHolder.js';
import { stampNodeAuthorship } from '../../server/storage/editMeta.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { VALID_POV, NodeDeleteLogEntrySchema } from '../ipcSchemas.js';
import {
  assembleNodeEmbeddings,
  selectRelevantTaxonomy,
  type ANClaimInput,
  type SelectRelevantTaxonomyInput,
} from '../../../../lib/debate/relevanceSelection.js';
import { getPovDoctrinalBoundaries } from '../../../../lib/debate/poverInfo.js';
import { resolvePoverInfo } from '../../../../lib/debate/soulDocLoader.js';
import type { TagSelection } from '../../../../lib/debate/types/session.js';
import type { SpeakerId } from '../../../../lib/debate/types/phase.js';
import { computeEmbeddings, computeQueryEmbedding } from '../embeddings.js';
import { computeClaimTaxonomyAttribution } from '../../../../lib/debate/argumentNetwork/attribution.js';
import type { ArgumentNetworkNode, ClaimTaxonomyAttribution } from '../../../../lib/debate/types.js';
import { writeNodeDeleteLogEntry } from '../nodeDeleteLog.js';
import {
  recountPolicyMembers,
  serializePolicyRegistry,
  type PolicyRegistry,
  type PolicyPovFile,
  type PolicyPovFileData,
  type PolicyPovFiles,
  type RecountPolicyMembersResult,
} from '../../../../lib/policy/registryRecount.js';

// Recorder-backed sink for the rationale re-merge's "baseline twin matched no incoming edge"
// case: a real rationale isn't written, logged so a systematic tie-break mismatch is
// discoverable (CL Issue 4). Payload is IDs/counts only — no rationale content is recorded.
const onEdgeMergeWarn: EdgeMergeWarn = (e) =>
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'ipc-save-edges', level: 'warn',
    message: `${e.message} ${JSON.stringify(e.data)}`,
  });

/**
 * Read the on-disk nodes for `pov` before a save — the one read shared by authorship
 * diffing (stampSaveNodes, below) and the situations BDI save-gate (t/3891). Classifies the
 * outcome rather than reacting to it: each caller decides how a missing vs. unreadable
 * baseline should behave, because they have different risk profiles (losing edit-history
 * attribution is low-stakes; silently accepting a non-BDI situation write is not).
 */
function readOldNodesForDiff(pov: string): { status: 'ok'; nodes: unknown[] } | { status: 'missing' } | { status: 'corrupt'; err: unknown } {
  try {
    const existing = readTaxonomyFile(pov);
    // Existing file may also be either shape — extract nodes from either.
    const nodes = Array.isArray(existing)
      ? existing
      : ((existing as { nodes?: unknown[] })?.nodes ?? []);
    return { status: 'ok', nodes };
  } catch (err) {
    // ENOENT (missing file, first write) is not logged — it's the normal, benign case, not a
    // degraded fallback. Anything else is a genuine read/parse failure; record it here (ADR-003
    // requires the record() call stay literally in the catch) so both callers' reactions to
    // 'corrupt' are covered by one entry, not a duplicate per caller.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing' };
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'ipc-save-taxonomy',
      level: 'warn',
      message: `Could not read existing ${pov} taxonomy file for save-time diffing`,
      error: { name: (err as Error)?.name ?? 'Error', message: errorMessage(err), stack: (err as Error)?.stack },
    });
    return { status: 'corrupt', err };
  }
}

/**
 * Stamp _edit_meta / _edit_history authorship onto a save's nodes (mirroring the server's
 * PUT /api/taxonomy/:pov), preserving on-disk metadata for nodes this save did NOT change
 * (t/828) and recording the save.stamp observability event. Returns the stamped node list.
 * Extracted verbatim from the save-taxonomy-file handler (t/1914 complexity split).
 */
function stampSaveNodes(pov: string, newNodes: unknown[]): unknown[] {
  // readOldNodesForDiff already records a WARN for a genuine read failure ('corrupt'); here we
  // just fall back to an empty baseline so the edit-history stamp is never what blocks the edit
  // (unlike the BDI gate below, losing authorship attribution is recoverable; the data itself
  // isn't at risk).
  const diff = readOldNodesForDiff(pov);
  const oldNodes: unknown[] = diff.status === 'ok' ? diff.nodes : [];
  const stamped = stampNodeAuthorship(
    oldNodes as Parameters<typeof stampNodeAuthorship>[0],
    newNodes as Parameters<typeof stampNodeAuthorship>[1],
  );
  // Preserve on-disk authorship metadata for nodes this save did NOT change (t/828):
  // stampNodeAuthorship only (re)writes _edit_meta/_edit_history for added/modified nodes;
  // unchanged nodes come back verbatim from the payload, which on a desktop re-save lacks
  // the history already on disk — without this the 2nd+ save strips it.
  type NodeMeta = { id: string; _edit_meta?: unknown; _edit_history?: unknown };
  const oldById = new Map((oldNodes as NodeMeta[]).map((n) => [n.id, n]));
  let stampedCount = 0;
  let preservedCount = 0;
  for (const node of stamped as NodeMeta[]) {
    if (node._edit_meta !== undefined) stampedCount++; // stamp wrote metadata (added/modified node)
    const old = oldById.get(node.id);
    if (!old) continue;
    if (node._edit_meta === undefined && old._edit_meta !== undefined) { node._edit_meta = old._edit_meta; preservedCount++; }
    if (node._edit_history === undefined && old._edit_history !== undefined) node._edit_history = old._edit_history;
  }
  // Observability (t/828): one event per save so a future history-strip is immediately
  // visible from a flight-recorder dump.
  getGlobalRecorder()?.record({
    type: 'state.change',
    component: 'ipc-save-taxonomy',
    level: 'info',
    message: 'save.stamp',
    data: {
      pov,
      total: stamped.length,
      stampedCount,
      unchangedCount: stamped.length - stampedCount,
      preservedCount,
    },
  });
  return stamped;
}

// ── Situations BDI save-gate (t/3891, boundary guard for t/3888 — recurrence #5 class) ──
//
// The rule itself lives in ONE place — findSituationBdiViolations/validateBdiFields in
// lib/debate/taxonomyTypes.ts (t/3889), pinned to the PowerShell classifier
// Test-SituationBdiDecomposition by a parity test. This section only decides WHICH situations
// to check (changed-only, SO e/244#2 Q1) and formats the refusal — mirrors the renderer's
// utils/situationBdiGate.ts (t/3888) for the same reasoning, duplicated per-writer by design
// (route table, t/3888#5): the diffing wrapper is per-host, the rule is not.

/** Order-independent key of a node's interpretations — the deep compare behind changed-only.
 *  Mirrors renderer utils/situationBdiGate.ts's interpretationsKey exactly. */
function interpretationsKey(interpretations: unknown): string {
  return JSON.stringify(interpretations, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
    }
    return value;
  });
}

/** Situations whose interpretations changed vs `baseline`. A node absent from the baseline
 *  (new, or renamed) counts as changed (SO Q1 condition 2). Other field edits don't count —
 *  "changed" is defined over `interpretations` only (SO Q1 condition 1). */
function changedSituations(nodes: SituationNode[], baseline: Record<string, string>): SituationNode[] {
  return nodes.filter(n => baseline[n.id] !== interpretationsKey(n.interpretations));
}

/** Every failing B/D/I field of one interpretation, found by probing the shared rule one field
 *  at a time — so the error can name all of them without re-encoding the rule itself. */
function failingBdiFields(interp: unknown): string[] {
  if (typeof interp !== 'object' || interp === null) return ['belief', 'desire', 'intention'];
  const obj = interp as Record<string, unknown>;
  const valid = { belief: 'ok', desire: 'ok', intention: 'ok' };
  return (['belief', 'desire', 'intention'] as const).filter(f => validateBdiFields({ ...valid, [f]: obj[f] }) !== null);
}

/**
 * Refuse a situations save that writes a non-BDI-compliant interpretation on a CHANGED node.
 * Fail-closed per TL/SO (t/3888#2, t/3888#4): a missing baseline (ENOENT — first write) means
 * every node is new, so validate all of them and let the save proceed if they're compliant; an
 * UNREADABLE baseline (corrupt file, permission error, anything else) refuses the save outright
 * rather than silently treating "couldn't diff" as "nothing changed." Writes nothing on refusal.
 */
function guardSituationsBdiSave(newNodes: unknown[]): void {
  const diff = readOldNodesForDiff('situations');
  if (diff.status === 'corrupt') {
    throw new ActionableError({
      goal: 'Save the situations taxonomy file',
      problem: `Could not read the existing situations file to determine which situations changed: ${errorMessage(diff.err)}`,
      location: 'ipc/taxonomyHandlers.ts → save-taxonomy-file (situations BDI gate)',
      nextSteps: [
        'Inspect situations.json (or cross-cutting.json) for corruption',
        'Restore the file from backup or git history',
        'Retry the save once the existing file is readable',
      ],
      innerError: diff.err,
    });
  }
  const oldNodes = (diff.status === 'ok' ? diff.nodes : []) as SituationNode[];
  const baseline = Object.fromEntries(oldNodes.map(n => [n.id, interpretationsKey(n.interpretations)]));
  const changed = changedSituations(newNodes as SituationNode[], baseline);
  const violations = findSituationBdiViolations(changed);
  if (violations.length === 0) return;

  const byId = new Map((newNodes as SituationNode[]).map(n => [n.id, n]));
  const lines = violations.map(v => {
    const node = byId.get(v.id);
    const fields = failingBdiFields(node?.interpretations[v.pov as keyof SituationNode['interpretations']]);
    const problem = fields.length > 0
      ? `${fields.join(', ')} ${fields.length === 1 ? 'is' : 'are'} empty or a placeholder (N/A, TBD, none…)`
      : 'is not broken into belief, desire and intention';
    return `${v.id} "${node?.label || '(no label)'}" — ${v.pov}: ${problem}`;
  });

  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'ipc-save-taxonomy',
    level: 'warn',
    message: 'save-taxonomy-file (situations): refused — non-BDI interpretation on a changed node',
    data: { violations },
  });

  throw new ActionableError({
    goal: 'Save the situations taxonomy file',
    problem: `${violations.length} changed interpretation${violations.length === 1 ? '' : 's'} aren't fully broken into belief, desire and intention:\n`
      + lines.map(l => `• ${l}`).join('\n'),
    location: 'ipc/taxonomyHandlers.ts → save-taxonomy-file (situations BDI gate)',
    nextSteps: ['Complete the listed belief/desire/intention fields, or delete the situation', 'Retry the save'],
  });
}

export function registerTaxonomyHandlers(): void {
  ipcMain.handle('get-taxonomy-dirs', () => {
    return getTaxonomyDirs();
  });

  ipcMain.handle('get-active-taxonomy-dir', () => {
    return getActiveTaxonomyDirName();
  });

  ipcMain.handle('set-taxonomy-dir', (_event, dirName: string) => {
    setActiveTaxonomyDir(dirName);
  });

  ipcMain.handle('load-taxonomy-file', (_event, pov: string) => {
    return readTaxonomyFile(pov);
  });

  ipcMain.handle('save-taxonomy-file', (event, pov: string, data: unknown) => {
    const parsed = VALID_POV.safeParse(pov);
    if (!parsed.success) throw new ActionableError({ goal: 'Save taxonomy file', problem: `Invalid POV: ${pov}`, location: 'ipcHandlers:save-taxonomy-file', nextSteps: ['Use a valid POV name'] });
    // Stamp _edit_meta / _edit_history before writing so desktop edits record
    // authorship just like the web server's PUT /api/taxonomy/:pov handler.
    // The renderer may send either { nodes: [...] } or a bare nodes array — handle both.
    const incoming = data as { nodes?: unknown[] };
    const newNodes: unknown[] | null = Array.isArray(incoming.nodes)
      ? incoming.nodes
      : Array.isArray(data) ? (data as unknown[]) : null;
    // t/3891: boundary guard for recurrence #5 (t/3888) — refuse a non-BDI situation
    // interpretation on a changed node before anything is written. Writes nothing on refusal.
    if (parsed.data === 'situations' && newNodes) guardSituationsBdiSave(newNodes);
    let toWrite: unknown = data;
    if (newNodes) {
      const stamped = stampSaveNodes(parsed.data, newNodes);
      if (Array.isArray(incoming.nodes)) {
        incoming.nodes = stamped;       // object form: mutate nodes in place, write the wrapper
      } else {
        toWrite = stamped;              // bare-array form: write the stamped array directly
      }
    }
    writeTaxonomyFile(parsed.data, toWrite);
    // Notify all other windows to reload taxonomy data
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== event.sender) {
        win.webContents.send('reload-taxonomy');
      }
    }
  });

  ipcMain.handle('load-policy-registry', () => {
    return readPolicyRegistry();
  });

  // t/4052/t/4054: review queue for pov-tag-proposals.json. Returns the FILE itself (or null when
  // absent) — never parsePovTagProposals's { ok, file } wrapper (Rosetta Stone, p/546#62). A parse
  // failure is a genuine error (the file exists and is broken), so it throws rather than returning
  // null, which is reserved for "no file yet".
  ipcMain.handle('load-pov-tag-proposals', () => {
    const raw = readPovTagProposals();
    if (raw === null) return null;
    const parsed = parsePovTagProposals(raw);
    if (!parsed.ok) {
      throw new ActionableError({
        goal: 'Load the POV-tag proposal review queue',
        problem: `pov-tag-proposals.json is malformed: ${parsed.problems.join('; ')}`,
        location: 'ipc/taxonomyHandlers.ts → load-pov-tag-proposals',
        nextSteps: ['Inspect pov-tag-proposals.json for corruption', 'Restore the file from git history'],
      });
    }
    return parsed.file;
  });

  // Review one decision. A refusal (conflict/invalid) is returned as a VALUE — never thrown — per
  // the p/546#62 contract; nothing is written on refusal. reviewedBy is the local desktop user
  // (os.userInfo, mirrors nodeDeleteLog.ts's local-identity fallback) — there is no server-side
  // authenticated identity on Electron.
  ipcMain.handle('review-pov-tag-proposal', (_event, nodeId: string, decision: ProposalDecision, expectedStatus: ProposalStatus) => {
    const raw = readPovTagProposals();
    if (raw === null) {
      throw new ActionableError({
        goal: 'Review a POV-tag proposal',
        problem: 'pov-tag-proposals.json does not exist — there is nothing to review',
        location: 'ipc/taxonomyHandlers.ts → review-pov-tag-proposal',
        nextSteps: ['Run the proposal-generation step (t/3962) before opening the review queue'],
      });
    }
    const parsed = parsePovTagProposals(raw);
    if (!parsed.ok) {
      throw new ActionableError({
        goal: 'Review a POV-tag proposal',
        problem: `pov-tag-proposals.json is malformed: ${parsed.problems.join('; ')}`,
        location: 'ipc/taxonomyHandlers.ts → review-pov-tag-proposal',
        nextSteps: ['Inspect pov-tag-proposals.json for corruption', 'Restore the file from git history'],
      });
    }
    const reviewedBy = os.userInfo().username;
    const reviewedAt = new Date().toISOString();
    const result = applyProposalDecision(parsed.file, nodeId, decision, reviewedBy, reviewedAt, expectedStatus);
    if ('refused' in result) return result;
    writePovTagProposals(result.file);
    return result;
  });

  // t/4034/t/4038: recount member_count/source_povs for the given policy ids after an editor
  // edit adds/removes a node's policy action from the registry picker (t/4034 description).
  // PI ruling e/264#29 (option a): the editor's recount never refuses on an uncommitted registry
  // — only the lock can refuse. Flow (t/4038#4, minus the dropped dirty-tree step): acquire
  // policy_actions.lock -> read registry + 4 POV files -> recountPolicyMembers -> `unchanged`
  // before any write -> write via the one serializer -> release the lock in `finally`.
  ipcMain.handle('recount-policy-members', async (_event, ids: string[]): Promise<RecountPolicyMembersResult> => {
    const handle = await acquirePolicyRegistryLock();
    if (!handle) {
      return { status: 'refused', reason: 'locked', updated: [] };
    }
    try {
      const rawRegistry = readPolicyRegistry();
      if (rawRegistry === null) {
        throw new ActionableError({
          goal: 'Recount policy registry member counts',
          problem: 'policy_actions.json does not exist — there is nothing to recount',
          location: 'ipc/taxonomyHandlers.ts → recount-policy-members',
          nextSteps: ['Create policy_actions.json before adding policy actions to a node'],
        });
      }
      // All four files, read in order; the PolicyPovFiles type makes a missing key a compile error (t/4034, #3050).
      const read = (pov: PolicyPovFile): PolicyPovFileData => readTaxonomyFile(pov) as PolicyPovFileData;
      const povFiles: PolicyPovFiles = {
        accelerationist: read('accelerationist'),
        safetyist: read('safetyist'),
        skeptic: read('skeptic'),
        situations: read('situations'),
      };
      const { registry, updated, changed } = recountPolicyMembers(rawRegistry as PolicyRegistry, povFiles, ids);
      if (!changed) {
        return { status: 'unchanged', updated: [] };
      }
      writePolicyRegistryRaw(serializePolicyRegistry(registry));
      return { status: 'written', updated };
    } finally {
      releasePolicyRegistryLock(handle);
    }
  });

  ipcMain.handle('load-lineage-categories', () => {
    return readLineageCategories();
  });

  ipcMain.handle('load-lineage-info', () => {
    return readLineageEnrichments();
  });

  ipcMain.handle('load-conflict-files', () => {
    return readAllConflictFiles();
  });

  ipcMain.handle('load-conflict-clusters', () => {
    return readConflictClusters();
  });

  ipcMain.handle('load-aggregated-cruxes', () => {
    return readAggregatedCruxes();
  });

  // Dictionary
  ipcMain.handle('load-dictionary', () => {
    try {
      const dictDir = path.join(getDataRootPath(), 'dictionary');
      const stdDir = path.join(dictDir, 'standardized');
      const colDir = path.join(dictDir, 'colloquial');

      // t/3290 (mirrors the server-side t/3289 WARN): a missing/empty standardized dir silently
      // blanked the Vocabulary panel with no signal. Emit a WARN recording the discriminating cause
      // (dir-missing vs empty-listing) + the RESOLVED data root, so "which root did getDataRootPath()
      // resolve to?" is answerable (the suspected Electron root cause — env not inherited at GUI launch).
      const standardized: unknown[] = [];
      if (!fs.existsSync(stdDir)) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ipc-handlers', level: 'warn',
          message: 'load-dictionary: standardized dir missing — returning empty (t/3290)',
          data: { dir: stdDir, cause: 'dir-missing', dataRoot: getDataRootPath() },
        });
      } else {
        const stdJson = fs.readdirSync(stdDir).filter(f => f.endsWith('.json'));
        if (stdJson.length === 0) {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'ipc-handlers', level: 'warn',
            message: 'load-dictionary: standardized dir present but zero .json files (empty-listing) — returning empty (t/3290)',
            data: { dir: stdDir, cause: 'empty-listing' },
          });
        }
        for (const f of stdJson) {
          try {
            standardized.push(JSON.parse(fs.readFileSync(path.join(stdDir, f), 'utf-8')));
          } catch { /* telemetry — silent by design;  skip malformed */ }
        }
      }

      const colloquial: unknown[] = [];
      if (!fs.existsSync(colDir)) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ipc-handlers', level: 'warn',
          message: 'load-dictionary: colloquial dir missing — returning empty (t/3290)',
          data: { dir: colDir, cause: 'dir-missing', dataRoot: getDataRootPath() },
        });
      } else {
        for (const f of fs.readdirSync(colDir).filter(f => f.endsWith('.json'))) {
          try {
            colloquial.push(JSON.parse(fs.readFileSync(path.join(colDir, f), 'utf-8')));
          } catch { /* telemetry — silent by design;  skip malformed */ }
        }
      }

      return { standardized, colloquial, lintViolations: [] };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'get-conflict-definitions: failed to load conflict definition files — returning empty lists',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { standardized: [], colloquial: [], lintViolations: [] };
    }
  });

  ipcMain.handle('save-conflict-file', (_event, claimId: string, data: unknown) => {
    writeConflictFile(claimId, data);
  });

  ipcMain.handle('create-conflict-file', (_event, claimId: string, data: unknown) => {
    createConflictFile(claimId, data);
  });

  ipcMain.handle('delete-conflict-file', (_event, claimId: string) => {
    deleteConflictFile(claimId);
  });

  // Taxonomy proposal files (for batch approve UI)
  ipcMain.handle('list-proposals', () => {
    const proposalDir = path.join(getDataRootPath(), loadDataConfig().taxonomy_dir, 'proposals');
    if (!fs.existsSync(proposalDir)) return [];
    return fs.readdirSync(proposalDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(proposalDir, f), 'utf-8'));
          return { filename: f, ...data };
        } catch (err) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'ipc-handlers',
            level: 'warn',
            message: `list-proposals: failed to parse proposal file ${f} — returning error entry`,
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          });
          return { filename: f, error: 'Failed to parse' };
        }
      });
  });

  ipcMain.handle('save-proposal', (_event, filename: string, data: unknown) => {
    const proposalDir = path.join(getDataRootPath(), loadDataConfig().taxonomy_dir, 'proposals');
    if (!fs.existsSync(proposalDir)) fs.mkdirSync(proposalDir, { recursive: true });
    if (!/^proposal-[\d-]+\.json$/.test(filename)) {
      return { error: 'Invalid proposal filename' };
    }
    const filePath = path.join(proposalDir, filename);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSyncWithRetry(tmpPath, filePath, 7, undefined, recordLockHolder);
    return { saved: true };
  });

  ipcMain.handle('build-node-source-index', () => {
    return buildNodeSourceIndex();
  });

  ipcMain.handle('build-policy-source-index', () => {
    return buildPolicySourceIndex();
  });

  // t/4342 — Electron leg of the per-node source-index transport trio (t/4335).
  // Matches the server's GET /api/node-source-index/:nodeId (ServerAPI, PR #3512).
  ipcMain.handle('get-node-sources', (_event, nodeId: string) => {
    return getNodeSources(nodeId);
  });

  ipcMain.handle('load-edges', () => {
    // t/2949 defense-in-depth: return the FULL edges (rationale included) so the renderer's
    // in-memory set is COMPLETE — a whole-file save physically cannot drop what it never lost.
    // (The write-side re-merge in save-edges stays the primary, durable guard.) The former inline
    // rationale-strip here was a DUPLICATE of the server's stripEdgeRationale (the t/2945
    // duplication hazard); removing it leaves the single shared strip (lib/edges) for the server
    // list endpoint only. Mirrors the web bridge's `?include=rationale` load (web-bridge.ts:775).
    return readEdgesFile();
  });

  ipcMain.handle('load-edge-detail', (_event, index: number) => {
    const data = readEdgesFile() as { edges: Record<string, unknown>[] } | null;
    if (!data?.edges) throw new ActionableError({
      goal: 'Load edge detail with rationale',
      problem: 'No edges.json found in the active taxonomy directory',
      location: 'ipcHandlers.loadEdgeDetail',
      nextSteps: [
        'Verify the data directory is configured correctly (Settings > Data Root)',
        'Check that edges.json exists in the active taxonomy directory',
      ],
    });
    if (index < 0 || index >= data.edges.length) throw new ActionableError({
      goal: 'Load edge detail with rationale',
      problem: `Edge index ${index} is out of range (0..${data.edges.length - 1})`,
      location: 'ipcHandlers.loadEdgeDetail',
      nextSteps: ['Reload the edges list to get current indices'],
    });
    return data.edges[index];
  });

  ipcMain.handle('update-edge-status', (_event, index: number, status: string) => {
    const data = readEdgesFile() as Record<string, unknown>;
    if (!data) throw new ActionableError({
      goal: 'Update the status of a taxonomy edge',
      problem: 'No edges.json found in the active taxonomy directory',
      location: 'ipcHandlers.updateEdgeStatus',
      nextSteps: [
        'Verify the data directory is configured correctly (Settings > Data Root)',
        'Check that edges.json exists in the active taxonomy directory',
      ],
    });
    const edges = data['edges'] as Record<string, unknown>[];
    if (index < 0 || index >= edges.length) throw new ActionableError({
      goal: 'Update the status of a taxonomy edge',
      problem: `Edge index ${index} is out of range (0..${edges.length - 1})`,
      location: 'ipcHandlers.updateEdgeStatus',
      nextSteps: [
        'Reload the edges list to get the current indices',
        'This may indicate a stale UI — try refreshing the page',
      ],
    });
    edges[index]['status'] = status;
    if (status === 'approved') {
      delete edges[index]['direction_flag'];
    }
    writeEdgesFile(data);
    return { index, status };
  });

  ipcMain.handle('swap-edge-direction', (_event, index: number) => {
    const data = readEdgesFile() as Record<string, unknown>;
    if (!data) throw new ActionableError({
      goal: 'Swap the direction of a taxonomy edge',
      problem: 'No edges.json found in the active taxonomy directory',
      location: 'ipcHandlers.swapEdgeDirection',
      nextSteps: [
        'Verify the data directory is configured correctly (Settings > Data Root)',
        'Check that edges.json exists in the active taxonomy directory',
      ],
    });
    const edges = data['edges'] as Record<string, unknown>[];
    if (index < 0 || index >= edges.length) throw new ActionableError({
      goal: 'Swap the direction of a taxonomy edge',
      problem: `Edge index ${index} is out of range (0..${edges.length - 1})`,
      location: 'ipcHandlers.swapEdgeDirection',
      nextSteps: [
        'Reload the edges list to get the current indices',
        'This may indicate a stale UI — try refreshing the page',
      ],
    });
    const edge = edges[index];
    const tmp = edge['source'];
    edge['source'] = edge['target'];
    edge['target'] = tmp;
    delete edge['direction_flag'];
    writeEdgesFile(data);
    return { index, source: edge['source'], target: edge['target'] };
  });

  ipcMain.handle('bulk-update-edges', (_event, indices: number[], status: string) => {
    const data = readEdgesFile() as Record<string, unknown>;
    if (!data) throw new ActionableError({
      goal: 'Bulk-update the status of taxonomy edges',
      problem: 'No edges.json found in the active taxonomy directory',
      location: 'ipcHandlers.bulkUpdateEdges',
      nextSteps: [
        'Verify the data directory is configured correctly (Settings > Data Root)',
        'Check that edges.json exists in the active taxonomy directory',
      ],
    });
    const edges = data['edges'] as Record<string, unknown>[];
    let updated = 0;
    for (const idx of indices) {
      if (idx >= 0 && idx < edges.length) {
        edges[idx]['status'] = status;
        updated++;
      }
    }
    writeEdgesFile(data);
    return { updated, status };
  });

  // Whole-file edge persistence for the new-edge path (t/1816/t/1822). Unlike the
  // index-based update/swap/bulk handlers above, this WRITES the entire EdgesFile,
  // so it CREATES edges.json when absent (persisting the very first edge) rather
  // than preconditioning on an existing file — requiring one would defeat the
  // new-edge purpose. It guards the incoming BODY SHAPE instead: a non-{edges:[...]}
  // payload is rejected rather than written over edges.json, mirroring the server
  // transport's PUT /api/edges 400 body guard (t/1821) so desktop and web behave
  // identically. writeEdgesFile is atomic (temp→rename).
  ipcMain.handle('save-edges', (_event, data: unknown) => {
    if (!data || typeof data !== 'object' || !Array.isArray((data as { edges?: unknown }).edges)) {
      // Client bug (400-equivalent) — thrown before the recording catch, so a bad
      // payload doesn't flood the flight recorder (mirrors the server's 400 path).
      throw new ActionableError({
        goal: 'Persist the taxonomy edges to disk',
        problem: 'save-edges received a payload that is not a valid EdgesFile (missing an `edges` array)',
        location: 'ipcHandlers.saveEdges',
        nextSteps: [
          'Send the whole edges file as { edges: [...] }',
          'This is a renderer bug — the bridge should pass a valid EdgesFile',
        ],
      });
    }
    try {
      // t/2957: the editor loads the edge list rationale-stripped, then saves the WHOLE file —
      // persisting the stripped set would wipe on-disk rationale. Re-merge it from the on-disk
      // baseline first. `readEdgesFile` returns null ONLY for a genuinely absent edges.json
      // (existsSync guard) and THROWS (via parseJsonFile / readFileSync) on a corrupt or
      // unreadable file — so `== null` is a true first-write (write as-is), never a masked
      // read failure. A read/parse throw or an indistinguishable-twin refusal propagates below.
      const raw = readEdgesFile();
      const baseline = raw == null ? ABSENT_BASELINE : (raw as EdgesData);
      const merged = mergeEdgesPreservingRationale(data as EdgesData, baseline, onEdgeMergeWarn);
      writeEdgesFile(merged);
    } catch (err) {
      // A merge refusal (unreadable baseline / indistinguishable twins) is already an
      // ActionableError with the precise Goal/Problem/Location/NextSteps — surface it verbatim,
      // and do NOT record it as a persist-FAILURE: it is a deliberate, self-describing refusal, not
      // a write error (the no-match tie-break case is already logged via onEdgeMergeWarn). Only a
      // raw fs error is a genuine persist failure worth the error record + generic wrap.
      if (err instanceof ActionableError) throw err;
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-save-edges',
        level: 'error',
        message: 'Failed to persist edges.json (rationale-preserving save)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: 'Persist the taxonomy edges to disk',
        problem: 'Could not write edges.json to the active taxonomy directory',
        location: 'ipcHandlers.saveEdges',
        nextSteps: [
          'Verify the data directory is configured correctly (Settings > Data Root)',
          'Check that edges.json is not locked by another process (antivirus/indexer)',
        ],
        innerError: err,
      });
    }
  });

  ipcMain.handle('load-synthetic-corpus', (_event, pov: string) => {
    return loadSyntheticCorpus(pov);
  });

  ipcMain.handle('load-synthetic-embeddings', () => {
    return loadSyntheticEmbeddings();
  });

  ipcMain.handle('update-synthetic-embeddings', (_event, nodeId: string, pov: string, vectors: number[][]) => {
    updateSyntheticEmbeddings(nodeId, pov, vectors);
  });

  // t/3258 (T3): fetch-relevant-nodes — main-process mirror of server routes/relevantNodes.ts.
  // Packaged Electron runs no embedded API server; the renderer reaches relevance selection via IPC.
  // Logic is field-for-field identical to the server route (parity by construction — both invoke
  // the same shared-lib assembleNodeEmbeddings + selectRelevantTaxonomy with ONNX embed cbs).
  ipcMain.handle('fetch-relevant-nodes', async (_event, payload: unknown) => {
    const POV_FILE_KEYS = new Set(['accelerationist', 'safetyist', 'skeptic']);
    const b = (payload ?? {}) as {
      pov: string;
      topic: string;
      recentTranscript: string;
      threshold?: number;
      session?: {
        anClaimEmbeddings?: ANClaimInput[];
        lineageFrame?: { cluster_id: string; label?: string }[];
        sourceType?: string;
        excludeGreatestHits?: boolean;
        greatestHitsList?: string[];
      };
      tagSelection?: TagSelection;
    };
    const { pov, topic, recentTranscript } = b;
    if (!POV_FILE_KEYS.has(pov)) throw new Error(`Invalid or missing pov (expected accelerationist|safetyist|skeptic), got: ${String(pov)}`);
    if (typeof topic !== 'string' || typeof recentTranscript !== 'string') throw new Error('Missing topic/recentTranscript');

    // Corpus embed cb — BATCH, mirrors the client's api.computeEmbeddings (t/3257#22).
    const corpusEmbed = (texts: string[], ids?: string[]): Promise<number[][]> =>
      computeEmbeddings(texts, ids);
    // Boundary + topic-query embed cb — per-text, mirrors the client's api.computeQueryEmbedding.
    const queryEmbed = (texts: string[]): Promise<number[][]> =>
      Promise.all(texts.map(t => computeQueryEmbedding(t)));

    const povFile = readTaxonomyFile(pov) as { nodes?: SelectRelevantTaxonomyInput['povNodes'] };
    const povNodes = povFile?.nodes ?? [];
    const sitFile = readTaxonomyFile('situations') as { nodes?: SelectRelevantTaxonomyInput['situationNodes'] };
    const situationNodes = sitFile?.nodes ?? [];
    const policyRaw = readPolicyRegistry() as { policies?: { id: string; action: string; source_povs?: string[] }[] } | null;
    const policyRegistry = (policyRaw?.policies ?? []).map(p => ({ id: p.id, action: p.action, source_povs: p.source_povs }));
    const lineageRaw = readLineageCategories() as { mapping?: Record<string, { l2: string }> } | null;
    const lineageMapping = lineageRaw?.mapping;
    // t/3977: resolvePoverInfo returns the tag soul WHOLE when a POV tag is selected (it replaces
    // the general soul, not merges into it — t/3957#5 condition A) and falls back to the static
    // POVER_INFO entry when no tag is selected (byte-identical to today). getPovDoctrinalBoundaries
    // maps whichever soul's `boundaries.{hardcoded,softcoded}` shape (t/3966).
    const { soul } = resolvePoverInfo(pov as Exclude<SpeakerId, 'user'>, b.tagSelection);
    const doctrinalBoundaries = getPovDoctrinalBoundaries(soul);

    // Map loadSyntheticEmbeddings() ({pov,vectors}) → {nodeId: vectors[][]} for assembleNodeEmbeddings.
    const synthRaw = loadSyntheticEmbeddings();
    const synth: Record<string, number[][]> | null = synthRaw
      ? Object.fromEntries(Object.entries(synthRaw).map(([id, e]) => [id, e.vectors]))
      : null;

    const { nodeEmbeddings } = await assembleNodeEmbeddings(pov, povNodes, situationNodes, corpusEmbed, synth);

    const session = {
      anClaimEmbeddings: b.session?.anClaimEmbeddings ?? [],
      lineageFrame: b.session?.lineageFrame,
      sourceType: b.session?.sourceType,
      excludeGreatestHits: b.session?.excludeGreatestHits,
      greatestHitsList: b.session?.greatestHitsList,
    };

    return selectRelevantTaxonomy({
      povNodes, situationNodes, policyRegistry, nodeEmbeddings, lineageMapping, doctrinalBoundaries,
      session,
      params: { pov, topic, recentTranscript, threshold: b.threshold, tagSelection: b.tagSelection },
      embed: queryEmbed,
    });
  });

  // t/3322: compute-attribution — main-process mirror of server routes/attribution.ts.
  // Same pure fn (computeClaimTaxonomyAttribution), same ONNX embed cbs, local corpus
  // read (readTaxonomyFile) matching fetch-relevant-nodes — both desktop-local paths stay coherent.
  ipcMain.handle('compute-attribution', async (_event, payload: unknown) => {
    const POV_FILE_KEYS = new Set(['accelerationist', 'safetyist', 'skeptic']);
    interface AttributionClaim {
      id: string;
      embedding?: number[];
      attribution_embedding?: number[];
      claim_taxonomy_attribution?: ClaimTaxonomyAttribution;
    }
    const b = (payload ?? {}) as { pov: string; claims: AttributionClaim[]; topN?: number };
    const { pov } = b;
    if (!POV_FILE_KEYS.has(pov)) throw new Error(`Invalid or missing pov (expected accelerationist|safetyist|skeptic), got: ${String(pov)}`);
    if (!Array.isArray(b.claims)) throw new Error('Missing claims (expected array)');

    const corpusEmbed = (texts: string[], ids?: string[]): Promise<number[][]> =>
      computeEmbeddings(texts, ids);

    const povFile = readTaxonomyFile(pov) as { nodes?: SelectRelevantTaxonomyInput['povNodes'] };
    const povNodes = povFile?.nodes ?? [];
    const sitFile = readTaxonomyFile('situations') as { nodes?: SelectRelevantTaxonomyInput['situationNodes'] };
    const situationNodes = sitFile?.nodes ?? [];
    const synthRaw = loadSyntheticEmbeddings();
    const synth: Record<string, number[][]> | null = synthRaw
      ? Object.fromEntries(Object.entries(synthRaw).map(([id, e]) => [id, e.vectors]))
      : null;

    const { nodeEmbeddings } = await assembleNodeEmbeddings(pov, povNodes, situationNodes, corpusEmbed, synth);
    const candidateNodeIds = new Set(povNodes.map((n: { id: string }) => n.id));

    const claims = b.claims;
    const summary = computeClaimTaxonomyAttribution(
      claims as unknown as ArgumentNetworkNode[],
      pov,
      nodeEmbeddings,
      candidateNodeIds,
      typeof b.topN === 'number' ? b.topN : undefined,
    );

    const attributions: Record<string, ClaimTaxonomyAttribution> = {};
    for (const c of claims) {
      if (c.claim_taxonomy_attribution) attributions[c.id] = c.claim_taxonomy_attribution;
    }

    return {
      attributions,
      summary: {
        attributed: summary.attributed,
        unattributed: summary.unattributed,
        missing_embedding: summary.missing_embedding,
        novel_argument: summary.novel_argument,
        decisions: summary.decisions,
      },
    };
  });

  // t/3859 (Part D of t/3852): durable local audit record for a node deletion — the renderer
  // calls this right after confirm, fail-safe on its side (see electron-bridge.ts's
  // logNodeDeletion wrapper), so a write failure here must never surface as a rejected delete.
  // Validated at the IPC boundary (structural only — see NodeDeleteLogEntrySchema) rather than
  // trusting the renderer-supplied shape; a malformed payload is WARN-recorded and dropped, not
  // written as a corrupt record (this writer has no other caller, so the renderer IS the boundary).
  ipcMain.handle('log-node-deletion', (_event, entry: unknown) => {
    const parsed = NodeDeleteLogEntrySchema.safeParse(entry);
    if (!parsed.success) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'node-delete-log', level: 'warn',
        message: 'log-node-deletion received a malformed entry — dropped, not written',
        data: { error: parsed.error.message },
      });
      return;
    }
    writeNodeDeleteLogEntry(parsed.data);
  });
}
