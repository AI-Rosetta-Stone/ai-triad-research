// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import './TabBar.css';
import { POV_META } from '@lib/electron-shared/povMeta';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { expectReplace } from '../../navigation';
import type { TabId } from '../../types/taxonomy';
import { CampGlyph, povToCamp } from './CampGlyph';

const TABS: { id: TabId; label: string }[] = [
  { id: 'accelerationist', label: POV_META.accelerationist.label },
  { id: 'safetyist', label: POV_META.safetyist.label },
  { id: 'skeptic', label: POV_META.skeptic.label },
];

export function TabBar() {
  const { activeTab, setActiveTab } = useTaxonomyStore();

  // A camp tab is a VIEW of Taxonomy, not a new place (t/4640 spec: "replace on a POV/camp tab
  // switch"). Switching clears the node, then the camp auto-selects its first node
  // (useAutoSelectFirstNode) — both arrivals must replace the current entry, so the switch adds
  // no Back step (Design AC8 round 2: a real camp click went from 6 to 7 entries).
  const switchCamp = (tab: TabId) => {
    expectReplace('taxonomy:none');
    setActiveTab(tab);
  };

  return (
    <div className="tab-bar" role="tablist" aria-label="POV perspectives">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          data-tab={tab.id}
          aria-selected={activeTab === tab.id}
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => switchCamp(tab.id)}
        >
          {povToCamp(tab.id) && <CampGlyph camp={povToCamp(tab.id)!} size={14} />}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
