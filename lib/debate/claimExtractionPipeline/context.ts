// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { ExtendedAIAdapter } from '../aiAdapter.js';
import type { LoadedTaxonomy } from '../taxonomyLoader.js';
import type {
  DebateSession,
  TranscriptEntry,
  TaxonomyRef,
  EntryDiagnostics,
} from '../types.js';
import type { ContextManifestEntry } from '../taxonomyGapAnalysis.js';
// Type-only import for DebateConfig to avoid circular dependency
import type { DebateConfig } from '../debateEngine.js';

// ── Context interface (engine infrastructure) ───────────────

export interface ClaimExtractionContext {
  session: DebateSession;
  config: DebateConfig;
  adapter: ExtendedAIAdapter;
  taxonomy: LoadedTaxonomy;
  contextManifests: ContextManifestEntry[];

  generate: (prompt: string, label: string) => Promise<string>;
  generateViaUsage: (usageId: string, prompt: string, label: string) => Promise<string>;
  generateWithModel: (prompt: string, label: string, model: string) => Promise<string>;
  generateWithEvaluator: (prompt: string, label: string, timeoutMs?: number) => Promise<string>;
  resolveStageModel: (key: string) => string;
  addEntry: (entry: { type: string; speaker: string; content: string; taxonomy_refs: TaxonomyRef[]; metadata?: Record<string, unknown> }) => TranscriptEntry;
  recordDiagnostic: (entryId: string, data: Partial<EntryDiagnostics>) => void;
  progress: (phase: string, speaker: string | undefined, message: string) => void;
  warn: (operation: string, error: unknown, recovery: string) => void;
  incrementApiCallCount: () => void;
  getKnownNodeIds: () => Set<string>;
  /** Resolve a node ID to its canonical survivor (non-superseded). Same semantics as LoadedTaxonomy.resolveNode. */
  resolveRef: (id: string) => string;
  getActivatedSituations: () => { id: string; text: string }[];
}
