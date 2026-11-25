// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { TaxonomyStore } from '../types';
import type { PovNode, Pov } from '../../../types/taxonomy';
import { distinctionAnalysisPrompt, nodeCritiquePrompt } from '../../../prompts/analysis';
import type { NodeCritiqueContext } from '../../../prompts/analysis';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { api } from '@bridge';
import { POV_META } from '@lib/electron-shared/povMeta';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

// ── Exported types ──

export interface AnalysisElement {
  label: string;
  description: string;
  category: string;
}

// ── Analysis cache helpers ──

const ANALYSIS_CACHE_KEY = 'taxonomy-editor-analysis-cache';

interface AnalysisCacheEntry {
  elementA: AnalysisElement;
  elementB: AnalysisElement;
  model: string;
  result: string;
}

function buildAnalysisCacheId(
  a: AnalysisElement,
  b: AnalysisElement,
  model: string,
): string {
  return `${a.label}\0${a.description}\0${a.category}\0${b.label}\0${b.description}\0${b.category}\0${model}`;
}

function loadAnalysisCache(): Map<string, AnalysisCacheEntry> {
  try {
    const raw = localStorage.getItem(ANALYSIS_CACHE_KEY);
    if (!raw) return new Map();
    const arr: [string, AnalysisCacheEntry][] = JSON.parse(raw);
    return new Map(arr);
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to load analysis cache from localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return new Map();
  }
}

function saveAnalysisCache(cache: Map<string, AnalysisCacheEntry>): void {
  try {
    const entries = [...cache.entries()];
    const trimmed = entries.slice(-50);
    localStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify(trimmed));
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to save analysis cache to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
}

// ── Slice interface ──

export interface AnalysisSlice {
  analysisResult: string | null;
  analysisLoading: boolean;
  analysisError: string | null;
  analysisStep: number;
  analysisRetry: { attempt: number; maxRetries: number; backoffSeconds: number; limitType: string; limitMessage: string } | null;
  analysisCached: boolean;
  analysisElementA: AnalysisElement | null;
  analysisElementB: AnalysisElement | null;
  runAnalyzeDistinction: (
    elementA: AnalysisElement,
    elementB: AnalysisElement,
    forceRefresh?: boolean,
  ) => Promise<void>;
  clearAnalysis: () => void;
  analysisTitle: string;
  analysisCritiquePov: Pov | null;
  analysisCritiqueNodeId: string | null;
  analysisCritiqueOriginalNode: PovNode | null;
  runNodeCritique: (pov: Pov, node: PovNode) => Promise<void>;

  clusterView: { clusters: { label: string; nodeIds: string[] }[]; misfits?: Set<string> } | null;
  clusterLoading: boolean;
  clusterError: string | null;
  runClusterView: (pov: Pov) => Promise<void>;
  clearClusterView: () => void;

  conflictClusters: { label: string; nodeIds: string[] }[] | null;
  conflictClusterLoading: boolean;
  conflictClusterError: string | null;
  runClusterConflicts: () => Promise<void>;
  clearConflictClusters: () => void;
}

// ── Slice creator ──

