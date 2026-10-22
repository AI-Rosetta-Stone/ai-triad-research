// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Per-debate sliding-window rate limiter for free-tier AI calls (t/4420).
 *
 * Free-tier debates share a per-requester cap of 30 RPM. A p95 burst of
 * 37 calls would hit that cap. This limiter holds calls above 28/min so
 * bursts land within the safe headroom. BYOK users are unpaced — they
 * own their own quota. WARN fires once per debate instance when pacing
 * first engages so operators know throttling is active.
 */

export interface RateLimiterWarnFn {
  (message: string): void;
}

export class DebateRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxPerMinute: number;
  private readonly isByok: boolean;
  private warnedThisDebate = false;

  /**
   * @param isByok - true when the user supplied their own API key; disables pacing
   * @param maxPerMinute - call budget per 60-second window (default 28)
   */
  constructor(isByok: boolean, maxPerMinute = 28) {
    this.isByok = isByok;
    this.maxPerMinute = maxPerMinute;
  }

  /**
   * Call before each AI request. Waits if the sliding 60-second window is
   * at capacity. Emits a one-time WARN via `warn` when pacing first engages.
   * No-op for BYOK adapters.
   */
  async waitIfNeeded(warn: RateLimiterWarnFn): Promise<void> {
    if (this.isByok) return;

    const WINDOW_MS = 60_000;
    const now = Date.now();

    // Prune timestamps that have slid out of the window.
    while (this.timestamps.length > 0 && this.timestamps[0]! <= now - WINDOW_MS) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxPerMinute) {
      // Wait until the oldest call expires from the window.
      const waitMs = this.timestamps[0]! + WINDOW_MS - now + 1;
      if (!this.warnedThisDebate) {
        this.warnedThisDebate = true;
        warn(
          `Free-tier rate pacing engaged: ${this.timestamps.length} calls in last 60s ` +
          `(limit ${this.maxPerMinute}/min) — holding ${Math.ceil(waitMs / 1000)}s`,
        );
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, waitMs)));
      // Re-prune after the wait.
      const afterWait = Date.now();
      while (this.timestamps.length > 0 && this.timestamps[0]! <= afterWait - WINDOW_MS) {
        this.timestamps.shift();
      }
    }

    this.timestamps.push(Date.now());
  }
}
