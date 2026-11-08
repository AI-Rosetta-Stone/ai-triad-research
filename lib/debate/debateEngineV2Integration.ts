// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * T3.1 Phase 3 Integration: Debate Engine V2 Wiring into Production
 *
 * This module integrates DebateEngineV2 into the main debate engine pipeline.
 * Flag-controlled: DEBATE_NEW_ENGINE (default false for backward compatibility)
 *
 * When enabled, all debate sessions receive:
 * - BDI state grounding for each participant
 * - Coherence scoring (beliefs + desires + intentions)
 * - Enriched transcript with debate dynamics metadata
 */

import type { DebateSession, TranscriptEntry } from './types.js';
import type { AIAdapter } from './aiAdapter.js';
import { DebateEngineV2, createDebateEngineV2 } from './debateEngineV2.js';
import { DebateEngineAdapterV2 } from './debateEngineAdapterV2.js';
import { getFlagValue } from '@phase1/flags';

/**
 * Inject V2 engine enrichment into main debate session lifecycle.
 * This is called from debateEngine.ts after each turn completes.
 *
 * @param session - Active debate session (mutated)
 * @param turnEntry - Latest transcript entry
 * @param aiAdapter - AI backend
 * @returns Enhanced session or original (based on flag)
 */
export async function enrichSessionWithV2Grounding(
  session: DebateSession,
  turnEntry: TranscriptEntry,
  aiAdapter: AIAdapter,
): Promise<DebateSession> {
  const v2Enabled = getFlagValue('DEBATE_NEW_ENGINE');
  if (!v2Enabled) {
    return session; // Passthrough if disabled
  }

  try {
    const adapter = new DebateEngineAdapterV2(aiAdapter);
    const enrichedSession = await adapter.enrichSession(session, turnEntry);
    return enrichedSession;
  } catch (err) {
    // Non-blocking: log error but don't crash main engine
    console.warn('[V2 Integration] Enrichment failed:', err);
    return session; // Fallback to original session
  }
}

/**
 * Create standalone V2 engine for debates (if enabled).
 * Used when --use-v2-engine flag is passed to CLI.
 *
 * @param aiAdapter - AI backend
 * @returns Configured DebateEngineV2 or null
 */
export function createV2EngineIfEnabled(aiAdapter: AIAdapter): DebateEngineV2 | null {
  const v2Enabled = getFlagValue('DEBATE_NEW_ENGINE');
  if (!v2Enabled) {
    return null;
  }

  return createDebateEngineV2(aiAdapter, {
    enableTelemetry: true,
    logLevel: 'debug',
  });
}

/**
 * Verify V2 engine readiness (check dependencies, telemetry, etc.)
 * Called during engine initialization.
 *
 * @returns true if V2 can be safely used
 */
export async function verifyV2EngineReadiness(): Promise<boolean> {
  const v2Enabled = getFlagValue('DEBATE_NEW_ENGINE');
  if (!v2Enabled) {
    return true; // If disabled, no need to verify
  }

  try {
    // Check telemetry client availability
    const telemetryAvailable = typeof globalThis.applicationInsights !== 'undefined';
    if (!telemetryAvailable) {
      console.warn('[V2 Integration] ApplicationInsights not configured; V2 will work but telemetry disabled');
    }

    return true;
  } catch (err) {
    console.error('[V2 Integration] Readiness check failed:', err);
    return false;
  }
}
