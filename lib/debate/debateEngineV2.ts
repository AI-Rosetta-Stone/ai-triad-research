/**
 * Debate Engine V2 — Improved BDI Processing Pipeline
 *
 * New capabilities:
 * - Improved Belief-Desire-Intention (BDI) state tracking
 * - Parallel processing for BDI grounding
 * - Enhanced performance monitoring
 * - Better error recovery
 * - Feature flag integration
 *
 * @see DEBATE_NEW_ENGINE feature flag
 */

import type { DebateSession, Signal, PredicateResult } from './types.js';
import type { PovNode, SituationNode } from './taxonomyTypes.js';
import type { AIAdapter } from '../ai-client/aiClientV2Adapter.js';
import { DEFAULT_MODEL } from '../ai-client/defaults.js';
import { getFlagValue } from '../phase2Flags.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { getTelemetryClient } from '../telemetry-client.js';

// ─────────────────────────────────────────────────────────────────────────
// BDI State Management (Improved)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Enhanced BDI state for debate participants.
 * Tracks beliefs, desires, intentions with confidence scores.
 */
export interface BDIState {
  /** Participant's current beliefs about the topic */
  beliefs: BeliefSet;
  /** Participant's goals/desires in this debate */
  desires: DesireSet;
  /** Participant's intended actions/arguments */
  intentions: IntentionSet;
  /** BDI evolution timeline */
  history: BDIStateSnapshot[];
  /** Confidence in current state (0-1) */
  confidence: number;
}

export interface BeliefSet {
  core: Belief[];
  peripheral: Belief[];
  challenged: Belief[];
  updatedAt: ISO8601;
}

export interface Belief {
  claim: string;
  strength: number; // 0-1, influenced by evidence
  source: string;
  challenged: boolean;
  refutations: string[];
}

export interface DesireSet {
  primary: Desire[];
  secondary: Desire[];
  updatedAt: ISO8601;
}

export interface Desire {
  goal: string;
  priority: number; // 0-1
  status: 'active' | 'achieved' | 'abandoned';
  rationale: string;
}

export interface IntentionSet {
  planned: Intention[];
  active: Intention[];
  completed: Intention[];
  updatedAt: ISO8601;
}

export interface Intention {
  action: string;
  means: string[];
  deadline?: ISO8601;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  result?: string;
}

export interface BDIStateSnapshot {
  timestamp: ISO8601;
  beliefCount: number;
  desireCount: number;
  intentionCount: number;
  confidence: number;
  trigger: string;
}

// Type alias for ISO 8601 timestamps
type ISO8601 = string;

// ─────────────────────────────────────────────────────────────────────────
// Debate Engine V2 Class
// ─────────────────────────────────────────────────────────────────────────

export class DebateEngineV2 {
  private bdiStates: Map<string, BDIState> = new Map();
  private performanceMetrics: PerformanceMetrics;
  private flagEnabled: boolean;

  constructor(
    private aiAdapter: AIAdapter,
    private options: DebateEngineV2Options = {}
  ) {
    this.performanceMetrics = {
      startTime: Date.now(),
      processingTimes: [],
      bdiUpdates: 0,
      errors: 0,
    };
    this.flagEnabled = getFlagValue('DEBATE_NEW_ENGINE');
  }

