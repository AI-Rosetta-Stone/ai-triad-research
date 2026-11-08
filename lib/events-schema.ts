// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * T3.2 Phase 3: Telemetry Events Schema (lib/monitoring)
 *
 * Unified event type definitions for Phase 2 features.
 * All events carry context (session_id, user_id, timestamp).
 *
 * Event Taxonomy:
 * - debate_* — Debate Engine V2 (BDI state, coherence)
 * - cache_* — Taxonomy Cache V2 (hit/miss/eviction)
 * - batch_* — AI Client V2 batching
 * - streaming_* — AI Client V2 streaming
 * - ai_client_* — AI Client errors
 *
 * Consumed by:
 * - ApplicationInsights telemetry collection
 * - lib/ci-gates/regression-detector.ts (baseline comparison)
 */

// ─────────────────────────────────────────────────────
// Base Context (all events)
// ─────────────────────────────────────────────────────

export interface EventContext {
  sessionId: string;
  userId: string | null;
  timestamp: number; // Unix milliseconds
  environment: 'local' | 'staging' | 'prod';
}

// ─────────────────────────────────────────────────────
// Debate Engine V2 Events
// ─────────────────────────────────────────────────────

export interface DebateEngineStartedEvent {
  kind: 'debate_engine_started';
  context: EventContext;
  engineVersion: '2';
  participants: number;
  topicLength: number;
}

export interface CoherenceComputedEvent {
  kind: 'coherence_computed';
  context: EventContext;
  participantId: string;
  score: number; // 0-1
  beliefs: number;
  desires: number;
  intentions: number;
  durationMs: number;
}

export interface BdiEnrichmentEvent {
  kind: 'bdi_enrichment';
  context: EventContext;
  turnNumber: number;
  entriesEnriched: number;
  annotationsAdded: number;
  durationMs: number;
}

export interface DebateEngineErrorEvent {
  kind: 'debate_engine_error';
  context: EventContext;
  errorMessage: string;
  fallbackToV1: boolean;
}

// ─────────────────────────────────────────────────────
// Taxonomy Cache V2 Events
// ─────────────────────────────────────────────────────

export interface CacheHitEvent {
  kind: 'cache_hit';
  context: EventContext;
  nodeId: string;
  lookupDurationMs: number;
}

export interface CacheMissEvent {
  kind: 'cache_miss';
  context: EventContext;
  nodeId: string;
  fetchDurationMs: number;
}

export interface CacheEvictionEvent {
  kind: 'cache_eviction';
  context: EventContext;
  nodeId: string;
  reason: 'lru' | 'ttl' | 'manual_clear';
  currentSize: number;
  maxSize: number;
}

export interface CacheTtlExpiredEvent {
  kind: 'cache_ttl_expired';
  context: EventContext;
  nodeId: string;
  ageSeconds: number;
}

// ─────────────────────────────────────────────────────
// AI Client V2 Events
// ─────────────────────────────────────────────────────

export interface BatchRequestedEvent {
  kind: 'batch_requested';
  context: EventContext;
  batchSize: number;
  totalPromptTokens: number;
}

export interface BatchSentEvent {
  kind: 'batch_sent';
  context: EventContext;
  batchId: string;
  provider: string;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface StreamingStartedEvent {
  kind: 'streaming_started';
  context: EventContext;
  streamId: string;
  provider: string;
  model: string;
}

export interface StreamingChunkEvent {
  kind: 'streaming_chunk';
  context: EventContext;
  streamId: string;
  chunkLength: number;
  durationMs: number;
}

export interface StreamingCompleteEvent {
  kind: 'streaming_complete';
  context: EventContext;
  streamId: string;
  totalChunks: number;
  totalDurationMs: number;
  totalTokens: number;
}

export interface AIClientErrorEvent {
  kind: 'ai_client_error';
  context: EventContext;
  errorMessage: string;
  fallbackToV1: boolean;
}

// ─────────────────────────────────────────────────────
// Event Union
// ─────────────────────────────────────────────────────

export type Phase2Event =
  | DebateEngineStartedEvent
  | CoherenceComputedEvent
  | BdiEnrichmentEvent
  | DebateEngineErrorEvent
  | CacheHitEvent
  | CacheMissEvent
  | CacheEvictionEvent
  | CacheTtlExpiredEvent
  | BatchRequestedEvent
  | BatchSentEvent
  | StreamingStartedEvent
  | StreamingChunkEvent
  | StreamingCompleteEvent
  | AIClientErrorEvent;

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

export function createEventContext(
  sessionId: string,
  userId?: string | null,
  environment?: 'local' | 'staging' | 'prod',
): EventContext {
  return {
    sessionId,
    userId: userId ?? null,
    timestamp: Date.now(),
    environment: environment ?? 'local',
  };
}

export function isPhase2Event(event: any): event is Phase2Event {
  if (!event || typeof event !== 'object' || !event.kind) {
    return false;
  }

  const kind: string = event.kind;
  return (
    kind.startsWith('debate_') ||
    kind.startsWith('coherence_') ||
    kind.startsWith('bdi_') ||
    kind.startsWith('cache_') ||
    kind.startsWith('batch_') ||
    kind.startsWith('streaming_') ||
    kind.startsWith('ai_client_')
  );
}
