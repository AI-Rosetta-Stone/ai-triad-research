// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useMemo } from 'react';
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

type VocabSense = { standardized_term: string; when: string; default_for_camp?: string };
type VocabDefLookup = Map<string, { display: string; definition: string }>;

const POV_ORDER = ['accelerationist', 'safetyist', 'skeptic'];

function povLabel(pov: string): string {
  return pov.charAt(0).toUpperCase() + pov.slice(1);
}

function VocabPovLabel({ pov }: { pov: string }) {
  return (
    <span
      className="vocab-def-camp"
      // eslint-disable-next-line local/no-inline-style -- color pulled from POV_COLOR_VAR lookup at runtime
      style={{ color: POV_COLOR_VAR[pov] ?? 'var(--text-muted)' }}
    >
      {povLabel(pov)}
    </span>
  );
}

function VocabDefRow({ rt, active, defLookup, navigateToLineage }: {
  rt: VocabSense;
  active?: boolean;
  defLookup?: VocabDefLookup;
  navigateToLineage: (value: string) => void;
}) {
  const def = defLookup?.get(rt.standardized_term);
  const displayText = def?.display ?? rt.standardized_term;
  return (
    <div className={active ? 'vocab-def vocab-def-active' : 'vocab-def'}>
      <div className="vocab-def-header">
        <a
          href="#"
          className={active ? 'vocab-def-link vocab-def-link-active' : 'vocab-def-link'}
          title={`Go to "${displayText}" in Lineage Panel`}
          onClick={(ev) => { ev.preventDefault(); navigateToLineage(rt.standardized_term); }}
        >
          {displayText}
        </a>
        {rt.when && <span className="vocab-def-when">{rt.when}</span>}
      </div>
      {def?.definition ? (
        <div className={active ? 'vocab-def-text vocab-def-text-active' : 'vocab-def-text'}>
          {def.definition}
        </div>
      ) : (
        <div className="vocab-def-missing">No definition in the dictionary</div>
      )}
    </div>
  );
}

/** Groups senses by POV in POV_ORDER, then any other camps, then senses with no camp. */
function groupSensesByPov(senses: VocabSense[]): { pov?: string; senses: VocabSense[] }[] {
  const byPov = new Map<string, VocabSense[]>();
  const unlabelled: VocabSense[] = [];
  for (const rt of senses) {
    if (!rt.default_for_camp) { unlabelled.push(rt); continue; }
    const list = byPov.get(rt.default_for_camp) ?? [];
    list.push(rt);
    byPov.set(rt.default_for_camp, list);
  }
  const povs = [...byPov.keys()].sort((a, b) => {
    const ia = POV_ORDER.indexOf(a), ib = POV_ORDER.indexOf(b);
    return (ia === -1 ? POV_ORDER.length : ia) - (ib === -1 ? POV_ORDER.length : ib) || a.localeCompare(b);
  });
  const groups: { pov?: string; senses: VocabSense[] }[] = povs.map(pov => ({ pov, senses: byPov.get(pov)! }));
  if (unlabelled.length > 0) groups.push({ senses: unlabelled });
  return groups;
}

function VocabOwnSense({ sense, pov, defLookup, navigateToLineage }: {
  sense: VocabSense;
  pov?: string;
  defLookup?: VocabDefLookup;
  navigateToLineage: (value: string) => void;
}) {
  return (
    <div className="vocab-section vocab-section-own">
      <div className="vocab-section-label">
        {pov ? <><VocabPovLabel pov={pov} /> view</> : 'Speaker’s view'}
      </div>
      <VocabDefRow rt={sense} active defLookup={defLookup} navigateToLineage={navigateToLineage} />
    </div>
  );
}

