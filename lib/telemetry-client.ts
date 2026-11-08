// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * T3.2 Phase 3: Telemetry Client Wrapper
 *
 * Non-blocking wrapper around ApplicationInsights for Phase 2 events.
 * - Logs all Phase 2 events (debate, cache, AI client)
 * - Tracks performance metrics (p50, p99 latency)
 * - Catches errors (never crashes caller)
 * - Silent fallback if ApplicationInsights unavailable
 */

import type { Phase2Event, EventContext } from './events-schema.js';
import { isPhase2Event } from './events-schema.js';

/**
 * Global telemetry client (ApplicationInsights)
 * Optional: if not configured, all events silently drop
 */
declare global {
  const applicationInsights: {
    defaultClient: {
      trackEvent(event: { name: string; properties?: Record<string, any> }): void;
      trackMetric(metric: { name: string; value: number; properties?: Record<string, any> }): void;
    };
  } | undefined;
}

/**
 * Telemetry client wrapper with performance tracking
 */
export class TelemetryClient {
  private sessionLatencies: Map<string, number[]> = new Map();

  /**
   * Log Phase 2 event to ApplicationInsights
   */
  trackEvent(event: Phase2Event): void {
    if (!isPhase2Event(event)) {
      return;
    }

    try {
      if (!globalThis.applicationInsights?.defaultClient) {
        // Silent: ApplicationInsights not configured
        return;
      }

      // Convert event to ApplicationInsights format
      const aiEvent = {
        name: `phase2_${event.kind}`,
        properties: this.flattenEvent(event),
      };

      globalThis.applicationInsights.defaultClient.trackEvent(aiEvent);
    } catch (err) {
      // Non-blocking: log but don't crash
      console.warn('[Telemetry] Event tracking failed:', err);
    }
  }

  /**
   * Track performance metric
   */
  trackMetric(name: string, value: number, properties?: Record<string, any>): void {
    try {
      if (!globalThis.applicationInsights?.defaultClient) {
        return;
      }

      globalThis.applicationInsights.defaultClient.trackMetric({
        name: `phase2_${name}`,
        value,
        properties,
      });
    } catch (err) {
      console.warn('[Telemetry] Metric tracking failed:', err);
    }
  }

  /**
   * Track latency and update percentiles
   */
  trackLatency(sessionId: string, durationMs: number, label: string): void {
    try {
      // Store latencies per session
      if (!this.sessionLatencies.has(sessionId)) {
        this.sessionLatencies.set(sessionId, []);
      }

      const latencies = this.sessionLatencies.get(sessionId)!;
      latencies.push(durationMs);

      // Compute percentiles
      if (latencies.length % 10 === 0) {
        // Every 10th measurement
        const sorted = [...latencies].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];

        this.trackMetric(`${label}_p50`, p50, { sessionId });
        this.trackMetric(`${label}_p99`, p99, { sessionId });
      }

      // Always track individual
      this.trackMetric(label, durationMs, { sessionId });
    } catch (err) {
      console.warn('[Telemetry] Latency tracking failed:', err);
    }
  }

  /**
   * Get session statistics (for debugging)
   */
  getSessionStats(sessionId: string) {
    const latencies = this.sessionLatencies.get(sessionId) ?? [];
    if (latencies.length === 0) {
      return null;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      count: latencies.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  /**
   * Clear session statistics
   */
  clearSessionStats(sessionId?: string): void {
    if (sessionId) {
      this.sessionLatencies.delete(sessionId);
    } else {
      this.sessionLatencies.clear();
    }
  }

  /**
   * Flatten event object for ApplicationInsights properties
   */
  private flattenEvent(event: Phase2Event): Record<string, any> {
    const result: Record<string, any> = {
      kind: event.kind,
      sessionId: event.context.sessionId,
      userId: event.context.userId,
      environment: event.context.environment,
      timestamp: new Date(event.context.timestamp).toISOString(),
    };

    // Add kind-specific properties
    for (const [key, value] of Object.entries(event)) {
      if (key !== 'kind' && key !== 'context') {
        // Skip non-primitive values
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          result[key] = value;
        }
      }
    }

    return result;
  }
}

/**
 * Singleton telemetry client
 */
let telemetryInstance: TelemetryClient | null = null;

export function getTelemetryClient(): TelemetryClient {
  if (!telemetryInstance) {
    telemetryInstance = new TelemetryClient();
  }
  return telemetryInstance;
}

/**
 * Convenience export (matches existing patterns)
 */
export const telemetryClient = getTelemetryClient();