export const createAnalysisSlice: StateCreator<TaxonomyStore, [], [], AnalysisSlice> = (set, get) => ({
  analysisResult: null,
  analysisLoading: false,
  analysisError: null,
  analysisStep: 0,
  analysisRetry: null,
  analysisCached: false,
  analysisElementA: null,
  analysisElementB: null,
  analysisTitle: 'Analysis',
  analysisCritiquePov: null,
  analysisCritiqueNodeId: null,
  analysisCritiqueOriginalNode: null,

  clusterView: null,
  clusterLoading: false,
  clusterError: null,
  clearClusterView: () => set({ clusterView: null, clusterError: null }),

  conflictClusters: null,
  conflictClusterLoading: false,
  conflictClusterError: null,
  clearConflictClusters: () => set({ conflictClusters: null, conflictClusterError: null }),

  clearAnalysis: () => set({
    analysisResult: null,
    analysisError: null,
    analysisLoading: false,
    analysisStep: 0,
    analysisRetry: null,
    analysisCached: false,
    analysisElementA: null,
    analysisElementB: null,
    analysisTitle: 'Analysis',
    analysisCritiquePov: null,
    analysisCritiqueNodeId: null,
    analysisCritiqueOriginalNode: null,
  }),

  runAnalyzeDistinction: async (elementA, elementB, forceRefresh) => {
    const model = get().geminiModel;

    if (!forceRefresh) {
      const cache = loadAnalysisCache();
      const cacheId = buildAnalysisCacheId(elementA, elementB, model);
      const cached = cache.get(cacheId);
      if (cached) {
        set({
          analysisResult: cached.result,
          analysisLoading: false,
          analysisError: null,
          analysisStep: 0,
          analysisRetry: null,
          analysisCached: true,
          analysisElementA: elementA,
          analysisElementB: elementB,
        });
        return;
      }
    }

    set({
      analysisLoading: true,
      analysisError: null,
      analysisResult: null,
      analysisStep: 1,
      analysisRetry: null,
      analysisCached: false,
      analysisElementA: elementA,
      analysisElementB: elementB,
    });

    set({ analysisStep: 2 });

    const prompt = distinctionAnalysisPrompt(elementA, elementB);

    const unsubscribe = api.onGenerateTextProgress((progress) => {
      set({ analysisRetry: progress });
    });

    try {
      set({ analysisStep: 3 });
      const { text } = await api.generateText(prompt, model);

      set({ analysisStep: 4, analysisRetry: null });

      const cache = loadAnalysisCache();
      const cacheId = buildAnalysisCacheId(elementA, elementB, model);
      cache.set(cacheId, { elementA, elementB, model, result: text });
      saveAnalysisCache(cache);

      set({ analysisResult: text, analysisLoading: false, analysisStep: 0, analysisCached: false });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'Failed to run distinction analysis', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ analysisLoading: false, analysisError: mapErrorToUserMessage(err, { kind: 'ai' }), analysisStep: 0, analysisRetry: null });
    } finally {
      unsubscribe();
    }
  },

  runNodeCritique: async (pov, node) => {
    const model = get().geminiModel;
    const state = get();
    const POV_LABELS: Record<string, string> = Object.fromEntries(
      Object.entries(POV_META).map(([k, v]) => [k, v.label]),
    );

    set({
      analysisLoading: true,
      analysisError: null,
      analysisResult: null,
      analysisStep: 1,
      analysisRetry: null,
      analysisCached: false,
      analysisElementA: { label: node.label, description: node.description, category: node.category },
      analysisElementB: null,
      analysisTitle: 'AI Analysis',
      analysisCritiquePov: pov,
      analysisCritiqueNodeId: node.id,
      analysisCritiqueOriginalNode: { ...node },
    });

    set({ analysisStep: 2 });

    const nodeId = node.id;
    const neighborIds = new Set<string>();
    neighborIds.add(nodeId);
    if (node.parent_id) neighborIds.add(node.parent_id);
    for (const childId of node.children) neighborIds.add(childId);
    for (const sitRef of node.situation_refs) neighborIds.add(sitRef);

    const relevantEdges = state.edgesFile?.edges.filter(
      e => neighborIds.has(e.source) || neighborIds.has(e.target)
    ) ?? [];
    const edgesJson = relevantEdges.length > 0
      ? JSON.stringify(relevantEdges.map(e => ({
          source: e.source, target: e.target, type: e.type,
          confidence: e.confidence, rationale: e.rationale,
        })), null, 2)
      : '(no edges involving this node)';

    const situationsJson = state.situations
      ? JSON.stringify(state.situations.nodes
          .filter(n => (node.situation_refs ?? []).includes(n.id))
          .map(n => ({
            id: n.id, label: n.label, description: n.description,
          })), null, 2)
      : '(situations not loaded)';

    const povFile = state[pov];
    const hierarchyIds = new Set(neighborIds);
    if (povFile) {
      if (node.parent_id) {
        for (const n of povFile.nodes) {
          if (n.parent_id === node.parent_id) hierarchyIds.add(n.id);
        }
      }
    }
    const povJson = povFile
      ? JSON.stringify(povFile.nodes
          .filter(n => hierarchyIds.has(n.id))
          .map(n => ({
            id: n.id, label: n.label, category: n.category, parent_id: n.parent_id,
          })), null, 2)
      : '(POV file not loaded)';

    const nodePolIds = new Set((node.graph_attributes?.policy_actions ?? []).map(pa => pa.policy_id).filter(Boolean));
    for (const e of relevantEdges) {
      if (e.source.startsWith('pol-')) nodePolIds.add(e.source);
      if (e.target.startsWith('pol-')) nodePolIds.add(e.target);
    }
    const policyRegistryJson = state.policyRegistry
      ? JSON.stringify(state.policyRegistry
          .filter(p => nodePolIds.has(p.id) || nodePolIds.size === 0)
          .map(p => ({
            id: p.id, action: p.action, source_povs: p.source_povs,
          })), null, 2)
      : '(policy registry not loaded)';

    const nodeJson = JSON.stringify(node, null, 2);

    const prompt = nodeCritiquePrompt({
      edgesJson,
      crossCuttingJson: situationsJson,
      povJson,
      nodeJson,
      povName: POV_LABELS[pov] || pov,
      policyRegistryJson,
    });

    const unsubscribe = api.onGenerateTextProgress((progress) => {
      set({ analysisRetry: progress });
    });

    try {
      set({ analysisStep: 3 });
      const { text } = await api.generateText(prompt, model);
      set({ analysisStep: 4, analysisRetry: null });
      set({ analysisResult: text, analysisLoading: false, analysisStep: 0 });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'Failed to run node critique', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ analysisLoading: false, analysisError: mapErrorToUserMessage(err, { kind: 'ai' }), analysisStep: 0, analysisRetry: null });
    } finally {
      unsubscribe();
    }
  },

  runClusterConflicts: async () => {
    const state = get();
    const conflicts = state.conflicts;
    if (!conflicts || conflicts.length === 0) return;

    set({ conflictClusterLoading: true, conflictClusterError: null });

    try {
      let cache = state.embeddingCache;
      if (state.embeddingDirty || cache.size === 0) {
        const { ids, texts } = state.buildEmbeddingTexts(new Set(), new Set());
        if (texts.length === 0) {
          set({ conflictClusterLoading: false, conflictClusterError: 'No embeddings available' });
          return;
        }
        const { vectors } = await api.computeEmbeddings(texts, ids);
        cache = new Map();
        for (let i = 0; i < ids.length; i++) {
          cache.set(ids[i], vectors[i]);
        }
        set({ embeddingCache: cache, embeddingDirty: false });
      }

      const { clusterByEmbedding, buildClusterLabelPrompt } = await import('../../../utils/clustering');

      const nodeIds = conflicts.map(c => c.claim_id);
      const maxClusters = Math.max(8, Math.min(15, Math.ceil(conflicts.length / 50)));
      const rawClusters = clusterByEmbedding(nodeIds, cache, maxClusters, 0.45);

      if (rawClusters.length === 0) {
        set({ conflictClusterLoading: false, conflictClusterError: 'Could not form clusters' });
        return;
      }

      const labelMap = new Map(conflicts.map(c => [c.claim_id, c.claim_label]));
      const multiRawClusters = rawClusters.filter(ids => ids.length > 1);
      const clustersForPrompt = multiRawClusters.map(ids => ({
        nodeIds: ids,
        labels: ids.map(id => labelMap.get(id) || id),
      }));

      let labels: string[];
      if (clustersForPrompt.length > 0) {
        const prompt = buildClusterLabelPrompt(clustersForPrompt);
        const { text } = await api.generateText(prompt);
        try {
          const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
          labels = JSON.parse(cleaned);
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to parse conflict cluster labels from AI response', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
          labels = multiRawClusters.map((_, i) => `Cluster ${i + 1}`);
        }
      } else {
        labels = [];
      }

      const multiClusters: { label: string; nodeIds: string[] }[] = [];
      const singletonIds: string[] = [];
      let multiIdx = 0;

      for (const ids of rawClusters) {
        if (ids.length > 1) {
          multiClusters.push({
            label: labels[multiIdx] || `Cluster ${multiIdx + 1}`,
            nodeIds: ids,
          });
          multiIdx++;
        } else {
          singletonIds.push(...ids);
        }
      }

      multiClusters.sort((a, b) => a.label.localeCompare(b.label));

      for (const cluster of multiClusters) {
        cluster.nodeIds.sort((a, b) => (labelMap.get(a) || '').localeCompare(labelMap.get(b) || ''));
      }

      if (singletonIds.length > 0) {
        singletonIds.sort((a, b) => (labelMap.get(a) || '').localeCompare(labelMap.get(b) || ''));
        multiClusters.push({ label: 'Other', nodeIds: singletonIds });
      }

      set({ conflictClusters: multiClusters, conflictClusterLoading: false });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'Failed to run conflict cluster view', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ conflictClusterLoading: false, conflictClusterError: mapErrorToUserMessage(err, { kind: 'ai' }) });
    }
  },

  runClusterView: async (pov) => {
    const state = get();
    const file = state[pov];
    if (!file) return;

    set({ clusterLoading: true, clusterError: null });

    try {
      let cache = state.embeddingCache;
      if (state.embeddingDirty || cache.size === 0) {
        const { ids, texts } = state.buildEmbeddingTexts(new Set(), new Set());
        if (texts.length === 0) {
          set({ clusterLoading: false, clusterError: 'No embeddings available' });
          return;
        }
        const { vectors } = await api.computeEmbeddings(texts, ids);
        cache = new Map();
        for (let i = 0; i < ids.length; i++) {
          cache.set(ids[i], vectors[i]);
        }
        set({ embeddingCache: cache, embeddingDirty: false });
      }

      const { clusterByEmbedding, buildClusterLabelPrompt } = await import('../../../utils/clustering');

      const nodeIds = file.nodes.map(n => n.id);
      const rawClusters = clusterByEmbedding(nodeIds, cache, 6, 0.55);

      if (rawClusters.length === 0) {
        set({ clusterLoading: false, clusterError: 'Could not form clusters' });
        return;
      }

      const labelMap = new Map(file.nodes.map(n => [n.id, n.label]));
      const multiRawClusters = rawClusters.filter(ids => ids.length > 1);
      const clustersForPrompt = multiRawClusters.map(ids => ({
        nodeIds: ids,
        labels: ids.map(id => labelMap.get(id) || id),
      }));

      let labels: string[];
      if (clustersForPrompt.length > 0) {
        const prompt = buildClusterLabelPrompt(clustersForPrompt);
        const { text } = await api.generateText(prompt);
        try {
          const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
          labels = JSON.parse(cleaned);
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to parse POV cluster labels from AI response', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
          labels = multiRawClusters.map((_, i) => `Cluster ${i + 1}`);
        }
      } else {
        labels = [];
      }

      const fullLabels: string[] = [];
      let multiIdx = 0;
      for (const ids of rawClusters) {
        if (ids.length > 1) {
          fullLabels.push(labels[multiIdx] || `Cluster ${multiIdx + 1}`);
          multiIdx++;
        } else {
          fullLabels.push('');
        }
      }

      const multiClusters: { label: string; nodeIds: string[] }[] = [];
      const singletonIds: string[] = [];

      for (let i = 0; i < rawClusters.length; i++) {
        if (rawClusters[i].length === 1) {
          singletonIds.push(...rawClusters[i]);
        } else {
          multiClusters.push({
            label: fullLabels[i] || `Cluster ${i + 1}`,
            nodeIds: rawClusters[i],
          });
        }
      }

      const misfits = new Set<string>();
      try {
        const descMap = new Map(file.nodes.map(n => [n.id, n.description || n.label]));

        const nliPairs: Array<{ text_a: string; text_b: string; clusterIdx: number; idA: string; idB: string }> = [];
        for (let ci = 0; ci < multiClusters.length; ci++) {
          const ids = multiClusters[ci].nodeIds;
          if (ids.length < 3) continue;
          for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
              nliPairs.push({
                text_a: descMap.get(ids[i]) || ids[i],
                text_b: descMap.get(ids[j]) || ids[j],
                clusterIdx: ci,
                idA: ids[i],
                idB: ids[j],
              });
            }
          }
        }

        if (nliPairs.length > 0) {
          const { results } = await api.nliClassify(nliPairs);

          const nodeCounts = new Map<string, { agrees: number; contradicts: number }>();

          for (let k = 0; k < results.length; k++) {
            const { idA, idB } = nliPairs[k];
            const label = results[k].nli_label;
            for (const id of [idA, idB]) {
              if (!nodeCounts.has(id)) nodeCounts.set(id, { agrees: 0, contradicts: 0 });
            }
            if (label === 'contradiction') {
              nodeCounts.get(idA)!.contradicts++;
              nodeCounts.get(idB)!.contradicts++;
            } else {
              nodeCounts.get(idA)!.agrees++;
              nodeCounts.get(idB)!.agrees++;
            }
          }

          const candidateMisfits: string[] = [];
          for (const [nodeId, counts] of nodeCounts) {
            if (counts.contradicts > counts.agrees) {
              candidateMisfits.push(nodeId);
            }
          }
          for (let ci = 0; ci < multiClusters.length; ci++) {
            const clusterIds = new Set(multiClusters[ci].nodeIds);
            const clusterCandidates = candidateMisfits.filter(id => clusterIds.has(id));
            if (clusterCandidates.length > 0 && clusterCandidates.length < clusterIds.size / 2) {
              for (const id of clusterCandidates) misfits.add(id);
            }
          }

          if (misfits.size > 0) {
            console.log(`[clusterView] NLI flagged ${misfits.size} potential misfit nodes:`,
              [...misfits].join(', '));
          }
        }
      } catch (nliErr) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'NLI misfit detection failed during cluster view', error: { name: (nliErr as Error).name ?? 'Error', message: String(nliErr), stack: (nliErr as Error).stack } });
        console.warn('[clusterView] NLI misfit detection failed, continuing without:', nliErr);
      }

      multiClusters.sort((a, b) => b.nodeIds.length - a.nodeIds.length);

      if (singletonIds.length > 0) {
        multiClusters.push({ label: 'Other', nodeIds: singletonIds });
      }

      set({ clusterView: { clusters: multiClusters, misfits: misfits.size > 0 ? misfits : undefined }, clusterLoading: false });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'Failed to run POV cluster view', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ clusterLoading: false, clusterError: mapErrorToUserMessage(err, { kind: 'ai' }) });
    }
  },
});
