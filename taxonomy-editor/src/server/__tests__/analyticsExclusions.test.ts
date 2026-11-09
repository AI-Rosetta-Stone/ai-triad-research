// @vitest-environment node

/**
 * t/4960 — general analytics exclusion mechanism: listed sessions (staging-leak, pi-test),
 * `internal: true` events, and system identities (`smoke-probe`, `smoke-*`). All three are
 * excluded by default; each has an opt-in `include*` flag. The 2 ambiguous sessions are the
 * one reversed-default case: they count unless `excludeAmbiguous` is set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initAnalytics, appendEvents, queryAggregated, queryRawEvents, queryEngagement, querySubjectBreakdown,
  type AnalyticsEvent,
} from '../community/analytics.js';
import { ANALYTICS_EXCLUDED_SESSIONS, ANALYTICS_AMBIGUOUS_SESSIONS } from '../community/analyticsExclusions.js';

let dataRoot: string;
const D = '2026-06-20';

function evt(partial: Partial<AnalyticsEvent>): AnalyticsEvent {
  return {
    user: 'a', session_id: 's1', timestamp: `${D}T10:00:00.000Z`,
    event_type: 'x', category: 'misc', detail: {}, ...partial,
  };
}

describe('analytics exclusion mechanism (t/4960)', () => {
  beforeEach(async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-excl-'));
    await initAnalytics(dataRoot);
  });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  it('the frozen lists are non-empty and have the expected class sizes (sanity)', () => {
    const reasons = [...ANALYTICS_EXCLUDED_SESSIONS.values()];
    expect(reasons.filter(r => r === 'staging-leak').length).toBe(20); // 14 user + 6 smoke
    expect(reasons.filter(r => r === 'pi-test').length).toBe(160); // 159 + t/4960#7 delta
    expect(ANALYTICS_AMBIGUOUS_SESSIONS.size).toBe(2);
  });

  it('excludes a listed (staging-leak) session by default, counts a non-listed one in the same window', async () => {
    const [listedId] = ANALYTICS_EXCLUDED_SESSIONS.keys();
    await appendEvents([
      evt({ session_id: listedId }),
      evt({ session_id: 'not-listed-session' }),
    ]);
    const r = await queryAggregated(D, D);
    expect(r.summary.totalEvents).toBe(1);
    expect(r.summary.sessions).toBe(1);
  });

  it('includes a listed session when includeListed is set', async () => {
    const [listedId] = ANALYTICS_EXCLUDED_SESSIONS.keys();
    await appendEvents([evt({ session_id: listedId })]);
    const r = await queryAggregated(D, D, { includeListed: true });
    expect(r.summary.totalEvents).toBe(1);
  });

  it('a listed pi-test session is excluded even OUTSIDE the staging-leak window (TL t/4960#3 condition 1)', async () => {
    const piTestId = [...ANALYTICS_EXCLUDED_SESSIONS.entries()].find(([, reason]) => reason === 'pi-test')![0];
    const outsideWindowDate = '2026-11-07'; // after the 11-02..11-04 staging-leak window
    await appendEvents([evt({ session_id: piTestId, timestamp: `${outsideWindowDate}T10:00:00.000Z` })]);
    const r = await queryAggregated(outsideWindowDate, outsideWindowDate);
    expect(r.summary.totalEvents).toBe(0); // still excluded — the window is informational only
  });

  it('excludes events with internal: true by default, includes them when includeInternal is set', async () => {
    await appendEvents([
      evt({ session_id: 's-internal', internal: true }),
      evt({ session_id: 's-normal' }),
    ]);
    const excluded = await queryAggregated(D, D);
    expect(excluded.summary.totalEvents).toBe(1);

    const included = await queryAggregated(D, D, { includeInternal: true });
    expect(included.summary.totalEvents).toBe(2);
  });

  it('a normal event (no internal field at all) is never affected by the internal filter', async () => {
    await appendEvents([evt({ session_id: 's-plain' })]); // internal omitted entirely
    const r = await queryAggregated(D, D);
    expect(r.summary.totalEvents).toBe(1);
  });

  it('excludes system identities (smoke-probe, smoke-*) by default, includes them when includeSystem is set', async () => {
    await appendEvents([
      evt({ user: 'smoke-probe', session_id: 'sess-1' }),
      evt({ user: 'smoke-ci-runner', session_id: 'sess-2' }),
      evt({ user: 'real-user', session_id: 'smoke-weird-session-id' }),
      evt({ user: 'real-user', session_id: 'sess-4' }),
    ]);
    const excluded = await queryAggregated(D, D);
    expect(excluded.summary.totalEvents).toBe(1); // only sess-4 survives

    const included = await queryAggregated(D, D, { includeSystem: true });
    expect(included.summary.totalEvents).toBe(4);
  });

  it('ambiguous sessions count by default, and are excluded only when excludeAmbiguous is set', async () => {
    const [ambiguousId] = ANALYTICS_AMBIGUOUS_SESSIONS;
    await appendEvents([evt({ session_id: ambiguousId })]);

    const byDefault = await queryAggregated(D, D);
    expect(byDefault.summary.totalEvents).toBe(1); // counts by default

    const excluded = await queryAggregated(D, D, { excludeAmbiguous: true });
    expect(excluded.summary.totalEvents).toBe(0);
  });

  it('a malformed event missing user/session_id does not crash the query — it just never matches system identity (Quality p/634#11)', async () => {
    // Stored lines are JSON.parse-cast without validation (readEvents); a legacy/malformed
    // event missing `user` or `session_id` must not throw inside isSystemIdentity's
    // .startsWith() calls, since one bad line would otherwise fail the ENTIRE query.
    await appendEvents([evt({ session_id: 'well-formed-session' })]);
    fs.appendFileSync(
      path.join(dataRoot, 'analytics', `${D}.ndjson`),
      JSON.stringify({ timestamp: `${D}T10:00:01.000Z`, event_type: 'x', category: 'misc', detail: {} }) + '\n',
    );

    const r = await queryAggregated(D, D);
    expect(r.summary.totalEvents).toBe(2); // both events counted; the malformed one isn't dropped, just never a "system" match
  });

  it('all four query functions pass exclusion opts through (no silent bypass)', async () => {
    const [listedId] = ANALYTICS_EXCLUDED_SESSIONS.keys();
    await appendEvents([
      evt({
        session_id: listedId, event_type: 'view.dwell', duration_ms: 1000,
        detail: { subject_type: 'panel', subject_id: 'node-1' },
      }),
    ]);

    // Default: excluded everywhere.
    expect((await queryAggregated(D, D)).summary.totalEvents).toBe(0);
    expect(await queryRawEvents(D, D)).toHaveLength(0);
    expect((await queryEngagement(D, D)).aggregate.tool.visits).toBe(0);
    expect((await querySubjectBreakdown(D, D, 'node-1', 'session')).rows).toHaveLength(0);

    // With includeListed: counted everywhere.
    expect((await queryAggregated(D, D, { includeListed: true })).summary.totalEvents).toBe(1);
    expect(await queryRawEvents(D, D, undefined, undefined, { includeListed: true })).toHaveLength(1);
    expect((await queryEngagement(D, D, { includeListed: true })).aggregate.tool.visits).toBe(1);
    expect((await querySubjectBreakdown(D, D, 'node-1', 'session', undefined, { includeListed: true })).rows).toHaveLength(1);
  });
});
