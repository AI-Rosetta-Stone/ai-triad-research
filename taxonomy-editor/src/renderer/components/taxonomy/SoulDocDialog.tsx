// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The soul-document dialog opened from NodeDetail's 📜 button (moved out of PovTab.tsx for t/4200).
// One tab for the camp's base soul plus one per POV tag in pov-tags.json (Skeptic: Critical, Institutional).
// A POV with no tags shows no tab strip, exactly as before. Souls come from the browser-safe resolver.

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { resolvePoverInfo } from '@lib/debate/tagSoulRegistry';
import { loadPovTagRegistry, tagSoulFileName } from '@lib/schema/povTags';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { PovInfo, SpeakerId } from '@lib/debate/types';
import './SoulDocDialog.css';

type Speaker = Exclude<SpeakerId, 'user'>;

/** Taxonomy POV name → soul speaker key (identity map after the speaker rename). */
const POV_TO_SPEAKER: Record<string, Speaker> = {
  accelerationist: 'accelerationist',
  safetyist: 'safetyist',
  skeptic: 'skeptic',
};

const BASE_TAB = '__base__';

interface SoulTab {
  id: string;
  label: string;
  description?: string;
}

type TabContent = { soul: PovInfo } | { missing: string };

function resolveTab(speaker: Speaker, tabId: string): TabContent {
  if (tabId === BASE_TAB) return { soul: resolvePoverInfo(speaker).soul };
  try {
    // The mode only affects how debates use the tag, not the soul's content.
    return { soul: resolvePoverInfo(speaker, { tag: tabId, mode: 'scope' }).soul };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'soul-doc-dialog', level: 'warn',
      message: `Soul document not found for ${speaker}:${tabId}; showing the not-found message`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { missing: tagSoulFileName(speaker, tabId) };
  }
}

function SoulBody({ soul }: { soul: PovInfo }) {
  const rec = soul as unknown as Record<string, unknown>;
  const voice = rec.voice as Record<string, string> | undefined;
  const antiPatterns = rec.anti_patterns as string[] | undefined;
  const valueHierarchy = rec.value_hierarchy as string[] | undefined;
  const epistemicStance = rec.epistemic_stance as string[] | undefined;
  const boundaries = soul.boundaries ?? { hardcoded: [], softcoded: [] };
  return (
    <>
      <div className="soul-doc-personality">{soul.personality}</div>

      {voice && (
        <section className="soul-doc-section">
          <h3 className="soul-doc-section-title">Voice</h3>
          <div className="soul-doc-field"><strong>Disposition:</strong> {voice.disposition}</div>
          <div className="soul-doc-field"><strong>Style:</strong> {voice.style}</div>
          <div className="soul-doc-field"><strong>Reasoning:</strong> {voice.reasoning}</div>
          <div className="soul-doc-field"><strong>Evidence:</strong> {voice.evidence}</div>
          <div className="soul-doc-field"><strong>Signature:</strong> {voice.signature}</div>
        </section>
      )}

      {valueHierarchy && valueHierarchy.length > 0 && (
        <section className="soul-doc-section">
          <h3 className="soul-doc-section-title">Value Hierarchy</h3>
          <ol className="soul-doc-list">{valueHierarchy.map((v, i) => <li key={i}>{v}</li>)}</ol>
        </section>
      )}

      {epistemicStance && epistemicStance.length > 0 && (
        <section className="soul-doc-section">
          <h3 className="soul-doc-section-title">Epistemic Stance</h3>
          <ul className="soul-doc-list">{epistemicStance.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </section>
      )}

      {(boundaries.hardcoded.length > 0 || boundaries.softcoded.length > 0) && (
        <section className="soul-doc-section">
          <h3 className="soul-doc-section-title">Boundaries</h3>
          {boundaries.hardcoded.length > 0 && (
            <div className="soul-doc-boundary-group">
              <div className="soul-doc-boundary-label soul-doc-boundary-label-hard">Identity (never concede)</div>
              <ul className="soul-doc-list">{boundaries.hardcoded.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
          {boundaries.softcoded.length > 0 && (
            <div>
              <div className="soul-doc-boundary-label soul-doc-boundary-label-soft">Default (can evolve)</div>
              <ul className="soul-doc-list">{boundaries.softcoded.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      {antiPatterns && antiPatterns.length > 0 && (
        <section>
          <h3 className="soul-doc-section-title">Anti-Patterns</h3>
          <ul className="soul-doc-list">{antiPatterns.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </section>
      )}
    </>
  );
}

export interface SoulDocDialogProps {
  pov: string;
  /** The selected node's pov_tags: the dialog opens on the first one that has a tab. */
  nodeTags?: readonly string[];
  onClose: () => void;
}

export function SoulDocDialog({ pov, nodeTags, onClose }: SoulDocDialogProps) {
  const speaker = POV_TO_SPEAKER[pov.toLowerCase()];
  const tabs = useMemo<SoulTab[]>(() => {
    if (!speaker) return [];
    const tagTabs = (loadPovTagRegistry().povs[speaker] ?? []).map(t => ({ id: t.id, label: t.label, description: t.description }));
    return [{ id: BASE_TAB, label: resolvePoverInfo(speaker).soul.label }, ...tagTabs];
  }, [speaker]);
  const [active, setActive] = useState(() => nodeTags?.find(t => tabs.some(tab => tab.id === t)) ?? BASE_TAB);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const content = useMemo(() => (speaker ? resolveTab(speaker, active) : null), [speaker, active]);

  if (!speaker || !content) return null;
  const base = resolvePoverInfo(speaker).soul;
  const activeTab = tabs.find(t => t.id === active);
  const showTabs = tabs.length > 1;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const target = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + step + tabs.length) % tabs.length;
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setActive(tabs[target].id);
    tabRefs.current[target]?.focus();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="soul-doc-dialog" role="dialog" aria-modal="true" aria-label={`${base.label} soul document`} onClick={e => e.stopPropagation()}>
        <div className="soul-doc-header">
          <h2 className="soul-doc-title">{base.label} Soul Document</h2>
          <button className="btn btn-ghost soul-doc-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {showTabs && (
          <div className="soul-doc-tabs" role="tablist" aria-label={`${base.label} soul documents`}>
            {tabs.map((tab, i) => (
              <button
                key={tab.id}
                ref={el => { tabRefs.current[i] = el; }}
                id={`soul-doc-tab-${tab.id}`}
                role="tab"
                type="button"
                className={`soul-doc-tab${tab.id === active ? ' active' : ''}`}
                aria-selected={tab.id === active}
                aria-controls="soul-doc-panel"
                tabIndex={tab.id === active ? 0 : -1}
                onClick={() => setActive(tab.id)}
                onKeyDown={e => onTabKey(e, i)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div id="soul-doc-panel" role={showTabs ? 'tabpanel' : undefined} aria-labelledby={showTabs ? `soul-doc-tab-${active}` : undefined}>
          {activeTab?.description && <p className="soul-doc-tab-description">{activeTab.description}</p>}
          {'soul' in content
            ? <SoulBody soul={content.soul} />
            : (
              <p className="soul-doc-missing" role="alert">
                Soul document not found: <code>{content.missing}</code>. Add it under <code>lib/debate/soul-docs/</code> and rebuild.
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
