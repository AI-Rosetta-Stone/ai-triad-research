// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useMemo } from 'react';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { extractLineageNames } from '../../utils/lineageMatcher';
import { getLineageInfo, getAllLineages } from '../../data/lineageLookup';
import { api } from '@bridge';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';
import { POV_COLOR_VAR } from './utils';
import './VocabularyPanel.css';

function extractSentence(text: string, term: string, offset?: number): string | undefined {
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (offset != null) {
    let pos = 0;
    for (const s of sentences) {
      if (offset >= pos && offset < pos + s.length) return s;
      pos += s.length + 1;
    }
  }
  const lower = term.toLowerCase();
  return sentences.find(s => s.toLowerCase().includes(lower));
}

function depluralize(s: string): string {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('xes') || s.endsWith('ses') || s.endsWith('shes') || s.endsWith('ches') || s.endsWith('zes'))
    return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

function upgradeLineageNames(names: string[]): string[] {
  const all = getAllLineages();
  const allKeys = Object.keys(all);
  return names.map(name => {
    const info = getLineageInfo(name);
    if (info?.summary) return name;
    const stem = depluralize(name.toLowerCase());
    let best: { key: string; len: number } | null = null;
    for (const k of allKeys) {
      const entry = all[k];
      if (!entry?.summary) continue;
      const kl = k.toLowerCase();
      if (kl.startsWith(stem) && (!best || k.length < best.len)) {
        best = { key: k, len: k.length };
      }
    }
    return best ? best.key : name;
  });
}

