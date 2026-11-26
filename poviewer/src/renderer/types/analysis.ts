// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Alignment, PovCamp, StrengthLevel } from './types';

// === Analysis Pipeline States ===
export type AnalysisStatus =
  | 'idle'
  | 'queued'
  | 'reading'
  | 'stage1_running'
  | 'stage1_complete'
  | 'stage2_running'
  | 'stage2_complete'
  | 'merging'
  | 'complete'
  | 'error';

export const ANALYSIS_STATUS_LABELS: Record<AnalysisStatus, string> = {
  idle: 'Idle',
  queued: 'Queued',
  reading: 'Reading document...',
  stage1_running: 'Stage 1: Identifying claims...',
  stage1_complete: 'Stage 1 complete',
  stage2_running: 'Stage 2: Mapping to taxonomy...',
  stage2_complete: 'Stage 2 complete',
  merging: 'Merging results...',
  complete: 'Analysis complete',
  error: 'Error',
};

// === Stage 1 Output: Raw Points ===
export interface RawPoint {
  text: string;
  startOffset: number;
  endOffset: number;
}

// === Stage 2 Output: Raw Mappings ===
export interface RawMapping {
  pointIndex: number;
  nodeId: string;
  nodeLabel: string;
  category: string;
  camp: PovCamp;
  alignment: Alignment;
  strength: StrengthLevel;
  explanation: string;
}

// === Analysis Result ===
export interface AnalysisResult {
  sourceId: string;
  points: RawPoint[];
  mappings: RawMapping[];
  completedAt: string;
  model: string;
}

// === Chunk Result (for long docs) ===
export interface ChunkResult {
  chunkIndex: number;
  charOffset: number;
  points: RawPoint[];
  mappings: RawMapping[];
}

// === Per-source analysis tracking ===
export interface SourceAnalysisState {
  status: AnalysisStatus;
  progress: number; // 0-100
  error: string | null;
  stage1Result: RawPoint[] | null;
  result: AnalysisResult | null;
  startedAt: string | null;
}

// === AI Settings ===
export interface AiSettings {
  model: string;
  temperature: number;
  customPromptStage1: string | null;
  customPromptStage2: string | null;
}

// === Progress event from main process ===
export interface AnalysisProgressEvent {
  sourceId: string;
  status: AnalysisStatus;
  progress: number;
  error?: string;
  stage1Result?: RawPoint[];
  result?: AnalysisResult;
}
