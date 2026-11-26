// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { BrowserWindow } from 'electron';
import { getApiKey } from './apiKeyStore.js';
import {
  getDefaultTemplates,
  buildStage1Prompt,
  buildStage2Prompt,
} from './promptTemplates.js';
import { loadPromptOverrides, loadAiSettings, getProjectRoot } from './fileIO.js';
import type { RawPoint, RawMapping, AnalysisResult, AnalysisStatus } from './analysisTypes.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { DEFAULT_MODEL } from '../../../lib/ai-client/index.js';
import { callByUsage } from '../../../lib/ai-client/usageRegistry.js';

// Re-export types for convenience
export type { RawPoint, RawMapping, AnalysisResult };

const activeAbortControllers = new Map<string, AbortController>();

function emitProgress(
  sourceId: string,
  status: AnalysisStatus,
  progress: number,
  extra?: { error?: string; stage1Result?: RawPoint[]; result?: AnalysisResult },
): void {
  const windows = BrowserWindow.getAllWindows();
  const payload = { sourceId, status, progress, ...extra };
  for (const win of windows) {
    win.webContents.send('analysis-progress', payload);
  }
}

async function callAI(
  usageId: string,
  prompt: string,
  model: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new ActionableError({
    goal: 'Complete AI analysis',
    problem: 'Analysis was cancelled by user',
    location: 'aiEngine.analyzeSegmentation',
    nextSteps: ['Retry the analysis when ready'],
  });

  const result = await callByUsage(
    usageId,
    { prompt },
    {
      repoRoot: getProjectRoot(),
      fetch: globalThis.fetch,
      resolveApiKey: () => apiKey,
    },
    { model },
  );

  if (!result.text) {
    throw new ActionableError({
      goal: 'Get AI-generated analysis',
      problem: 'AI returned an empty response',
      location: 'aiEngine.ts:callAI',
      nextSteps: [
        'Retry the request — transient API issues can cause empty responses',
        'Check that the prompt is not too long (may exceed model context window)',
        'Verify the model name is valid in AI settings',
      ],
    });
  }

  return result.text;
}

function parseJsonArray<T>(raw: string): T[] {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new ActionableError({
      goal: 'Parse AI response as a JSON array',
      problem: `Expected a JSON array but got ${typeof parsed}: ${JSON.stringify(parsed).slice(0, 120)}`,
      location: 'aiEngine.ts:parseJsonArray',
      nextSteps: [
        'Retry the analysis — the AI model may produce valid JSON on a subsequent attempt',
        'Check the prompt template to ensure it requests a JSON array response',
        'If the issue persists, try a different model in AI settings',
      ],
    });
  }
  return parsed as T[];
}

// ── Validation helpers ──

const VALID_ALIGNMENTS = new Set(['agrees', 'contradicts', 'extends', 'qualifies']);

const ALIGNMENT_KEYWORDS: Record<string, string[]> = {
  agrees: ['agrees', 'agree', 'supports', 'support', 'aligns', 'align', 'affirms', 'endorses', 'consistent'],
  contradicts: ['contradicts', 'contradict', 'opposes', 'oppose', 'disagrees', 'conflicts', 'challenges', 'refutes', 'denies', 'rejects'],
  extends: ['extends', 'extend', 'expands', 'builds', 'elaborates', 'broadens', 'adds to', 'supplements'],
  qualifies: ['qualifies', 'qualify', 'nuances', 'limits', 'conditions', 'restricts', 'caveats', 'partially'],
};

function normalizeAlignment(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (VALID_ALIGNMENTS.has(lower)) return lower;
  for (const [alignment, keywords] of Object.entries(ALIGNMENT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return alignment;
    }
  }
  return 'agrees';
}

function extractNodeIds(taxonomyJson: string): Set<string> {
  const ids = new Set<string>();
  try {
    const taxonomy = JSON.parse(taxonomyJson);
    if (Array.isArray(taxonomy)) {
      for (const node of taxonomy) {
        if (node.id) ids.add(node.id);
      }
    } else if (typeof taxonomy === 'object') {
      for (const key of Object.keys(taxonomy)) {
        const group = taxonomy[key];
        if (group?.nodes && Array.isArray(group.nodes)) {
          for (const node of group.nodes) {
            if (node.id) ids.add(node.id);
          }
        }
      }
    }
  } catch { /* taxonomy parse failed — skip validation */ /* telemetry — silent by design */ }
  return ids;
}

