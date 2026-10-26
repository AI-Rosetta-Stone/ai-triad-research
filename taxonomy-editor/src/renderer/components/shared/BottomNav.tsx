// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { Ellipsis } from 'lucide-react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { NAV_ITEMS } from '../../data/navConfig';
import './BottomNav.css';

interface BottomNavProps {
  onOpenMore?: () => void;
}

export function BottomNav({ onOpenMore }: BottomNavProps) {
  const breakpoint = useBreakpoint();
  const {
    activeTab, setActiveTab,
    toolbarPanel, setToolbarPanel,
    clearSimilarSearch,
  } = useTaxonomyStore();

  const navIcon = (id: string, size = 22) => {
    const Icon = NAV_ITEMS.find(i => i.id === id)?.icon;
    return Icon ? <Icon size={size} /> : null;
  };

  if (breakpoint === 'desktop' || breakpoint === 'tablet-lg') return null;

  const tab = activeTab as string;
  const isDebateContext = tab === 'debate' || tab === 'chat';
  const isPhone = breakpoint === 'phone' || breakpoint === 'phone-lg';
  const isPovTab = ['accelerationist', 'safetyist', 'skeptic'].includes(tab);

  const handleSearch = () => {
    if (toolbarPanel === 'search') {
      clearSimilarSearch();
      setToolbarPanel(null);
    } else {
      setToolbarPanel('search');
    }
  };

  const handleTaxonomy = () => {
    if (toolbarPanel !== null) setToolbarPanel(null);
    useTaxonomyStore.setState({ relatedNodeId: null, selectedEdge: null });
    if (['situations', 'conflicts', 'cruxes', 'debate', 'chat', 'summaries', 'validation'].includes(activeTab)) {
      setActiveTab('accelerationist');
    }
  };

  const switchTab = (tab: 'debate' | 'chat') => {
    useTaxonomyStore.setState({ relatedNodeId: null, selectedEdge: null });
    setToolbarPanel(null);
    setActiveTab(tab);
  };

  return (
    <>
      <nav className="bottom-nav" role="navigation" aria-label="Bottom navigation">
        <button
          className={`bottom-nav-item${toolbarPanel === 'search' ? ' active' : ''}`}
          onClick={handleSearch}
        >
          {navIcon('search')}
          <span className="bottom-nav-label">Search</span>
        </button>

        {isDebateContext ? (
          // t/4535: Chat before Debate, matching the new primary order (PI request, p/351#29).
          <>
            <button
              className={`bottom-nav-item${activeTab === 'chat' ? ' active' : ''}`}
              onClick={() => switchTab('chat')}
            >
              {navIcon('chat')}
              <span className="bottom-nav-label">Chat</span>
            </button>
            <button
              className={`bottom-nav-item${activeTab === 'debate' ? ' active' : ''}`}
              onClick={() => switchTab('debate')}
            >
              {navIcon('debate')}
              <span className="bottom-nav-label">Debate</span>
            </button>
          </>
        ) : (
          <>
            <button
              className={`bottom-nav-item${isPovTab && toolbarPanel === null ? ' active' : ''}`}
              onClick={handleTaxonomy}
            >
              {navIcon('taxonomy')}
              <span className="bottom-nav-label">Taxonomy</span>
            </button>
            {!isPhone && (
              <button
                className={`bottom-nav-item${activeTab === 'debate' ? ' active' : ''}`}
                onClick={() => switchTab('debate')}
              >
                {navIcon('debate')}
                <span className="bottom-nav-label">Debate</span>
              </button>
            )}
          </>
        )}

        <button
          className="bottom-nav-item"
          onClick={onOpenMore}
        >
          <Ellipsis size="1.5em" />
          <span className="bottom-nav-label">More</span>
        </button>
      </nav>
    </>
  );
}
