// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { SourceInfo, PipelineSummary, TaxonomyNode, SelectedKeyPoint, Theme, PotentialEdge, PolicyRegistryEntry, EnrichmentState, EnrichmentProgress, FullTaxonomyNode } from '../types/types';
import { rankBySimilarity } from '../utils/similarity';
import { mapErrorToUserMessage } from '../utils/errorMessages';
import type { SemanticResult } from '../utils/similarity';
import { buildPotentialEdgesSystemPrompt, buildPotentialEdgesUserPrompt } from '../prompts/potentialEdges';
import { SEMANTIC_DEDUP_THRESHOLD } from '../constants';
import { buildHierarchyPlacementUserPrompt, buildAttributeExtractionUserPrompt, buildEdgeDiscoveryUserPrompt } from '../prompts/userPromptBuilders';
import type { AIBackend, AIModel } from './aiModels';
import { getStoredBackend, getStoredModel, storeBackend, storeModel, DEFAULT_MODELS } from './aiModels';
import { nodePovFromId } from '@lib/debate';

interface SummaryViewerState {
  // Data
  sources: SourceInfo[];
  summaries: Record<string, PipelineSummary>;
  taxonomy: Record<string, TaxonomyNode>;
  policyRegistry: PolicyRegistryEntry[];
  snapshots: Record<string, string>;
  loaded: boolean;

  // Selections
  selectedSourceIds: Set<string>;
  selectedKeyPoint: SelectedKeyPoint | null;

  // UI
  theme: Theme;
  pane1Visible: boolean;

  // Document search (triggered by clicking claims/unmapped concepts)
  documentSearchText: string | null;

  // Similarity search
  similarQuery: string | null;
  similarQueryDescription: string | null;
  similarResults: SemanticResult[] | null;
  similarLoading: boolean;
  similarError: string | null;
  similarThreshold: number;
  embeddingCache: Map<string, number[]>;

  // Potential edges
  potentialEdgesQuery: string | null;
  potentialEdges: PotentialEdge[] | null;
  potentialEdgesLoading: boolean;
  potentialEdgesError: string | null;

  // Enrichment pipeline
  enrichment: Map<string, EnrichmentState>;

  // AI settings
  aiBackend: AIBackend;
  aiModel: AIModel;
  setAIBackend: (backend: AIBackend) => void;
  setAIModel: (model: AIModel) => void;
  /** t/785: re-resolve the saved model against the loaded catalog (a retired id falls back, with a WARN). */
  revalidateAIModel: () => void;

  // Actions
  loadSources: () => Promise<void>;
  toggleSource: (id: string) => void;
  toggleAll: (filterIds?: string[]) => void;
  selectKeyPoint: (docId: string, pov: string, index: number) => void;
  selectDocumentSearch: (docId: string, searchText: string) => void;
  clearKeyPoint: () => void;
  setTheme: (t: Theme) => void;
  togglePane1: () => void;
  addToTaxonomy: (pov: string, category: string, label: string, description: string, interpretations?: { accelerationist: string; safetyist: string; skeptic: string }, docId?: string, conceptIndex?: number) => Promise<{ success: boolean; nodeId: string; error?: string }>;
  runSimilarSearch: (concept: string, description: string) => Promise<void>;
  clearSimilarSearch: () => void;
  setSimilarThreshold: (t: number) => void;
  runPotentialEdges: (concept: { label: string; description: string; pov: string; category: string }) => Promise<void>;
  clearPotentialEdges: () => void;
  runEnrichmentPipeline: (nodeId: string, pov: string, category: string, docId?: string, label?: string, description?: string) => Promise<void>;
}

