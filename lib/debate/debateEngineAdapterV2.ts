/**
 * Integration Module: DebateEngineV2 Adapter for Main Debate Engine
 *
 * This file enables DebateEngineV2 to work alongside the existing debate engine.
 * Feature flag DEBATE_NEW_ENGINE controls which path is used.
 *
 * @see lib/debate/debateEngine.ts (main engine)
 * @see lib/debate/debateEngineV2.ts (new V2 implementation)
 */

import type { DebateSession, TranscriptEntry } from './types.js';
import type { AIAdapter } from '../ai-client/aiClientV2Adapter.js';
import {
  DebateEngineV2,
  createDebateEngineV2,
} from './debateEngineV2.js';
import { getFlagValue } from '../phase2Flags.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

/**
 * Wrapper that decides between v1 and v2 debate engine based on feature flag.
 *
 * When DEBATE_NEW_ENGINE flag is enabled:
 * - Uses DebateEngineV2 for improved BDI grounding
 * - All turns get BDI state tracking + coherence scoring
 * - Performance metrics logged to ApplicationInsights
 *
 * When disabled (default):
 * - Uses existing debate engine v1
 * - Backward compatible, no changes to behavior
 */
export class DebateEngineAdapterV2 {
  private engineV2: DebateEngineV2 | null = null;
  private v2Enabled: boolean;

  constructor(private aiAdapter: AIAdapter) {
    this.v2Enabled = getFlagValue('DEBATE_NEW_ENGINE');
    if (this.v2Enabled) {
      this.engineV2 = createDebateEngineV2(aiAdapter, {
        enableTelemetry: true,
      });
    }
  }

  /**
   * Process transcript entry with optional BDI grounding.
   *
   * @param entry - Transcript entry from main debate engine
   * @param session - Current debate session
   * @returns Enhanced entry with BDI annotations (if v2 enabled)
   */
  async enrichTranscriptEntry(
    entry: TranscriptEntry,
    session: DebateSession
  ): Promise<TranscriptEntry> {
    if (!this.v2Enabled || !this.engineV2) {
      return entry;
    }

    try {
      const processedTurn = await this.engineV2.processTurn(
        entry.speaker,
        entry.content,
        {
          topic: session.topic.final,
          povId: entry.speaker,
          sessionId: session.id,
          round: session.transcript.length,
        }
      );

      // Annotate entry with BDI metadata
      return {
        ...entry,
        _bdiV2: {
          coherenceScore: processedTurn.coherenceScore,
          processingTimeMs: processedTurn.processingTimeMs,
          bdiState: {
            beliefCount: processedTurn.bdiState.beliefs.core.length,
            desireCount: processedTurn.bdiState.desires.primary.length,
            intentionCount: processedTurn.bdiState.intentions.planned.length,
            confidence: processedTurn.bdiState.confidence,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('DebateEngineV2 enrichment failed:', error);
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-engine-v2-integration',
        level: 'warn',
        message: `V2 enrichment failed; retaining the original transcript entry: ${message}`,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message,
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      return entry;
    }
  }

  /**
   * Get performance metrics from v2 engine.
   */
  getV2Metrics() {
    if (!this.engineV2) {
      return null;
    }
    return this.engineV2.getMetrics();
  }

  /**
   * Check if V2 engine is enabled.
   */
  isV2Enabled(): boolean {
    return this.v2Enabled;
  }

  /**
   * Get v2 engine instance (for advanced use cases).
   */
  getV2Engine(): DebateEngineV2 | null {
    return this.engineV2;
  }
}

/**
 * Factory function for creating debate engine adapter.
 */
export const createDebateEngineAdapterV2 = (
  aiAdapter: AIAdapter
): DebateEngineAdapterV2 => {
  return new DebateEngineAdapterV2(aiAdapter);
};