export async function runAnalysis(
  sourceId: string,
  sourceText: string,
  taxonomyJson: string,
): Promise<AnalysisResult> {
  // Cancel any existing analysis for this source
  cancelAnalysis(sourceId);

  const controller = new AbortController();
  activeAbortControllers.set(sourceId, controller);
  const { signal } = controller;

  try {
    const apiKey = getApiKey();
    if (!apiKey) throw new ActionableError({
      goal: 'Run AI-powered source analysis',
      problem: 'No API key configured for the AI backend',
      location: 'aiEngine.ts:runAnalysis',
      nextSteps: [
        'Open Settings and enter your Gemini API key',
        'Or set the GEMINI_API_KEY environment variable',
        'Get a free API key from https://aistudio.google.com/apikey',
      ],
    });

    const settings = loadAiSettings();
    const model = settings.model || DEFAULT_MODEL;

    const promptOverrides = loadPromptOverrides();
    const defaults = getDefaultTemplates();
    const stage1Template = promptOverrides?.stage1 || defaults.stage1;
    const stage2Template = promptOverrides?.stage2 || defaults.stage2;

    // === Stage 1: Segmentation ===
    emitProgress(sourceId, 'stage1_running', 10);

    const stage1Prompt = buildStage1Prompt(stage1Template, sourceText);
    const stage1Raw = await callAI('po.analysis-segmentation', stage1Prompt, model, apiKey, signal);

    if (signal.aborted) throw new ActionableError({
      goal: 'Complete AI analysis',
      problem: 'Analysis was cancelled by user',
      location: 'aiEngine.analyzeMapping',
      nextSteps: ['Retry the analysis when ready'],
    });

    const points = parseJsonArray<RawPoint>(stage1Raw);

    // Validate and clamp offsets
    for (const p of points) {
      p.startOffset = Math.max(0, Math.min(p.startOffset, sourceText.length));
      p.endOffset = Math.max(p.startOffset, Math.min(p.endOffset, sourceText.length));
      if (!p.text) {
        p.text = sourceText.slice(p.startOffset, p.endOffset);
      }
    }

    emitProgress(sourceId, 'stage1_complete', 40, { stage1Result: points });

    // === Stage 2: Mapping ===
    emitProgress(sourceId, 'stage2_running', 50);

    const pointsSummary = points.map((p, i) => ({
      index: i,
      text: p.text,
    }));

    const stage2Prompt = buildStage2Prompt(
      stage2Template,
      JSON.stringify(pointsSummary, null, 2),
      taxonomyJson,
    );
    const stage2Raw = await callAI('po.analysis-mapping', stage2Prompt, model, apiKey, signal);

    if (signal.aborted) throw new ActionableError({
      goal: 'Complete AI analysis',
      problem: 'Analysis was cancelled by user',
      location: 'aiEngine.analyzeMapping',
      nextSteps: ['Retry the analysis when ready'],
    });

    let mappings = parseJsonArray<RawMapping>(stage2Raw);

    // Validate node IDs and normalize alignment
    const validIds = extractNodeIds(taxonomyJson);
    if (validIds.size > 0) {
      mappings = mappings.filter(m => validIds.has(m.nodeId));
    }
    for (const m of mappings) {
      m.alignment = normalizeAlignment(m.alignment) as RawMapping['alignment'];
    }

    emitProgress(sourceId, 'stage2_complete', 80);

    // === Merge ===
    emitProgress(sourceId, 'merging', 90);

    const result: AnalysisResult = {
      sourceId,
      points,
      mappings,
      completedAt: new Date().toISOString(),
      model,
    };

    emitProgress(sourceId, 'complete', 100, { result });

    return result;
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'ai-engine',
      level: 'error',
      message: 'runAnalysis failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err) },
    });
    const message = err instanceof Error ? err.message : 'Unknown error';
    emitProgress(sourceId, 'error', 0, { error: message });
    throw err;
  } finally {
    activeAbortControllers.delete(sourceId);
  }
}

export function cancelAnalysis(sourceId: string): void {
  const controller = activeAbortControllers.get(sourceId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(sourceId);
  }
}

export function getAnalysisStatus(sourceId: string): { running: boolean } {
  return { running: activeAbortControllers.has(sourceId) };
}

// === Quick Excerpt Analysis ===

export interface ExcerptMapping {
  nodeId: string;
  nodeLabel: string;
  category: string;
  camp: string;
  alignment: 'agrees' | 'contradicts' | 'extends' | 'qualifies';
  strength: 'strong' | 'moderate' | 'weak';
  explanation: string;
}

const EXCERPT_PROMPT = `You are an expert policy analyst. Given a short excerpt from an AI governance document and a taxonomy of perspectives, determine which taxonomy nodes this excerpt maps to.

For each mapping, specify the taxonomy node, camp, alignment, strength, and a brief explanation.

If the excerpt does not clearly map to any taxonomy node, return an empty array.

Excerpt:
{{excerpt}}

Taxonomy:
{{taxonomy}}

Return a JSON array:
[
  {
    "nodeId": "acc-desires-001",
    "nodeLabel": "Node label",
    "category": "Category",
    "camp": "accelerationist",
    "alignment": "agrees",
    "strength": "strong",
    "explanation": "Brief rationale"
  }
]`;

export async function analyzeExcerpt(
  excerptText: string,
  taxonomyJson: string,
): Promise<ExcerptMapping[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new ActionableError({
    goal: 'Run quick excerpt analysis against the taxonomy',
    problem: 'No API key configured for the AI backend',
    location: 'aiEngine.ts:analyzeExcerpt',
    nextSteps: [
      'Open Settings and enter your Gemini API key',
      'Or set the GEMINI_API_KEY environment variable',
      'Get a free API key from https://aistudio.google.com/apikey',
    ],
  });

  const settings = loadAiSettings();
  const model = settings.model || DEFAULT_MODEL;

  const prompt = EXCERPT_PROMPT
    .replace('{{excerpt}}', excerptText)
    .replace('{{taxonomy}}', taxonomyJson);

  const controller = new AbortController();
  const raw = await callAI('po.excerpt-mapping', prompt, model, apiKey, controller.signal);
  let results = parseJsonArray<ExcerptMapping>(raw);

  const validIds = extractNodeIds(taxonomyJson);
  if (validIds.size > 0) {
    results = results.filter(m => validIds.has(m.nodeId));
  }
  for (const m of results) {
    m.alignment = normalizeAlignment(m.alignment) as ExcerptMapping['alignment'];
  }

  return results;
}
