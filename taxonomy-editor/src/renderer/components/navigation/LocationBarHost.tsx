// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { useOpEdStore } from '../../hooks/useOpEdStore';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { placeOf } from '../../navigation/placeOf';
import { navHistory } from '../../navigation';
import { LocationBar } from './LocationBar';
import './LocationBarHost.css';

/**
 * LocationBarHost wraps LocationBar and Recent menu to avoid re-rendering MainApp
 * when store state changes. All store hooks are local to this component.
 *
 * Navigation flow:
 * 1. Breadcrumb click → call loadDebate/Chat/etc
 * 2. Store state updates → subscriber detects place change → push/replace to history
 * 3. No manual navHistory.push() in handlers
 */
export function LocationBarHost() {
  const [recentMenu, setRecentMenu] = useState(false);
  const [recentEntries, setRecentEntries] = useState<Array<{ label: string; delta: number; index: number }>>([]);
  const recentRef = useRef<HTMLDivElement>(null);

  // All store hooks here (not in MainApp) to avoid app-wide re-renders
  const taxonomyState = useTaxonomyStore();
  const debateState = useDebateStore();
  const chatState = useChatStore();
  const opEdState = useOpEdStore();
  const inquiryState = useInquiryStore();

  // Compute current place from all store states
  const place = placeOf({
    taxonomyStore: taxonomyState,
    debateStore: debateState,
    chatStore: chatState,
    opEdStore: opEdState,
    inquiryStore: inquiryState,
    activeTab: taxonomyState.activeTab,
  });

  // Update recent menu with actual history entries
  const updateRecentEntries = () => {
    const allEntries = navHistory.entries();
    const currentIndex = navHistory.index();
    const entries: Array<{ label: string; delta: number; index: number }> = [];

    // Show past entries (back navigation)
    for (let i = currentIndex - 1; i >= 0; i--) {
      const entry = allEntries[i];
      if (entry) {
        entries.push({ label: `← ${entry.label}`, delta: i - currentIndex, index: i });
      }
    }

    // Show future entries (forward navigation)
    for (let i = currentIndex + 1; i < allEntries.length; i++) {
      const entry = allEntries[i];
      if (entry) {
        entries.push({ label: `${entry.label} →`, delta: i - currentIndex, index: i });
      }
    }

    setRecentEntries(entries);
  };

  useEffect(() => {
    updateRecentEntries();
  }, []);

  // Subscribe to history changes to update recent menu
  useEffect(() => {
    const unsub = navHistory.subscribe(() => {
      updateRecentEntries();
    });
    return unsub;
  }, []);

  // Close recent menu on outside click
  useEffect(() => {
    if (!recentMenu) return;
    const handler = (e: MouseEvent) => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentMenu(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [recentMenu]);

  // Handle breadcrumb navigation: don't push manually; subscriber does it
  const handleNavigate = async (targetPlaceKey: string) => {
    if (targetPlaceKey === place.placeKey) return;

    // Parse the targetPlaceKey and navigate to the appropriate item
    const [tool, ...rest] = targetPlaceKey.split(':');
    const itemId = rest.join(':') || undefined;

    if (tool === 'rosetta-stone') {
      useTaxonomyStore.setState({ activeTab: 'rosetta-stone' });
    } else if (tool === 'debate' && itemId) {
      useTaxonomyStore.setState({ activeTab: 'debate' });
      await debateState.loadDebate(itemId);
    } else if (tool === 'chat' && itemId) {
      useTaxonomyStore.setState({ activeTab: 'chat' });
      await chatState.loadChat(itemId);
    } else if (tool === 'opeds' && itemId) {
      useTaxonomyStore.setState({ activeTab: 'opeds' });
      opEdState.selectSet(itemId);
    } else if (tool === 'inquiry' && itemId) {
      useTaxonomyStore.setState({ activeTab: 'inquiry' });
      await inquiryState.openFromHistory(itemId);
    }
  };

  // Handle recent menu navigation via go(delta)
  const handleRecentJump = (delta: number) => {
    setRecentMenu(false);
    navHistory.go(delta);
  };

  const isElectron = import.meta.env.VITE_TARGET !== 'web';
  const canGoBack = navHistory.canGoBack();
  const canGoForward = navHistory.canGoForward();

  return (
    <div className="location-bar-host">
      <div className="location-bar-container">
        {/* Back/Forward buttons for Electron */}
        {isElectron && (
          <div className="location-bar-controls">
            <button
              className="location-bar-btn location-bar-back"
              onClick={() => navHistory.back()}
              disabled={!canGoBack}
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft size={18} />
            </button>
            <button
              className="location-bar-btn location-bar-forward"
              onClick={() => navHistory.forward()}
              disabled={!canGoForward}
              title="Forward"
              aria-label="Forward"
            >
              <ArrowRight size={18} />
            </button>
          </div>
        )}

        {/* Breadcrumbs */}
        <LocationBar crumbs={place.crumbs} currentPlaceKey={place.placeKey} onNavigate={handleNavigate} />

        {/* Recent menu button */}
        <div className="location-bar-menu-wrap" ref={recentRef}>
          <button
            className={`location-bar-menu-btn${recentMenu ? ' location-bar-menu-active' : ''}`}
            onClick={() => setRecentMenu(!recentMenu)}
            title="Recent navigation"
            aria-label="Recent navigation"
          >
            ▾
          </button>
          {recentMenu && (
            <div className="location-bar-menu-dropdown">
              {recentEntries.map(entry => (
                <button
                  key={entry.delta}
                  className="location-bar-menu-item"
                  onClick={() => handleRecentJump(entry.delta)}
                >
                  {entry.label}
                </button>
              ))}
              {recentEntries.length === 0 && (
                <div className="location-bar-menu-empty">No history</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