  /**
   * Process a debate turn with improved BDI grounding.
   * - Extracts participant beliefs/desires/intentions
   * - Updates BDI state with evidence from argument
   * - Returns enhanced turn with BDI annotations
   */
  async processTurn(
    povId: string,
    argument: string,
    context: DebateContext
  ): Promise<ProcessedTurn> {
    const startTime = performance.now();

    try {
      // 1. Extract BDI elements from argument
      const bdiElements = await this.extractBDIElements(argument, context);

      // 2. Update participant's BDI state
      const updatedState = await this.updateBDIState(povId, bdiElements, context);

      // 3. Score BDI coherence (are beliefs, desires, intentions aligned?)
      const coherenceScore = this.computeBDICoherence(updatedState);

      // 4. Generate enhanced response with BDI grounding
      const response = await this.generateBDIGroundedResponse(
        povId,
        argument,
        updatedState,
        context
      );

      const processingTime = performance.now() - startTime;
      this.performanceMetrics.processingTimes.push(processingTime);
      this.performanceMetrics.bdiUpdates++;

      // Log performance
      if (this.options.enableTelemetry) {
        this.logPerformance('processTurn', processingTime, { coherenceScore, povId });
      }

      return {
        argument,
        response,
        bdiState: updatedState,
        coherenceScore,
        processingTimeMs: processingTime,
      };
    } catch (error) {
      this.performanceMetrics.errors++;
      const cause = error instanceof Error ? error : new Error(String(error));
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-engine-v2',
        level: 'error',
        message: 'Debate V2 failed to process a turn',
        error: { name: cause.name, message: cause.message, stack: cause.stack },
      });
      throw new DebateEngineV2Error('Failed to process turn', cause);
    }
  }

  /**
   * Extract BDI elements from debate argument.
   * Uses AI adapter to identify beliefs, desires, intentions.
   */
  private async extractBDIElements(
    argument: string,
    context: DebateContext
  ): Promise<ExtractedBDI> {
    const prompt = this.buildBDIExtractionPrompt(argument, context);

    const result = await this.aiAdapter.call({
      model: this.options.extractionModel || DEFAULT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, // Low temp for structured extraction
      maxTokens: 500,
    });

    return this.parseBDIResponse(result.text);
  }

  /**
   * Update participant's BDI state based on extracted elements.
   */
  private async updateBDIState(
    povId: string,
    elements: ExtractedBDI,
    context: DebateContext
  ): Promise<BDIState> {
    let state = this.bdiStates.get(povId) || this.initializeBDIState(povId);

    // Add new beliefs
    for (const belief of elements.beliefs) {
      const existing = state.beliefs.core.find((b) => b.claim === belief.claim);
      if (existing) {
        existing.strength = Math.min(1, existing.strength + 0.1);
        existing.source = belief.source;
      } else {
        state.beliefs.core.push(belief);
      }
    }

    // Update desires
    for (const desire of elements.desires) {
      const existing = state.desires.primary.find((d) => d.goal === desire.goal);
      if (existing) {
        existing.priority = Math.max(existing.priority, desire.priority);
      } else {
        state.desires.primary.push(desire);
      }
    }

    // Add intentions
    state.intentions.planned = [
      ...state.intentions.planned,
      ...elements.intentions.filter((i) => !state.intentions.planned.some((p) => p.action === i.action)),
    ];

    // Record snapshot
    state.history.push({
      timestamp: new Date().toISOString(),
      beliefCount: state.beliefs.core.length,
      desireCount: state.desires.primary.length,
      intentionCount: state.intentions.active.length,
      confidence: state.confidence,
      trigger: 'manual_update',
    });

    // Update timestamp
    state.beliefs.updatedAt = new Date().toISOString();
    state.desires.updatedAt = new Date().toISOString();
    state.intentions.updatedAt = new Date().toISOString();

    this.bdiStates.set(povId, state);
    return state;
  }

  /**
   * Compute BDI coherence score.
   * Measures alignment between beliefs, desires, and intentions.
   * High coherence (close to 1) = participant's BDI is well-aligned
   */
  private computeBDICoherence(state: BDIState): number {
    // Baseline: equal weight to each dimension
    let score = 0;
    let weight = 0;

    // Belief coherence: prefer beliefs that support intentions
    if (state.intentions.active.length > 0) {
      const beliefSupport = state.beliefs.core.filter((b) => !b.challenged).length;
      const beliefScore = beliefSupport / Math.max(1, state.beliefs.core.length);
      score += beliefScore * 0.4;
      weight += 0.4;
    }

    // Desire coherence: goals should align with intentions
    if (state.desires.primary.length > 0) {
      const activeDesires = state.desires.primary.filter(
        (d) => d.status === 'active' || d.status === undefined,
      );
      const desireScore = activeDesires.length / state.desires.primary.length;
      score += desireScore * 0.3;
      weight += 0.3;
    }

    // Intention coherence: intentions should be progressing
    if (state.intentions.active.length > 0) {
      const completedIntentions = state.intentions.completed.length;
      const intentionScore = completedIntentions / Math.max(1, state.intentions.completed.length + state.intentions.active.length);
      score += intentionScore * 0.3;
      weight += 0.3;
    }

    return weight > 0 ? score / weight : 0.5;
  }

  /**
   * Generate response grounded in BDI analysis.
   */
  private async generateBDIGroundedResponse(
    povId: string,
    argument: string,
    bdiState: BDIState,
    context: DebateContext
  ): Promise<string> {
    const prompt = this.buildBDIResponsePrompt(
      povId,
      argument,
      bdiState,
      context
    );

    const result = await this.aiAdapter.call({
      model: this.options.responseModel || DEFAULT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens: 1000,
    });

    return result.text;
  }

  /**
   * Initialize BDI state for new participant.
   */
  private initializeBDIState(povId: string): BDIState {
    return {
      beliefs: {
        core: [],
        peripheral: [],
        challenged: [],
        updatedAt: new Date().toISOString(),
      },
      desires: {
        primary: [],
        secondary: [],
        updatedAt: new Date().toISOString(),
      },
      intentions: {
        planned: [],
        active: [],
        completed: [],
        updatedAt: new Date().toISOString(),
      },
      history: [],
      confidence: 0.5,
    };
  }

  /**
   * Build prompt for BDI extraction.
   */
  private buildBDIExtractionPrompt(argument: string, context: DebateContext): string {
    return `
Extract Beliefs, Desires, and Intentions from this debate argument:

ARGUMENT:
${argument}

CONTEXT:
Topic: ${context.topic}
POV: ${context.povId}

Respond in JSON format:
{
  "beliefs": [
    { "claim": "...", "strength": 0.8, "source": "..." }
  ],
  "desires": [
    { "goal": "...", "priority": 0.9, "rationale": "..." }
  ],
  "intentions": [
    { "action": "...", "means": [...] }
  ]
}
`;
  }

  /**
   * Build prompt for BDI-grounded response.
   */
  private buildBDIResponsePrompt(
    povId: string,
    argument: string,
    bdiState: BDIState,
    context: DebateContext
  ): string {
    const coreBeliefs = bdiState.beliefs.core
      .slice(0, 3)
      .map((b) => `- ${b.claim} (strength: ${b.strength.toFixed(2)})`)
      .join('\n');

    const primaryDesires = bdiState.desires.primary
      .slice(0, 2)
      .map((d) => `- ${d.goal} (priority: ${d.priority.toFixed(2)})`)
      .join('\n');

    return `
You are debating the topic: "${context.topic}"
Your perspective (${povId}) has:

CORE BELIEFS:
${coreBeliefs || '(none yet)'}

PRIMARY DESIRES:
${primaryDesires || '(none yet)'}

Opponent's argument:
${argument}

Generate a response that:
1. Acknowledges valid points while maintaining your BDI integrity
2. Grounds your counter-argument in your core beliefs
3. Moves toward your primary desires/goals

Response:
`;
  }

  /**
   * Parse AI response for BDI elements.
   */
  private parseBDIResponse(response: string): ExtractedBDI {
    try {
      const json = JSON.parse(response);
      return {
        beliefs: json.beliefs || [],
        desires: json.desires || [],
        intentions: json.intentions || [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-engine-v2',
        level: 'warn',
        message: `BDI response was not valid JSON; using empty BDI data: ${message}`,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message,
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      // Fallback: return empty BDI
      return { beliefs: [], desires: [], intentions: [] };
    }
  }

  /**
   * Log performance metrics to ApplicationInsights.
   */
  private logPerformance(
    operation: string,
    duration: number,
    customProperties?: Record<string, unknown>
  ): void {
    getTelemetryClient().trackMetric(`debate_engine_v2_${operation}`, duration, {
      duration_ms: duration.toFixed(2),
      ...customProperties,
    });
  }

  /**
   * Get current performance metrics.
   */
  getMetrics(): DebateEngineV2Metrics {
    const avgProcessingTime =
      this.performanceMetrics.processingTimes.length > 0
        ? this.performanceMetrics.processingTimes.reduce((a, b) => a + b, 0) /
          this.performanceMetrics.processingTimes.length
        : 0;

    return {
      totalProcessingTimeMs: Date.now() - this.performanceMetrics.startTime,
      avgTurnProcessingMs: avgProcessingTime,
      bdiUpdatesProcessed: this.performanceMetrics.bdiUpdates,
      errorsEncountered: this.performanceMetrics.errors,
      engineEnabled: this.flagEnabled,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Types and Interfaces
// ─────────────────────────────────────────────────────────────────────────

export interface DebateEngineV2Options {
  extractionModel?: string;
  responseModel?: string;
  enableTelemetry?: boolean;
}

export interface DebateContext {
  topic: string;
  povId: string;
  sessionId: string;
  round: number;
}

export interface ExtractedBDI {
  beliefs: Belief[];
  desires: Desire[];
  intentions: Intention[];
}

export interface ProcessedTurn {
  argument: string;
  response: string;
  bdiState: BDIState;
  coherenceScore: number;
  processingTimeMs: number;
}

export interface PerformanceMetrics {
  startTime: number;
  processingTimes: number[];
  bdiUpdates: number;
  errors: number;
}

export interface DebateEngineV2Metrics {
  totalProcessingTimeMs: number;
  avgTurnProcessingMs: number;
  bdiUpdatesProcessed: number;
  errorsEncountered: number;
  engineEnabled: boolean;
}

/**
 * DebateEngineV2Error — Custom error type.
 */
export class DebateEngineV2Error extends Error {
  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'DebateEngineV2Error';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Export for use in debateEngine.ts
// ─────────────────────────────────────────────────────────────────────────

export const createDebateEngineV2 = (
  aiAdapter: AIAdapter,
  options?: DebateEngineV2Options
): DebateEngineV2 => {
  return new DebateEngineV2(aiAdapter, options);
};
