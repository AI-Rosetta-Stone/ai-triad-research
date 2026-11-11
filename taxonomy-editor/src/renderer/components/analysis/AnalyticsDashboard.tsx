// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Analytics Dashboard — web-only reporting page for usage analytics.
 * Route: #analytics. Entry point: chart icon in SaveBar.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { bridgeGet } from '../../bridge/web-bridge';
import { SystemOverviewRow } from './SystemOverviewRow';
import { useChartTooltip, ChartTooltipLayer } from './chartTooltip';
import { DebateHealthCard } from './DebateHealthCard';
import { AICostCard } from './AICostCard';
import { DebateFunnelChart } from './DebateFunnelChart';
import { UsageHierarchy } from './UsageHierarchy';
import './AnalyticsDashboard.css';

// ── Types ──

interface DailySummary { date: string; events: number; users: number; sessions: number }
interface UserSummary { user: string; lastActive: string; sessions: number; events: number; topCategory: string }
/** Per-model AI spend aggregate (server, t/892). */
export interface AICostBreakdown { calls: number; tokensIn: number; tokensOut: number; costUsd: number }
export interface AICostAggregate extends AICostBreakdown { byModel: Record<string, AICostBreakdown> }

interface QueryResult {
  summary: { activeUsers: number; sessions: number; totalEvents: number; avgSessionDurationMs: number };
  daily: DailySummary[];
  featureUsage: Record<string, number>;
  users: UserSummary[];
  /** Counts keyed by event_type (server, t/888 events) — optional until the aggregation ships. */
  eventTypes?: Record<string, number>;
  /** Summed AI spend from ai.call detail (server) — optional until the aggregation ships. */
  aiCost?: AICostAggregate;
}
interface RawEvent {
  user: string; session_id: string; timestamp: string;
  event_type: string; category: string; detail: Record<string, unknown>; duration_ms?: number;
}

type DatePreset = '1d' | '7d' | '30d' | '90d';

/**
 * Client half of t/4960/t/4962's agreed exclusion contract (t/4961). Query param values are
 * confirmed by ServerAPI (t/4962#4): 'true'/'1' = true, 'false'/'0'/absent = false (absent is
 * the default), any other value is a 400 — so this sends 'true' when a flag is on and omits
 * the param entirely when off.
 *
 * t/4960/t/4962 haven't landed yet, so the toggles that set these render `disabled` with an
 * explanatory caption (Design, p/708#15) — EXCLUSION_TOGGLES_ENABLED is the single flag to
 * flip once they do; no other code here changes.
 */
interface AnalyticsExclusionOptions {
  includeInternal?: boolean;
  includeSystem?: boolean;
  includeListed?: boolean;
}
const EXCLUSION_TOGGLES_ENABLED = false;
type SortCol = 'user' | 'lastActive' | 'sessions' | 'events' | 'topCategory';

const CATEGORY_COLORS: Record<string, string> = {
  navigation: '#3b82f6',
  taxonomy: '#22c55e',
  debate: '#f59e0b',
  search: '#a855f7',
  ai: '#ef4444',
  config: '#6b7280',
};

const PRESET_DAYS: Record<DatePreset, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };

function dateRange(preset: DatePreset): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (PRESET_DAYS[preset] - 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** The equal-length window immediately preceding the current one (for period comparison). */
function previousRange(preset: DatePreset): { from: string; to: string } {
  const days = PRESET_DAYS[preset];
  const to = new Date();
  to.setDate(to.getDate() - days);
  const from = new Date();
  from.setDate(from.getDate() - (2 * days - 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Fetch one analytics window via the resilient bridge helper (timeout/retry/429 handling). */
function fetchQuery(from: string, to: string, opts?: AnalyticsExclusionOptions): Promise<QueryResult> {
  let url = `/api/analytics/query?from=${from}&to=${to}`;
  if (opts?.includeInternal) url += '&includeInternal=true';
  if (opts?.includeSystem) url += '&includeSystem=true';
  if (opts?.includeListed) url += '&includeListed=true';
  return bridgeGet<QueryResult>(url);
}

function relativeTime(iso: string): string {
  const timestamp = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(timestamp)) return 'unknown';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Warn once per user per data load for an unparseable lastActive (t/4961) — validated here,
 *  at parse time, rather than inside relativeTime (called per row on every render/sort/poll). */
function warnUnparseableLastActive(users: UserSummary[]): void {
  for (const u of users) {
    if (!u.lastActive || Number.isNaN(new Date(u.lastActive).getTime())) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'analytics-dashboard',
        level: 'warn',
        message: `Unparseable lastActive for user ${u.user} — rendering "unknown"`,
        error: { name: 'InvalidTimestamp', message: `lastActive=${JSON.stringify(u.lastActive)}`, stack: '' },
      });
    }
  }
}

function fmtDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Format duration in milliseconds as whole seconds for session event timeline (t/5012). */
function fmtEventDurationSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function fmtNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── Components ──

/** Period-over-period delta indicator. `goodWhenUp` null = neutral metric (no green/red). */
function Delta({ current, previous, goodWhenUp }: { current: number; previous: number; goodWhenUp: boolean | null }) {
  // No baseline to compare against — avoid divide-by-zero.
  if (previous === 0) {
    return <div className="adash-delta-neutral">{current > 0 ? 'new' : '—'}</div>;
  }
  const delta = ((current - previous) / previous) * 100;
  const flat = Math.abs(delta) < 0.05;
  const up = delta > 0;
  const arrow = flat ? '→' : up ? '↑' : '↓';
  let color = 'var(--text-muted)';
  if (!flat && goodWhenUp !== null) {
    const good = goodWhenUp ? up : !up;
    color = good ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
  }
  return (
    <div
      className="adash-delta"
      /* eslint-disable-next-line local/no-inline-style -- dynamic: color depends on delta direction/goodWhenUp */
      style={{ color }}
      title={`vs. previous period`}
    >
      {arrow} {Math.abs(delta).toFixed(1)}%
    </div>
  );
}

function SummaryCards({ data, previous }: { data: QueryResult['summary']; previous?: QueryResult['summary'] | null }) {
  // goodWhenUp: true = higher is better (green up); null = neutral (no color judgement)
  const cards: { label: string; value: number; display: string; prev: number | undefined; goodWhenUp: boolean | null }[] = [
    { label: 'Active Users', value: data.activeUsers, display: String(data.activeUsers), prev: previous?.activeUsers, goodWhenUp: true },
    { label: 'Sessions', value: data.sessions, display: String(data.sessions), prev: previous?.sessions, goodWhenUp: true },
    { label: 'Total Events', value: data.totalEvents, display: fmtNumber(data.totalEvents), prev: previous?.totalEvents, goodWhenUp: true },
    { label: 'Avg Session', value: data.avgSessionDurationMs, display: fmtDuration(data.avgSessionDurationMs), prev: previous?.avgSessionDurationMs, goodWhenUp: null },
  ];
  return (
    <div className="adash-cards-row">
      {cards.map(c => (
        <div key={c.label} className="adash-summary-card">
          <div className="adash-summary-value">{c.display}</div>
          <div className="adash-summary-label">{c.label}</div>
          {previous != null && c.prev !== undefined && (
            <Delta current={c.value} previous={c.prev} goodWhenUp={c.goodWhenUp} />
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityChart({ daily }: { daily: DailySummary[] }) {
  const { tip, showTip, hideTip } = useChartTooltip();
  if (daily.length === 0) return null;
  const maxEvents = Math.max(...daily.map(d => d.events), 1);
  const maxUsers = Math.max(...daily.map(d => d.users), 1);

  return (
    <div className="adash-activity-panel">
      <div className="adash-panel-title">Activity Over Time</div>
      <div className="adash-activity-bars">
        {daily.map(d => (
          <div key={d.date} className="adash-activity-bar-col"
            onMouseEnter={e => showTip(e, <><strong>{d.date}</strong><br />{d.events} events · {d.users} users · {d.sessions} sessions</>)}
            onMouseMove={e => showTip(e, <><strong>{d.date}</strong><br />{d.events} events · {d.users} users · {d.sessions} sessions</>)}
            onMouseLeave={hideTip}
          >
            <div
              className="adash-activity-bar"
              /* eslint-disable-next-line local/no-inline-style -- dynamic: bar height from events/maxEvents */
              style={{ height: `${Math.max((d.events / maxEvents) * 100, 2)}%` }}
            />
          </div>
        ))}
      </div>
      {/* User line overlay */}
      <svg viewBox={`0 0 ${daily.length * 10} 100`} className="adash-activity-svg" preserveAspectRatio="none">
        <polyline
          fill="none" stroke="#f59e0b" strokeWidth="2"
          points={daily.map((d, i) => `${i * 10 + 5},${100 - (d.users / maxUsers) * 90}`).join(' ')}
        />
      </svg>
      <div className="adash-activity-legend">
        <span><span className="adash-legend-swatch-events" />Events</span>
        <span><span className="adash-legend-swatch-users" />Users</span>
      </div>
      <ChartTooltipLayer tip={tip} />
    </div>
  );
}

function FeatureUsage({ usage, onFilter }: { usage: Record<string, number>; onFilter: (cat: string) => void }) {
  const sorted = useMemo(() =>
    Object.entries(usage).sort(([, a], [, b]) => b - a),
    [usage]);
  const max = sorted[0]?.[1] || 1;

  return (
    <div className="adash-feature-panel">
      <div className="adash-panel-title">Feature Usage</div>
      {sorted.map(([cat, count]) => (
        <div key={cat} className="adash-feature-row" onClick={() => onFilter(cat)}>
          <div className="adash-feature-row-head">
            <span className="adash-cat-name">{cat}</span>
            <span className="adash-cat-count">{count}</span>
          </div>
          <div className="adash-feature-track">
            <div
              className="adash-feature-fill"
              /* eslint-disable-next-line local/no-inline-style -- dynamic: bar width from count/max, color from category */
              style={{ width: `${(count / max) * 100}%`, background: CATEGORY_COLORS[cat] || '#6b7280' }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActiveUsers({ users, sortCol, sortDir, onSort, onSelectUser }: {
  users: UserSummary[]; sortCol: SortCol; sortDir: 'asc' | 'desc';
  onSort: (col: SortCol) => void; onSelectUser: (user: string) => void;
}) {
  const sorted = useMemo(() => {
    const arr = [...users];
    arr.sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      const cmp = typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [users, sortCol, sortDir]);

  const header = (col: SortCol, label: string) => (
    <th
      key={col}
      onClick={() => onSort(col)}
      className="adash-th"
      /* eslint-disable-next-line local/no-inline-style -- dynamic: textAlign per column, color from active sort */
      style={{
        textAlign: col === 'user' || col === 'topCategory' ? 'left' : 'right',
        color: sortCol === col ? 'var(--text-primary)' : 'var(--text-muted)',
      }}
    >
      {label} {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="adash-users-panel">
      <div className="adash-panel-title">Active Users</div>
      <table className="adash-users-table">
        <thead><tr>
          {header('user', 'User')}
          {header('lastActive', 'Last Active')}
          {header('sessions', 'Sessions')}
          {header('events', 'Events')}
          {header('topCategory', 'Top Feature')}
        </tr></thead>
        <tbody>
          {sorted.map(u => (
            <tr key={u.user} onClick={() => onSelectUser(u.user)} className="adash-clickable"
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}>
              <td className="adash-td-user" title={u.user}>{u.user}</td>
              <td className="adash-td-num-nowrap" title={u.lastActive}>{relativeTime(u.lastActive)}</td>
              <td className="adash-td-num">{u.sessions}</td>
              <td className="adash-td-num">{u.events}</td>
              <td className="adash-td">
                <span
                  className="adash-cat-badge"
                  /* eslint-disable-next-line local/no-inline-style -- dynamic: badge colors from category */
                  style={{ background: `${CATEGORY_COLORS[u.topCategory] || '#6b7280'}22`, color: CATEGORY_COLORS[u.topCategory] || '#6b7280' }}
                >
                  {u.topCategory}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionExplorer({ from, to, selectedUser, categoryFilter }: {
  from: string; to: string; selectedUser: string | null; categoryFilter: string | null;
}) {
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [sessions, setSessions] = useState<string[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load sessions for selected user
  useEffect(() => {
    if (!selectedUser) { setSessions([]); setEvents([]); return; }
    setLoading(true);
    bridgeGet<{ events: RawEvent[] }>(`/api/analytics/query?from=${from}&to=${to}&user=${encodeURIComponent(selectedUser)}`)
      .then((data) => {
        const ids = [...new Set(data.events.map(e => e.session_id))];
        setSessions(ids);
        setSelectedSession(ids[0] || null);
        setEvents(data.events);
        setLoading(false);
      })
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'analytics-dashboard',
          level: 'warn',
          message: 'Failed to load analytics events — showing empty result',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setLoading(false);
      });
  }, [selectedUser, from, to]);

  const filtered = useMemo(() => {
    let evts = events;
    if (selectedSession) evts = evts.filter(e => e.session_id === selectedSession);
    if (categoryFilter) evts = evts.filter(e => e.category === categoryFilter);
    return evts.slice(0, 500);
  }, [events, selectedSession, categoryFilter]);

  return (
    <div className="adash-session-panel">
      <div className="adash-session-head">
        <div className="adash-session-title">Session Explorer</div>
        {selectedUser && (
          <span className="adash-session-user-pill">
            {selectedUser}
          </span>
        )}
        {sessions.length > 1 && (
          <select
            value={selectedSession || ''}
            onChange={e => setSelectedSession(e.target.value || null)}
            className="adash-session-select"
          >
            {sessions.map(s => <option key={s} value={s}>{s.slice(0, 8)}...</option>)}
          </select>
        )}
        {categoryFilter && (
          <span
            className="adash-cat-badge-2xs"
            /* eslint-disable-next-line local/no-inline-style -- dynamic: badge colors from category */
            style={{ background: `${CATEGORY_COLORS[categoryFilter] || '#6b7280'}22`, color: CATEGORY_COLORS[categoryFilter] || '#6b7280' }}
          >
            {categoryFilter}
          </span>
        )}
      </div>

      {!selectedUser && (
        <div className="adash-session-empty">
          Click a user in the Active Users table to explore their sessions.
        </div>
      )}

      {loading && <div className="adash-session-loading">Loading...</div>}

      {selectedUser && !loading && filtered.length === 0 && (
        <div className="adash-session-loading">No events found.</div>
      )}

      {filtered.length > 0 && (
        <div className="adash-session-list">
          {filtered.map((evt, i) => {
            const time = new Date(evt.timestamp).toLocaleTimeString('en-US', { hour12: false });
            const detailStr = Object.entries(evt.detail)
              .filter(([k]) => !k.startsWith('_'))
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join(', ');
            return (
              <div
                key={i}
                className="adash-event-row"
                /* eslint-disable-next-line local/no-inline-style -- dynamic: zebra striping by row index */
                style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg-primary)' }}
              >
                <span className="adash-event-time">{time}</span>
                <span
                  className="adash-event-type"
                  /* eslint-disable-next-line local/no-inline-style -- dynamic: badge colors from category */
                  style={{ background: `${CATEGORY_COLORS[evt.category] || '#6b7280'}22`, color: CATEGORY_COLORS[evt.category] || '#6b7280' }}
                >
                  {evt.event_type}
                </span>
                <span className="adash-event-detail">
                  {detailStr}
                </span>
                {evt.duration_ms != null && (
                  <span className="adash-event-duration">({fmtEventDurationSeconds(evt.duration_ms)})</span>
                )}
              </div>
            );
          })}
          {events.length > 500 && (
            <div className="adash-session-more">
              Showing first 500 of {events.length} events
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A single exclusion toggle button, same visual idiom as the preset/compare buttons. */
function ExclusionToggle({ label, title, active, onClick }: {
  label: string; title: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!EXCLUSION_TOGGLES_ENABLED}
      title={title}
      aria-pressed={active}
      className="adash-chip adash-exclusion-btn">
      {label}
    </button>
  );
}

/**
 * t/4961: the dashboard's half of t/4960/t/4962's exclusion contract. Rendered disabled with
 * an explanatory caption until the server side lands (Design, p/708#15) — "a disabled control
 * with an honest caption... the 'why' is visible instead of silent." Flip EXCLUSION_TOGGLES_ENABLED
 * and remove the caption once it does; nothing else here changes.
 */
function ExclusionToggles({ includeInternal, setIncludeInternal, includeSystem, setIncludeSystem, includeListed, setIncludeListed }: {
  includeInternal: boolean; setIncludeInternal: (v: boolean) => void;
  includeSystem: boolean; setIncludeSystem: (v: boolean) => void;
  includeListed: boolean; setIncludeListed: (v: boolean) => void;
}) {
  return (
    <div className="adash-exclusion-row">
      <ExclusionToggle
        label="Show internal/test traffic" title="Include events tagged internal (tester cookie)"
        active={includeInternal} onClick={() => setIncludeInternal(!includeInternal)}
      />
      <ExclusionToggle
        label="Show system checks" title="Include system identities such as smoke-probe"
        active={includeSystem} onClick={() => setIncludeSystem(!includeSystem)}
      />
      <ExclusionToggle
        label="Show flagged sessions" title="Include sessions on the known staging-leak/pi-test list"
        active={includeListed} onClick={() => setIncludeListed(!includeListed)}
      />
      {!EXCLUSION_TOGGLES_ENABLED && (
        <span className="adash-exclusion-caption">Requires t/4960/t/4962 — not yet available.</span>
      )}
    </div>
  );
}

// ── Main Dashboard ──

type AnalyticsTab = 'overview' | 'hierarchy';

function OverviewBody({ data, prevData, compare, from, to, selectedUser, categoryFilter, sortCol, sortDir, onSort, onSelectUser, onFilter }: {
  data: QueryResult; prevData: QueryResult['summary'] | null; compare: boolean;
  from: string; to: string; selectedUser: string | null; categoryFilter: string | null;
  sortCol: SortCol; sortDir: 'asc' | 'desc';
  onSort: (col: SortCol) => void; onSelectUser: (u: string) => void; onFilter: (cat: string) => void;
}) {
  if (data.summary.totalEvents === 0) {
    return (
      <div className="adash-empty">
        <div className="adash-empty-title">No analytics data available</div>
        <div className="adash-empty-sub">Events will appear as users interact with the app.</div>
      </div>
    );
  }
  const sessionsDeltaPct = compare && prevData && prevData.sessions > 0
    ? ((data.summary.sessions - prevData.sessions) / prevData.sessions) * 100
    : null;
  return (
    <>
      <SystemOverviewRow usage={{ sessions: data.summary.sessions, sessionsDeltaPct }} />
      <SummaryCards data={data.summary} previous={compare ? prevData : null} />
      <div className="adash-cards-row">
        <DebateHealthCard eventTypes={data.eventTypes} />
        <AICostCard aiCost={data.aiCost} debateCount={data.eventTypes?.['debate.complete']} />
      </div>
      <ActivityChart daily={data.daily} />
      <DebateFunnelChart eventTypes={data.eventTypes} />
      <div className="adash-panels-row">
        <FeatureUsage usage={data.featureUsage} onFilter={onFilter} />
        <ActiveUsers users={data.users} sortCol={sortCol} sortDir={sortDir} onSort={onSort} onSelectUser={onSelectUser} />
      </div>
      <SessionExplorer from={from} to={to} selectedUser={selectedUser} categoryFilter={categoryFilter} />
    </>
  );
}

export function AnalyticsDashboard() {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');
  const [preset, setPreset] = useState<DatePreset>('7d');
  const [data, setData] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>('lastActive');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [compare, setCompare] = useState(false);
  const [prevData, setPrevData] = useState<QueryResult['summary'] | null>(null);
  // t/4961: wired to t/4960/t/4962's contract, but rendered disabled until that lands
  // (EXCLUSION_TOGGLES_ENABLED) — see that constant's comment.
  const [includeInternal, setIncludeInternal] = useState(false);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [includeListed, setIncludeListed] = useState(false);

  const { from, to } = useMemo(() => dateRange(preset), [preset]);
  const exclusionOpts = useMemo(
    () => ({ includeInternal, includeSystem, includeListed }),
    [includeInternal, includeSystem, includeListed],
  );

  const handleSelectUser = useCallback((u: string) => setSelectedUser(prev => prev === u ? null : u), []);
  const handleFilter = useCallback((cat: string) => setCategoryFilter(prev => prev === cat ? null : cat), []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchQuery(from, to, exclusionOpts)
      .then((d) => { warnUnparseableLastActive(d.users); setData(d); setLoading(false); })
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'analytics-dashboard',
          level: 'error',
          message: 'Analytics query failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setError(String(err));
        setLoading(false);
      });
  }, [from, to, exclusionOpts]);

  // Period comparison: fetch the equal-length preceding window when enabled.
  useEffect(() => {
    if (!compare) { setPrevData(null); return; }
    let cancelled = false;
    const prev = previousRange(preset);
    fetchQuery(prev.from, prev.to)
      .then((d) => { if (!cancelled) setPrevData(d.summary); })
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'analytics-dashboard',
          level: 'warn',
          message: 'Failed to load previous-period analytics — comparison unavailable',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        if (!cancelled) setPrevData(null);
      });
    return () => { cancelled = true; };
  }, [compare, preset]);

  const handleSort = useCallback((col: SortCol) => {
    setSortCol(prev => {
      if (prev === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return col; }
      setSortDir('desc');
      return col;
    });
  }, []);

  const handleBack = () => { window.location.hash = ''; window.location.reload(); };

  return (
    <div className="adash-root">
      {/* Header */}
      <div className="adash-header">
        <div className="adash-header-left">
          <button onClick={handleBack} className="adash-back-btn">
            ← Back to Editor
          </button>
          <h1 className="adash-title">Usage Analytics</h1>
        </div>
        <div className="adash-preset-group">
          {(['1d', '7d', '30d', '90d'] as DatePreset[]).map(p => (
            <button key={p} onClick={() => { setPreset(p); setSelectedUser(null); setCategoryFilter(null); }}
              aria-pressed={preset === p}
              className="adash-chip adash-preset-btn">
              {p === '1d' ? 'Today' : `${p.replace('d', '')} days`}
            </button>
          ))}
          <button onClick={() => setCompare(c => !c)}
            title="Compare each metric with the previous period of equal length"
            aria-pressed={compare}
            className="adash-chip adash-compare-btn">
            vs. previous
          </button>
        </div>
      </div>

      <ExclusionToggles
        includeInternal={includeInternal} setIncludeInternal={setIncludeInternal}
        includeSystem={includeSystem} setIncludeSystem={setIncludeSystem}
        includeListed={includeListed} setIncludeListed={setIncludeListed}
      />

      <div className="adash-tab-bar" role="tablist">
        <button role="tab" aria-selected={activeTab === 'overview'}
          className={`adash-tab${activeTab === 'overview' ? ' adash-tab--active' : ''}`}
          onClick={() => setActiveTab('overview')}>Overview</button>
        <button role="tab" aria-selected={activeTab === 'hierarchy'}
          className={`adash-tab${activeTab === 'hierarchy' ? ' adash-tab--active' : ''}`}
          onClick={() => setActiveTab('hierarchy')}>Hierarchy</button>
      </div>

      {activeTab === 'hierarchy' && <UsageHierarchy />}

      {activeTab === 'overview' && loading && <div className="adash-loading">Loading analytics...</div>}
      {activeTab === 'overview' && error && <div className="adash-error">Failed to load analytics: {error}</div>}

      {activeTab === 'overview' && data && !loading && (
        <OverviewBody
          data={data} prevData={prevData} compare={compare}
          from={from} to={to}
          selectedUser={selectedUser} categoryFilter={categoryFilter}
          sortCol={sortCol} sortDir={sortDir}
          onSort={handleSort} onSelectUser={handleSelectUser} onFilter={handleFilter}
        />
      )}
    </div>
  );
}
