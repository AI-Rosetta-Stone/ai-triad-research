// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import './PhrasesPanel.css';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { TheoryLink } from '../shared/TheoryLink';

// ── Types ──

interface SyntheticEntry {
  node_id: string;
  statement: string;
  archetype: string;
  audience: string | null;
  model: string;
  pruned: boolean;
  prune_reason: string | null;
  rationale: string;
}

interface SyntheticCorpus {
  pov: string;
  entries: SyntheticEntry[];
}

interface LegacyClaim {
  text: string;
  node_id: string;
  source: string;
  weight: number;
}

interface LegacyCorpusFile {
  pairs: LegacyClaim[];
}

const ARCHETYPE_LABELS: Record<string, string> = {
  surface_claim: 'Surface Claims',
  assumption_expression: 'Assumption Expressions',
  defensive_formulation: 'Defensive Formulations',
  counterargument_response: 'Counterargument Responses',
  policy_implication: 'Policy Implications',
  intellectual_lineage: 'Intellectual Lineage',
  real_world_example: 'Real-World Examples',
};

const ARCHETYPE_ORDER = Object.keys(ARCHETYPE_LABELS);

const AUDIENCE_LABELS: Record<string, string> = {
  industry_leader: 'Industry',
  policymaker: 'Policy',
  technical_researcher: 'Technical',
};

// ── Module-level cache (one per POV key) ──

const _syntheticCache = new Map<string, SyntheticEntry[]>();
let _legacyCache: LegacyClaim[] | null = null;
let _legacyLoading = false;
const _legacyListeners: Array<() => void> = [];

/** Test seam: empty both module-level caches (mirrors SourcesPanel's __resetSourcesCacheForTests). */
export function __resetPhrasesCacheForTests(): void {
  _syntheticCache.clear();
  _legacyCache = null;
  _legacyLoading = false;
  _legacyListeners.length = 0;
}

function povKeyFromNodeId(nodeId: string): string | null {
  const prefix = nodeId.split('-')[0];
  const map: Record<string, string> = { acc: 'acc', saf: 'saf', skp: 'skp' };
  return map[prefix] ?? null;
}

