// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Wraps the Electron main-process generateText (with net.fetch + key store)
// as the shared AIAdapter interface used by lib/oped and lib/debate cores.

import path from 'path';
import { generateText, resolveAiCallLogContext } from './embeddings.js';
import type { AIAdapter, GenerateOptions } from '../../../lib/debate/aiAdapter.js';
import { writeAICallLogEntry } from './aiCallLog.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { PROJECT_ROOT } from './fileIO.js';
import { getMainRegistry } from './modelConfigCache.js';

// scenario: the AI call log label for this adapter instance's caller (t/3370) — e.g.
// 'Debate', 'OpEd Generation', 'Brief Export'. voiceTimeoutMs: caller-supplied fallback
// when opts.timeoutMs is absent (wired from runtime-config opedVoiceTimeoutMs so the
// tunable timeout governs Stage B LLM calls, not just Stage A source prep).
export function makeElectronAIAdapter(scenario: string, voiceTimeoutMs?: number): AIAdapter {
  return {
    generateText: async (prompt: string, model: string, opts?: GenerateOptions): Promise<string> => {
      let retryCount = 0;
      // t/4088: computed once and reused for both the success and failure log entries — the
      // desktop path has no fallback chain (t/4048), so the requested model is always the model
      // actually called.
      const { model: logModel, backend, keySource } = resolveAiCallLogContext(model);
      try {
        const { text } = await generateText(
          prompt,
          model,
          // Count retries so the log entry reflects the Nth retry (0 = first attempt succeeded).
          (p) => { retryCount = p.attempt; },
          {
            timeoutMs: opts?.timeoutMs ?? voiceTimeoutMs,
            temperature: opts?.temperature,
            signal: opts?.signal,
            responseSchema: opts?.responseSchema,
          },
        );
        writeAICallLogEntry({ scenario, promptId: '', promptStart: prompt, retryCount, status: '200', model: logModel, backend, keySource });
        return text;
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'electron-ai-adapter', level: 'warn',
          message: 'electronAIAdapter: generateText failed — rethrowing to debate engine',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        writeAICallLogEntry({ scenario, promptId: '', promptStart: prompt, retryCount, status: 'error', model: logModel, backend, keySource });
        throw err;
      }
    },
    // t/3614: registry is a required AIAdapter member (getModelMinTimeout removed from the
    // interface). Cached across calls via modelConfigCache's mtime-guarded loader.
    registry: getMainRegistry(path.join(PROJECT_ROOT, 'ai-models.json')),
  };
}