export const useStore = create<SummaryViewerState>((set, get) => ({
  sources: [],
  summaries: {},
  taxonomy: {},
  policyRegistry: [],
  snapshots: {},
  loaded: false,
  selectedSourceIds: new Set<string>(),
  selectedKeyPoint: null,
  documentSearchText: null,
  theme: (localStorage.getItem('summaryviewer-theme') as Theme) || 'system',
  pane1Visible: true,
  similarQuery: null,
  similarQueryDescription: null,
  similarResults: null,
  similarLoading: false,
  similarError: null,
  similarThreshold: 60,
  embeddingCache: new Map(),
  potentialEdgesQuery: null,
  potentialEdges: null,
  potentialEdgesLoading: false,
  potentialEdgesError: null,
  enrichment: new Map(),

  aiBackend: getStoredBackend(),
  aiModel: getStoredModel(),
  setAIBackend: (backend) => {
    storeBackend(backend);
    const newModel = DEFAULT_MODELS[backend];
    storeModel(newModel);
    set({ aiBackend: backend, aiModel: newModel });
  },
  setAIModel: (model) => {
    storeModel(model);
    set({ aiModel: model });
  },
  revalidateAIModel: () => set({ aiModel: getStoredModel() }),

  loadSources: async () => {
    try {
      const discovered = await window.electronAPI.discoverSources();
      const sources = discovered as SourceInfo[];

      // Load all summaries in parallel
      const summaries: Record<string, PipelineSummary> = {};
      await Promise.all(
        sources.map(async (s) => {
          const summary = await window.electronAPI.loadSummary(s.id);
          if (summary) {
            summaries[s.id] = summary as PipelineSummary;
          }
        })
      );

      const taxonomy = await window.electronAPI.loadTaxonomy() as Record<string, TaxonomyNode>;
      const polReg = await window.electronAPI.loadPolicyRegistry() as { policies: PolicyRegistryEntry[] } | null;

      set({ sources, summaries, taxonomy, policyRegistry: polReg?.policies ?? [], loaded: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Failed to load sources',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      console.error('[SummaryViewer] Failed to load sources:', err);
      set({ loaded: true });
    }
  },

  toggleSource: (id: string) => {
    set(state => {
      const next = new Set(state.selectedSourceIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedSourceIds: next };
    });
  },

  toggleAll: (filterIds?: string[]) => {
    set(state => {
      const ids = filterIds || state.sources.map(s => s.id);
      const allSelected = ids.length > 0 && ids.every(id => state.selectedSourceIds.has(id));
      if (allSelected) {
        // Deselect only the filtered set
        const next = new Set(state.selectedSourceIds);
        for (const id of ids) next.delete(id);
        return { selectedSourceIds: next };
      }
      // Select the filtered set (additive)
      const next = new Set(state.selectedSourceIds);
      for (const id of ids) next.add(id);
      return { selectedSourceIds: next };
    });
  },

  selectKeyPoint: async (docId: string, pov: string, index: number) => {
    set({ selectedKeyPoint: { docId, pov, index } });

    // Load snapshot if not already cached
    const { snapshots } = get();
    if (!snapshots[docId]) {
      try {
        const text = await window.electronAPI.loadSnapshot(docId);
        set(state => ({
          snapshots: { ...state.snapshots, [docId]: text },
        }));
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'store',
          level: 'error',
          message: 'Failed to load snapshot for key point',
          error: { name: (err as Error).name ?? 'Error', message: String(err) },
        });
        console.error('[SummaryViewer] Failed to load snapshot:', err);
      }
    }
  },

  selectDocumentSearch: async (docId: string, searchText: string) => {
    set({
      selectedKeyPoint: { docId, pov: '_search', index: 0 },
      documentSearchText: searchText,
    });

    // Load snapshot if not already cached
    const { snapshots } = get();
    if (!snapshots[docId]) {
      try {
        const text = await window.electronAPI.loadSnapshot(docId);
        set(state => ({
          snapshots: { ...state.snapshots, [docId]: text },
        }));
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'store',
          level: 'error',
          message: 'Failed to load snapshot for document search',
          error: { name: (err as Error).name ?? 'Error', message: String(err) },
        });
        console.error('[SummaryViewer] Failed to load snapshot:', err);
      }
    }
  },

  clearKeyPoint: () => {
    set({ selectedKeyPoint: null, documentSearchText: null });
  },

  setTheme: (t: Theme) => {
    localStorage.setItem('summaryviewer-theme', t);
    set({ theme: t });
  },

  togglePane1: () => {
    set(state => ({ pane1Visible: !state.pane1Visible }));
  },

  addToTaxonomy: async (pov: string, category: string, label: string, description: string, interpretations?: { accelerationist: string; safetyist: string; skeptic: string }, docId?: string, conceptIndex?: number) => {
    // Semantic dedup: check if a near-duplicate node already exists via embedding similarity
    try {
      let cache = get().embeddingCache;
      if (cache.size === 0) {
        const loaded = await window.electronAPI.loadEmbeddings();
        if (loaded && Object.keys(loaded).length > 0) {
          cache = new Map<string, number[]>(Object.entries(loaded));
          set({ embeddingCache: cache });
        }
      }
      if (cache.size > 0) {
        const queryText = `${label}: ${description}`;
        const queryVector = await window.electronAPI.computeQueryEmbedding(queryText);
        const matches = rankBySimilarity(queryVector, cache, SEMANTIC_DEDUP_THRESHOLD, 1);
        if (matches.length > 0) {
          const match = matches[0];
          const taxonomy = get().taxonomy;
          const matchNode = taxonomy[match.id];
          const matchLabel = matchNode?.label ?? match.id;
          console.log(`[addToTaxonomy] Semantic near-duplicate detected: "${label}" ≈ "${matchLabel}" (${match.id}, score ${match.score.toFixed(3)}). Using existing node.`);
          // Return the existing node instead of creating a duplicate
          return { success: true, nodeId: match.id };
        }
      }
    } catch (err) {
      // Dedup check failed — proceed with creation (better to risk a duplicate than block the user)
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'warn',
        message: 'Semantic dedup check failed, proceeding with taxonomy node creation',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      console.warn('[addToTaxonomy] Semantic dedup check failed, proceeding with creation:', err);
    }

    const result = await window.electronAPI.addTaxonomyNode({ pov, category, label, description, interpretations, docId, conceptIndex }) as { success: boolean; nodeId: string; error?: string };
    if (result.success) {
      // Reload taxonomy and summaries to reflect the resolved concept
      const taxonomy = await window.electronAPI.loadTaxonomy() as Record<string, TaxonomyNode>;
      if (docId) {
        const summary = await window.electronAPI.loadSummary(docId) as PipelineSummary | null;
        if (summary) {
          set(state => ({
            taxonomy,
            summaries: { ...state.summaries, [docId]: summary },
          }));
        } else {
          set({ taxonomy });
        }
      } else {
        set({ taxonomy });
      }

      // Invalidate embedding cache so next similar search reloads from file
      set({ embeddingCache: new Map() });

      // Fire enrichment pipeline in the background (no await)
      get().runEnrichmentPipeline(result.nodeId, pov, category, docId, label, description);
    }
    return result;
  },

  runSimilarSearch: async (concept: string, description: string) => {
    set({
      similarLoading: true, similarError: null, similarQuery: concept, similarQueryDescription: description, similarResults: null,
      // Clear potential edges if showing
      potentialEdgesQuery: null, potentialEdges: null, potentialEdgesError: null,
    });

    try {
      let cache = get().embeddingCache;

      // Load pre-computed embeddings from embeddings.json if cache is empty
      if (cache.size === 0) {
        const loaded = await window.electronAPI.loadEmbeddings();
        if (!loaded || Object.keys(loaded).length === 0) {
          set({ similarLoading: false, similarError: 'No embeddings found. Run Update-TaxEmbeddings to generate them.' });
          return;
        }
        cache = new Map<string, number[]>(Object.entries(loaded));
        set({ embeddingCache: cache });
      }

      // Compute query embedding via local Python (same model as embeddings.json)
      const queryText = `${concept}: ${description}`;
      const queryVector = await window.electronAPI.computeQueryEmbedding(queryText);

      // Rank results with low threshold (UI slider filters further)
      const results = rankBySimilarity(queryVector, cache, 0.4, 50);
      set({ similarResults: results, similarLoading: false });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Similar search failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      set({ similarError: mapErrorToUserMessage(err), similarLoading: false });
    }
  },

  clearSimilarSearch: () => {
    set({ similarQuery: null, similarQueryDescription: null, similarResults: null, similarLoading: false, similarError: null });
  },

  setSimilarThreshold: (t: number) => {
    set({ similarThreshold: t });
  },

  runPotentialEdges: async (concept) => {
    set({
      potentialEdgesLoading: true,
      potentialEdgesError: null,
      potentialEdgesQuery: concept.label,
      potentialEdges: null,
      // Clear similar search if showing
      similarQuery: null, similarResults: null, similarError: null,
    });

    try {
      const taxonomy = get().taxonomy;
      const candidateNodes = Object.entries(taxonomy).map(([id, node]) => {
        const pov = nodePovFromId(id) ?? 'situations';
        return { id, label: node.label, description: node.description, pov, category: node.category };
      });

      const systemPrompt = buildPotentialEdgesSystemPrompt();
      const userPrompt = buildPotentialEdgesUserPrompt(concept, candidateNodes);

      const rawText = await window.electronAPI.generateContent(systemPrompt, userPrompt, get().aiModel);
      // Strip markdown fences and trailing commas that Gemini sometimes emits
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .replace(/,\s*([}\]])/g, '$1');
      const parsed = JSON.parse(cleaned) as { edges: PotentialEdge[] };

      // Validate: filter to only edges referencing real nodes
      const validIds = new Set(Object.keys(taxonomy));
      const validEdges = (parsed.edges || []).filter(e => validIds.has(e.target) && e.confidence >= 0.5);
      // Sort by confidence descending
      validEdges.sort((a, b) => b.confidence - a.confidence);

      set({ potentialEdges: validEdges, potentialEdgesLoading: false });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Potential edges discovery failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      set({ potentialEdgesError: mapErrorToUserMessage(err), potentialEdgesLoading: false });
    }
  },

  clearPotentialEdges: () => {
    set({ potentialEdgesQuery: null, potentialEdges: null, potentialEdgesLoading: false, potentialEdgesError: null });
  },

  runEnrichmentPipeline: async (nodeId: string, pov: string, category: string, docId?: string, label?: string, description?: string) => {
    const STEPS: EnrichmentProgress[] = [
      { step: 'source_linking', status: 'pending' },
      { step: 'parent_placement', status: 'pending' },
      { step: 'attribute_extraction', status: 'pending' },
      { step: 'edge_discovery', status: 'pending' },
    ];

    const updateStep = (index: number, status: EnrichmentProgress['status'], error?: string) => {
      set(state => {
        const enrichment = new Map(state.enrichment);
        const entry = enrichment.get(nodeId);
        if (entry) {
          const steps = [...entry.steps];
          steps[index] = { ...steps[index], status, error };
          enrichment.set(nodeId, { ...entry, steps });
        }
        return { enrichment };
      });
    };

    // Initialize enrichment state
    set(state => {
      const enrichment = new Map(state.enrichment);
      enrichment.set(nodeId, { nodeId, steps: [...STEPS] });
      return { enrichment };
    });

    const model = get().aiModel;

    const cleanJson = (raw: string): string =>
      raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').replace(/,\s*([}\]])/g, '$1');

    // Helper to reload taxonomy into store after writes
    const reloadTaxonomy = async () => {
      const taxonomy = await window.electronAPI.loadTaxonomy() as Record<string, TaxonomyNode>;
      set({ taxonomy });
    };

    // ── Step 0: Source linking ────────────────────────────────────────────
    updateStep(0, 'running');
    try {
      if (docId) {
        await window.electronAPI.updateNodeFields(nodeId, { source_refs: [docId] });
        updateStep(0, 'done');
      } else {
        updateStep(0, 'skipped');
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Enrichment step 0 (source linking) failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      updateStep(0, 'failed', String(err));
    }

    // ── Step 1: Parent placement ─────────────────────────────────────────
    updateStep(1, 'running');
    try {
      if (!pov) { updateStep(1, 'skipped'); } else {
      const isCrossCutting = pov === 'situations';
      const siblingNodes = await window.electronAPI.getNodesByPovCategory(pov, isCrossCutting ? undefined : category) as FullTaxonomyNode[];

      // Need at least one other node to place under
      const otherNodes = siblingNodes.filter(n => n.id !== nodeId);
      if (otherNodes.length === 0) {
        updateStep(1, 'skipped');
      } else {
        const newNode = siblingNodes.find(n => n.id === nodeId);
        const systemPrompt = await window.electronAPI.loadPrompt('hierarchy-placement-single');
        const userPrompt = buildHierarchyPlacementUserPrompt(
          { id: nodeId, label: label || '', description: description || '', category },
          otherNodes.map(n => ({
            id: n.id,
            label: n.label,
            description: n.description,
            category: n.category,
            parent_id: n.parent_id,
            children: n.children,
          })),
        );

        const raw = await window.electronAPI.generateContent(systemPrompt, userPrompt, model);
        const parsed = JSON.parse(cleanJson(raw)) as {
          action: string;
          parent_id?: string;
          relationship?: string;
          rationale?: string;
          reason?: string;
        };

        if (parsed.action === 'place' && parsed.parent_id) {
          // Validate parent exists in siblings
          const parentExists = otherNodes.some(n => n.id === parsed.parent_id);
          if (parentExists) {
            await window.electronAPI.updateNodeFields(nodeId, {
              parent_id: parsed.parent_id,
              parent_relationship: parsed.relationship || 'is_a',
              parent_rationale: parsed.rationale || '',
            });
            await reloadTaxonomy();
          }
        }
        updateStep(1, 'done');
      }
      } // end else (!pov guard)
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Enrichment step 1 (parent placement) failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      console.error('[Enrichment] Parent placement failed:', err);
      updateStep(1, 'failed', mapErrorToUserMessage(err));
    }

    // ── Step 2: Attribute extraction ─────────────────────────────────────
    updateStep(2, 'running');
    try {
      const systemPrompt = await window.electronAPI.loadPrompt('attribute-extraction-single');
      const userPrompt = buildAttributeExtractionUserPrompt({
        id: nodeId,
        label: label || '',
        description: description || '',
        pov,
        category,
      });

      const raw = await window.electronAPI.generateContent(systemPrompt, userPrompt, model);
      const parsed = JSON.parse(cleanJson(raw)) as Record<string, Record<string, unknown>>;
      const attrs = parsed[nodeId];
      if (attrs) {
        await window.electronAPI.updateNodeFields(nodeId, { graph_attributes: attrs });
        await reloadTaxonomy();
      }
      updateStep(2, 'done');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Enrichment attribute extraction failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      console.error('[Enrichment] Attribute extraction failed:', err);
      updateStep(2, 'failed', mapErrorToUserMessage(err));
    }

    // ── Step 3: Edge discovery ───────────────────────────────────────────
    updateStep(3, 'running');
    try {
      const taxonomy = get().taxonomy;
      const allNodes = Object.entries(taxonomy)
        .filter(([id]) => id !== nodeId)
        .map(([id, node]) => {
          const nodePov = nodePovFromId(id) ?? 'situations';
          return { id, label: node.label, description: node.description, pov: nodePov, category: node.category };
        });

      // Embedding-based pre-filtering
      let candidates = allNodes;
      try {
        let cache = get().embeddingCache;
        if (cache.size === 0) {
          const loaded = await window.electronAPI.loadEmbeddings();
          if (loaded && Object.keys(loaded).length > 0) {
            cache = new Map<string, number[]>(Object.entries(loaded));
            set({ embeddingCache: cache });
          }
        }

        if (cache.size > 0) {
          const queryText = `${label || ''}: ${description || ''}`;
          const queryVector = await window.electronAPI.computeQueryEmbedding(queryText);
          const ranked = rankBySimilarity(queryVector, cache, 0.0, 200);

          // Take top 40 with cross-POV floor (min 4 per non-source POV)
          const TOP_K = 40;
          const MIN_PER_POV = 4;
          const rankedIds = new Set(ranked.map(r => r.id));
          const selected: string[] = [];
          const povCounts: Record<string, number> = {};

          // First pass: take top-K by similarity
          for (const r of ranked) {
            if (selected.length >= TOP_K) break;
            if (r.id === nodeId) continue;
            selected.push(r.id);
            const rPov = allNodes.find(n => n.id === r.id)?.pov || '';
            povCounts[rPov] = (povCounts[rPov] || 0) + 1;
          }

          // Second pass: ensure cross-POV diversity
          const sourcePov = pov;
          for (const otherPov of ['accelerationist', 'safetyist', 'skeptic', 'situations']) {
            if (otherPov === sourcePov) continue;
            const count = povCounts[otherPov] || 0;
            if (count >= MIN_PER_POV) continue;
            const povNodes = ranked
              .filter(r => {
                const rPov = allNodes.find(n => n.id === r.id)?.pov;
                return rPov === otherPov && !selected.includes(r.id);
              });
            for (const r of povNodes) {
              if ((povCounts[otherPov] || 0) >= MIN_PER_POV) break;
              selected.push(r.id);
              povCounts[otherPov] = (povCounts[otherPov] || 0) + 1;
            }
          }

          const selectedSet = new Set(selected);
          candidates = allNodes.filter(n => selectedSet.has(n.id));
        }
      } catch {
        /* telemetry — silent by design */
        candidates = allNodes.slice(0, 80);
      }

      // Get source node's graph_attributes for richer context
      const sourceNodeFull = get().taxonomy[nodeId];
      const sourceNode = {
        id: nodeId,
        label: label || '',
        description: description || '',
        pov,
        category,
        graph_attributes: sourceNodeFull?.graph_attributes as Record<string, unknown> | undefined,
      };

      const systemPrompt = await window.electronAPI.loadPrompt('edge-discovery-single');
      const userPrompt = buildEdgeDiscoveryUserPrompt(sourceNode, candidates);

      const raw = await window.electronAPI.generateContent(systemPrompt, userPrompt, model);
      const parsed = JSON.parse(cleanJson(raw)) as {
        source_node_id: string;
        edges: Array<{
          type: string; target: string; bidirectional: boolean;
          confidence: number; rationale: string; strength?: string;
        }>;
      };

      // Validate edges
      const validIds = new Set(Object.keys(taxonomy));
      const validEdges = (parsed.edges || [])
        .filter(e => validIds.has(e.target) && e.target !== nodeId && e.confidence >= 0.5)
        .map(e => ({
          source: nodeId,
          target: e.target,
          type: e.type,
          bidirectional: e.bidirectional,
          confidence: e.confidence,
          rationale: e.rationale,
          model,
          strength: e.strength,
        }));

      if (validEdges.length > 0) {
        await window.electronAPI.persistEdges(validEdges);
      }
      updateStep(3, 'done');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'store',
        level: 'error',
        message: 'Enrichment edge discovery failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      console.error('[Enrichment] Edge discovery failed:', err);
      updateStep(3, 'failed', mapErrorToUserMessage(err));
    }
  },
}));