async function loadSyntheticForPov(povKey: string): Promise<SyntheticEntry[]> {
  if (_syntheticCache.has(povKey)) return _syntheticCache.get(povKey)!;
  try {
    const data = await api.loadSyntheticCorpus(povKey) as SyntheticCorpus | null;
    const entries = data?.entries ?? [];
    _syntheticCache.set(povKey, entries);
    return entries;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'phrases-panel',
      level: 'error',
      message: `Failed to load synthetic corpus for ${povKey}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    _syntheticCache.set(povKey, []);
    return [];
  }
}

async function loadLegacyCorpus(): Promise<LegacyClaim[]> {
  if (_legacyCache) return _legacyCache;
  if (_legacyLoading) {
    return new Promise(resolve => {
      _legacyListeners.push(() => resolve(_legacyCache!));
    });
  }
  _legacyLoading = true;
  try {
    const data = await api.readResearchFile('comp-linguist/debate_claims_corpus.json') as LegacyCorpusFile | null;
    _legacyCache = data?.pairs ?? [];
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'phrases-panel',
      level: 'error',
      message: 'Failed to load legacy phrases corpus',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    _legacyCache = [];
  }
  _legacyLoading = false;
  for (const cb of _legacyListeners) cb();
  _legacyListeners.length = 0;
  return _legacyCache;
}

// ── Component ──

export function PhrasesPanel({ nodeId }: { nodeId: string }) {
  const [syntheticEntries, setSyntheticEntries] = useState<SyntheticEntry[]>([]);
  const [legacyPhrases, setLegacyPhrases] = useState<LegacyClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingSynthetic, setUsingSynthetic] = useState(false);
  const [expandedArchetypes, setExpandedArchetypes] = useState<Set<string>>(new Set());
  // t/4919: track which node we've already defaulted an archetype open for, so a re-render
  // with a new (but equal) `grouped` array doesn't reopen one the user collapsed.
  const defaultAppliedFor = useRef<string | null>(null);
  // t/4919 fix (TL review on #4648, p/356#162): the node id `syntheticEntries`/`legacyPhrases`/
  // `usingSynthetic` actually belong to. Right after `nodeId` changes, this effect hasn't run yet,
  // so those still reflect the PREVIOUS node for one render — the default-expand effect below must
  // gate on this, or it defaults open against stale data and marks the once-per-node guard
  // "applied" for the new node, permanently blocking its real first archetype.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const povKey = povKeyFromNodeId(nodeId);

    async function load() {
      if (povKey) {
        const entries = await loadSyntheticForPov(povKey);
        const nodeEntries = entries.filter(e => e.node_id === nodeId && !e.pruned);
        if (!cancelled && nodeEntries.length > 0) {
          setSyntheticEntries(nodeEntries);
          setUsingSynthetic(true);
          setLoading(false);
          setLoadedFor(nodeId);
          return;
        }
      }
      const legacy = await loadLegacyCorpus();
      if (!cancelled) {
        setLegacyPhrases(legacy.filter(p => p.node_id === nodeId));
        setUsingSynthetic(false);
        setLoading(false);
        setLoadedFor(nodeId);
      }
    }

    setLoading(true);
    setSyntheticEntries([]);
    setLegacyPhrases([]);
    setUsingSynthetic(false);
    setExpandedArchetypes(new Set());
    setLoadedFor(null);
    defaultAppliedFor.current = null;
    void load();
    return () => { cancelled = true; };
  }, [nodeId]);

  const grouped = useMemo(() => {
    if (!usingSynthetic) return null;
    const groups = new Map<string, SyntheticEntry[]>();
    for (const entry of syntheticEntries) {
      const key = entry.archetype;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }
    return [...groups.entries()].sort((a, b) => {
      const ai = ARCHETYPE_ORDER.indexOf(a[0]);
      const bi = ARCHETYPE_ORDER.indexOf(b[0]);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }, [syntheticEntries, usingSynthetic]);

  // t/4919: default the first archetype open, once per node, only on the synthetic-corpus path
  // (the legacy fallback renders a flat list with nothing to expand). `loadedFor === nodeId`
  // guards against the stale render right after a node switch (fix, p/356#162).
  useEffect(() => {
    if (loadedFor === nodeId && usingSynthetic && grouped && grouped.length > 0 && defaultAppliedFor.current !== nodeId) {
      setExpandedArchetypes(new Set([grouped[0][0]]));
      defaultAppliedFor.current = nodeId;
    }
  }, [loadedFor, usingSynthetic, grouped, nodeId]);

  const toggleArchetype = useCallback((archetype: string) => {
    setExpandedArchetypes(prev => {
      const next = new Set(prev);
      if (next.has(archetype)) next.delete(archetype);
      else next.add(archetype);
      return next;
    });
  }, []);

  const totalCount = usingSynthetic ? syntheticEntries.length : legacyPhrases.length;

  if (loading) {
    return <div className="phrases-panel-loading">Loading synthetic phrases…</div>;
  }

  if (totalCount === 0) {
    return <div className="phrases-panel-empty">No synthetic phrases for this node.</div>;
  }

  if (!usingSynthetic) {
    return (
      <div className="phrases-panel">
        <div className="phrases-panel-summary">
          {totalCount} {totalCount === 1 ? 'phrase' : 'phrases'}
          <span className="phrases-source-badge phrases-source-legacy">legacy corpus</span>
        </div>
        <div className="phrases-list">
          {legacyPhrases.map((p, i) => (
            <div key={i} className="phrases-item">
              <div className="phrases-item-text">{p.text}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="phrases-panel">
      <div className="phrases-panel-summary">
        {totalCount} synthetic {totalCount === 1 ? 'statement' : 'statements'}
        {' across '}
        {grouped!.length} {grouped!.length === 1 ? 'archetype' : 'archetypes'}
        <TheoryLink
          docPath="research/comp-linguist/docs/synthetic-phrases-theory-of-success.md"
          label="Help: synthetic phrases theory & usage"
          size={12}
        />
      </div>
      <div className="phrases-archetype-list">
        {grouped!.map(([archetype, entries]) => {
          const isExpanded = expandedArchetypes.has(archetype);
          const label = ARCHETYPE_LABELS[archetype] ?? archetype;
          return (
            <div key={archetype} className="phrases-archetype-group">
              <button
                className="phrases-archetype-header"
                onClick={() => toggleArchetype(archetype)}
                aria-expanded={isExpanded}
              >
                <span className="phrases-archetype-chevron">{isExpanded ? '▾' : '▸'}</span>
                <span className="phrases-archetype-label">{label}</span>
                <span className="phrases-archetype-count">{entries.length}</span>
              </button>
              {isExpanded && (
                <div className="phrases-archetype-entries">
                  {entries.map((entry, i) => (
                    <div key={i} className="phrases-item">
                      <div className="phrases-item-text">{entry.statement}</div>
                      {entry.audience && (
                        <span className={`phrases-audience-badge phrases-audience-${entry.audience}`}>
                          {AUDIENCE_LABELS[entry.audience] ?? entry.audience}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