function VocabOtherSenses({ label, senses, defLookup, navigateToLineage }: {
  label: string;
  senses: VocabSense[];
  defLookup?: VocabDefLookup;
  navigateToLineage: (value: string) => void;
}) {
  return (
    <div className="vocab-section vocab-section-other">
      <div className="vocab-section-label">{label}</div>
      {groupSensesByPov(senses).map((g, gi) => (
        <div key={g.pov ?? `other-${gi}`} className="vocab-pov-group">
          <div className="vocab-pov-group-label">
            {g.pov ? <VocabPovLabel pov={g.pov} /> : <span className="vocab-def-camp vocab-def-camp-none">Other sense</span>}
          </div>
          {g.senses.map((rt, j) => (
            <VocabDefRow key={j} rt={rt} defLookup={defLookup} navigateToLineage={navigateToLineage} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function VocabTermCard({ bare, dict, resolved, defLookup, navigateToLineage, sourceSentence, speakerPov }: {
  bare: string;
  dict?: { resolves_to: VocabSense[]; ambiguous_when?: string[] };
  resolved?: string;
  defLookup?: VocabDefLookup;
  navigateToLineage: (value: string) => void;
  sourceSentence?: string;
  /** The speaker's POV (e.g. 'accelerationist'); labels the own-view section. */
  speakerPov?: string;
}) {
  const senses = dict?.resolves_to ?? [];
  const ownSense: VocabSense | undefined = resolved
    ? senses.find(rt => rt.standardized_term === resolved) ?? { standardized_term: resolved, when: '' }
    : undefined;
  const otherSenses = ownSense ? senses.filter(rt => rt.standardized_term !== resolved) : senses;
  return (
    <div className="vocab-term-card">
      <div className="vocab-term-name">{bare}</div>
      {sourceSentence && (
        <div className="vocab-source-sentence">
          &ldquo;{sourceSentence}&rdquo;
        </div>
      )}
      {ownSense && (
        <VocabOwnSense sense={ownSense} pov={speakerPov ?? ownSense.default_for_camp} defLookup={defLookup} navigateToLineage={navigateToLineage} />
      )}
      {otherSenses.length > 0 && (
        <VocabOtherSenses
          label={ownSense ? 'Other POVs’ views' : 'Candidate senses'}
          senses={otherSenses}
          defLookup={defLookup}
          navigateToLineage={navigateToLineage}
        />
      )}
      {dict?.ambiguous_when && dict.ambiguous_when.length > 0 && (
        <div className="vocab-ambiguous-when">
          Ambiguous when: {dict.ambiguous_when.join('; ')}
        </div>
      )}
    </div>
  );
}

export function VocabTermsView({ resolutions, ambiguities, statementText, speakerPov }: {
  resolutions: VocabResolution[];
  ambiguities?: { colloquial: string; offset?: number }[];
  statementText?: string;
  /** The speaker's POV (e.g. 'accelerationist'); labels each card's own-view section. */
  speakerPov?: string;
}) {
  const vocabTerms = useDebateStore(s => s.vocabularyTerms?.colloquial);
  const stdTerms = useDebateStore(s => s.vocabularyTerms?.standardized);
  const navigateToLineage = useTaxonomyStore(s => s.navigateToLineage);

  // Build lookup from full dictionary (shared between entries and ambiguities)
  const dictLookup = useMemo(() => {
    const lookup = new Map<string, { resolves_to: VocabSense[]; ambiguous_when?: string[] }>();
    if (vocabTerms) {
      for (const ct of vocabTerms) {
        const entry = ct as { colloquial_term: string; resolves_to: VocabSense[]; translation_ambiguous_when?: string[] };
        lookup.set(entry.colloquial_term.toLowerCase(), { resolves_to: entry.resolves_to, ambiguous_when: entry.translation_ambiguous_when });
      }
    }
    return lookup;
  }, [vocabTerms]);

  // Build canonical_form → definition lookup from standardized terms. Terms without a
  // definition keep their display form; VocabDefRow marks the missing definition (t/38).
  const defLookup = useMemo(() => {
    const lookup: VocabDefLookup = new Map();
    if (stdTerms) {
      for (const st of stdTerms) {
        const entry = st as { canonical_form: string; display_form?: string; definition?: string };
        if (entry.canonical_form) {
          lookup.set(entry.canonical_form, { display: entry.display_form || entry.canonical_form, definition: entry.definition ?? '' });
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
        <VocabTermCard key={i} bare={e.bare} dict={e.dict} resolved={e.resolved} defLookup={defLookup} navigateToLineage={navigateToLineage} sourceSentence={e.sourceSentence} speakerPov={speakerPov} />
      ))}
      {ambiguities && ambiguities.length > 0 && (() => {
        // First occurrence of each term supplies the offset for its quote.
        const firstByTerm = new Map<string, { colloquial: string; offset?: number }>();
        for (const a of ambiguities) {
          if (!firstByTerm.has(a.colloquial)) firstByTerm.set(a.colloquial, a);
        }
        const uniqueTerms = [...firstByTerm.keys()].sort((a, b) => a.localeCompare(b));
        return (
          <div className="vocab-ambiguous-block">
            <div className="vocab-ambiguous-header">Ambiguous meaning — could be any of these:</div>
            {uniqueTerms.map((term, i) => (
              <VocabTermCard
                key={i}
                bare={term}
                dict={dictLookup.get(term.toLowerCase())}
                defLookup={defLookup}
                navigateToLineage={navigateToLineage}
                sourceSentence={statementText ? extractSentence(statementText, term, firstByTerm.get(term)?.offset) : undefined}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}