export function LineageTermsView({ content }: { content: string }) {
  const rawNames = useMemo(() => extractLineageNames(content), [content]);
  const names = useMemo(() => {
    const upgraded = upgradeLineageNames(rawNames);
    return [...new Set(upgraded)];
  }, [rawNames]);
  if (names.length === 0) return <div className="vocab-lineage-empty">No lineage references found</div>;
  return (
    <div className="vocab-view">
      <div className="vocab-count">
        {names.length} lineage reference{names.length !== 1 ? 's' : ''}
      </div>
      {names.map((name, i) => {
        const info = getLineageInfo(name);
        return (
          <div key={i} className="vocab-lineage-item">
            <div className="vocab-term-name">{name}</div>
            {info?.summary && (
              <div className="vocab-lineage-summary">
                {info.summary}
              </div>
            )}
            {info?.example && (
              <div className="vocab-lineage-example">
                <span className="vocab-lineage-example-label">Example:</span> {info.example}
              </div>
            )}
            {info?.links && info.links.length > 0 && (
              <div className="vocab-lineage-links">
                {info.links.map((link, li) => (
                  <a
                    key={li}
                    href="#"
                    onClick={(e) => { e.preventDefault(); void api.openExternal(link.url); }}
                    title={link.url}
                    className="vocab-lineage-link"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function VocabDefRow({ rt, resolved, defLookup, navigateToLineage }: {
  rt: { standardized_term: string; when: string; default_for_camp?: string };
  resolved?: string;
  defLookup?: Map<string, { display: string; definition: string }>;
  navigateToLineage: (value: string) => void;
}) {
  const isHighlighted = resolved != null && rt.standardized_term === resolved;
  const def = defLookup?.get(rt.standardized_term);
  const displayText = def?.display ?? rt.standardized_term;
  return (
    <div className={isHighlighted ? 'vocab-def vocab-def-active' : 'vocab-def'}>
      <div className="vocab-def-header">
        {isHighlighted && (
          <span className="vocab-active-badge">
            active
          </span>
        )}
        <a
          href="#"
          className={isHighlighted ? 'vocab-def-link vocab-def-link-active' : 'vocab-def-link'}
          title={`Go to "${displayText}" in Lineage Panel`}
          onClick={(ev) => { ev.preventDefault(); navigateToLineage(rt.standardized_term); }}
        >
          {displayText}
        </a>
        {rt.when && <span className="vocab-def-when">{rt.when}</span>}
        {rt.default_for_camp && (
          <span
            className="vocab-def-camp"
            // eslint-disable-next-line local/no-inline-style -- color pulled from POV_COLOR_VAR lookup at runtime
            style={{ color: POV_COLOR_VAR[rt.default_for_camp] ?? 'var(--text-muted)' }}
          >
            {rt.default_for_camp}
          </span>
        )}
      </div>
      {def?.definition && (
        <div className={isHighlighted ? 'vocab-def-text vocab-def-text-active' : 'vocab-def-text'}>
          {def.definition}
        </div>
      )}
    </div>
  );
}

export function VocabTermCard({ bare, dict, resolved, defLookup, navigateToLineage, sourceSentence }: {
  bare: string;
  dict?: { resolves_to: { standardized_term: string; when: string; default_for_camp?: string }[]; ambiguous_when?: string[] };
  resolved?: string;
  defLookup?: Map<string, { display: string; definition: string }>;
  navigateToLineage: (value: string) => void;
  sourceSentence?: string;
}) {
  return (
    <div className="vocab-term-card">
      <div className="vocab-term-name">{bare}</div>
      {sourceSentence && (
        <div className="vocab-source-sentence">
          &ldquo;{sourceSentence}&rdquo;
        </div>
      )}
      {dict?.resolves_to.map((rt, j) => (
        <VocabDefRow key={j} rt={rt} resolved={resolved} defLookup={defLookup} navigateToLineage={navigateToLineage} />
      ))}
      {!dict && resolved && (() => {
        const def = defLookup?.get(resolved);
        return (
          <div className="vocab-def vocab-def-active">
            <div className="vocab-def-header">
              <span className="vocab-active-badge">
                active
              </span>
              <a
                href="#"
                className="vocab-def-link-solo"
                title={`Go to "${def?.display ?? resolved}" in Lineage Panel`}
                onClick={(ev) => { ev.preventDefault(); navigateToLineage(resolved); }}
              >
                {def?.display ?? resolved}
              </a>
            </div>
            {def?.definition && (
              <div className="vocab-def-text vocab-def-text-active">
                {def.definition}
              </div>
            )}
          </div>
        );
      })()}
      {dict?.ambiguous_when && dict.ambiguous_when.length > 0 && (
        <div className="vocab-ambiguous-when">
          Ambiguous when: {dict.ambiguous_when.join('; ')}
        </div>
      )}
    </div>
  );
}

export function VocabTermsView({ resolutions, ambiguities, statementText }: {
  resolutions: VocabResolution[];
  ambiguities?: { colloquial: string; offset?: number }[];
  statementText?: string;
}) {
  const vocabTerms = useDebateStore(s => s.vocabularyTerms?.colloquial);
  const stdTerms = useDebateStore(s => s.vocabularyTerms?.standardized);
  const navigateToLineage = useTaxonomyStore(s => s.navigateToLineage);
  const hasDictionary = useDebateStore(s => s.vocabularyTerms != null);
  const activeDebateId = useDebateStore(s => s.activeDebateId);
  const ensureVocabulary = useDebateStore(s => s.ensureVocabulary);

  // t/39: an empty or failed dictionary load (hosted /api/dictionary returns [] on a GitHub
  // timeout) is not cached, so retry when a vocabulary view opens instead of showing raw sense
  // IDs until the next debate load. ensureVocabulary shares in-flight fetches and never rejects.
  useEffect(() => {
    if (!hasDictionary) void ensureVocabulary();
  }, [activeDebateId, hasDictionary, ensureVocabulary]);

  // Build lookup from full dictionary (shared between entries and ambiguities)
  const dictLookup = useMemo(() => {
    const lookup = new Map<string, { resolves_to: { standardized_term: string; when: string; default_for_camp?: string }[]; ambiguous_when?: string[] }>();
    if (vocabTerms) {
      for (const ct of vocabTerms) {
        const entry = ct as { colloquial_term: string; resolves_to: { standardized_term: string; when: string; default_for_camp?: string }[]; translation_ambiguous_when?: string[] };
        lookup.set(entry.colloquial_term.toLowerCase(), { resolves_to: entry.resolves_to, ambiguous_when: entry.translation_ambiguous_when });
      }
    }
    return lookup;
  }, [vocabTerms]);

  // Build canonical_form → definition lookup from standardized terms
  const defLookup = useMemo(() => {
    const lookup = new Map<string, { display: string; definition: string }>();
    if (stdTerms) {
      for (const st of stdTerms) {
        const entry = st as { canonical_form: string; display_form: string; definition: string };
        if (entry.canonical_form && entry.definition) {
          lookup.set(entry.canonical_form, { display: entry.display_form, definition: entry.definition });
        }
      }
    }
    return lookup;
  }, [stdTerms]);

  // Build unique colloquial terms from this entry's resolutions, then enrich with full dictionary data
  const entries = useMemo(() => {
    const seen = new Set<string>();
    const bareTerms: string[] = [];
    for (const r of resolutions) {
      const key = r.colloquial.toLowerCase();
      if (!seen.has(key)) { seen.add(key); bareTerms.push(r.colloquial); }
    }
    bareTerms.sort((a, b) => a.localeCompare(b));

    return bareTerms.map(term => {
      const res = resolutions.find(r => r.colloquial.toLowerCase() === term.toLowerCase());
      return {
        bare: term,
        dict: dictLookup.get(term.toLowerCase()),
        resolved: res?.canonical,
        sourceSentence: statementText ? extractSentence(statementText, term, res?.offset) : undefined,
      };
    });
  }, [resolutions, dictLookup, statementText]);

  return (
    <div className="vocab-view">
      <div className="vocab-count">
        {entries.length} term{entries.length !== 1 ? 's' : ''} resolved
        {ambiguities && ambiguities.length > 0 && (
          <span className="vocab-ambiguous-count"> · {new Set(ambiguities.map(a => a.colloquial)).size} ambiguous</span>
        )}
      </div>
      {entries.map((e, i) => (
        <VocabTermCard key={i} bare={e.bare} dict={e.dict} resolved={e.resolved} defLookup={defLookup} navigateToLineage={navigateToLineage} sourceSentence={e.sourceSentence} />
      ))}
      {ambiguities && ambiguities.length > 0 && (() => {
        const uniqueTerms = [...new Set(ambiguities.map(a => a.colloquial))].sort((a, b) => a.localeCompare(b));
        return (
          <div className="vocab-ambiguous-block">
            <div className="vocab-ambiguous-header">Ambiguous meaning — could be any of these:</div>
            {uniqueTerms.map((term, i) => (
              <VocabTermCard key={i} bare={term} dict={dictLookup.get(term.toLowerCase())} defLookup={defLookup} navigateToLineage={navigateToLineage} />
            ))}
          </div>
        );
      })()}
    </div>
  );
}
