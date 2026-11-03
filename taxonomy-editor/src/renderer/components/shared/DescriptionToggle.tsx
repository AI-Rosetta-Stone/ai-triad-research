// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export type DescriptionMode = 'formal' | 'plain';

const STORAGE_KEY = 'taxonomy-editor-description-mode';

function getStoredMode(defaultMode: DescriptionMode): DescriptionMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'formal' || v === 'plain') return v;
  } catch { /* telemetry — silent by design */ }
  return defaultMode;
}

function persistMode(mode: DescriptionMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'DescriptionToggle', level: 'warn',
      message: 'Failed to persist description mode to localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** @param defaultMode Used only when nothing is stored yet (t/4574 spec §2.4: Advanced
 *  defaults to Formal there; other consumers, e.g. ReflectionsPanel, keep the original Plain default). */
export function useDescriptionMode(defaultMode: DescriptionMode = 'plain'): [DescriptionMode, (mode: DescriptionMode) => void] {
  const [mode, setModeState] = useState<DescriptionMode>(() => getStoredMode(defaultMode));

  const setMode = useCallback((m: DescriptionMode) => {
    setModeState(m);
    persistMode(m);
  }, []);

  return [mode, setMode];
}

export function resolveDescription(
  node: { description?: string; plain_description?: string | null } | null | undefined,
  mode: DescriptionMode,
): { text: string; isGenerating: boolean } {
  if (!node) return { text: '', isGenerating: false };
  if (mode === 'formal') return { text: node.description ?? '', isGenerating: false };
  if (node.plain_description) return { text: node.plain_description, isGenerating: false };
  return { text: node.description ?? '', isGenerating: true };
}

interface DescriptionToggleProps {
  mode: DescriptionMode;
  onToggle: (mode: DescriptionMode) => void;
  hasPlainDescription: boolean;
}

export function DescriptionToggle({ mode, onToggle, hasPlainDescription }: DescriptionToggleProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && e.key === 'p') {
        e.preventDefault();
        onToggle(mode === 'formal' ? 'plain' : 'formal');
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mode, onToggle]);

  return (
    <div className="description-toggle" role="radiogroup" aria-label="Description style">
      <button
        className={`description-toggle-btn${mode === 'formal' ? ' active' : ''}`}
        onClick={() => onToggle('formal')}
        role="radio"
        aria-checked={mode === 'formal'}
        title="Show formal (DOLCE) description"
      >
        Formal
      </button>
      <button
        className={`description-toggle-btn${mode === 'plain' ? ' active' : ''}`}
        onClick={() => onToggle('plain')}
        role="radio"
        aria-checked={mode === 'plain'}
        title={hasPlainDescription ? 'Show plain-language description (Alt+P)' : 'Plain version generating... (Alt+P)'}
      >
        Plain
        {mode === 'plain' && !hasPlainDescription && (
          <span className="description-toggle-generating" aria-label="generating">…</span>
        )}
      </button>
    </div>
  );
}
