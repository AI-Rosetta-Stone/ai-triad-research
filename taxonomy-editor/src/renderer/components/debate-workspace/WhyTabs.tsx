// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Per-statement Why panel tabs: BDI | Vocabulary. The caller renders this only when the
// statement has resolved vocabulary terms; with none, Why is BDI alone and shows no tab bar.

import { useRef } from 'react';
import './WhyTabs.css';

const WHY_TABS = [{ id: 'why', label: 'BDI' }, { id: 'terms', label: 'Vocabulary' }] as const;
export type WhyTabId = typeof WHY_TABS[number]['id'];

export function WhyTabs({ activeTier, onSelect, controlsId }: {
  activeTier: WhyTabId;
  onSelect: (tier: WhyTabId) => void;
  controlsId: string;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKey = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % WHY_TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + WHY_TABS.length) % WHY_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = WHY_TABS.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(WHY_TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="debate-why-tabs" role="tablist" aria-label="Why view">
      {WHY_TABS.map(({ id, label }, i) => (
        <button
          key={id}
          ref={el => { tabRefs.current[i] = el; }}
          type="button"
          role="tab"
          aria-selected={activeTier === id}
          aria-controls={controlsId}
          tabIndex={activeTier === id ? 0 : -1}
          className={`debate-why-tab${activeTier === id ? ' debate-why-tab-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); if (activeTier !== id) onSelect(id); }}
          onKeyDown={(e) => handleKey(e, i)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
