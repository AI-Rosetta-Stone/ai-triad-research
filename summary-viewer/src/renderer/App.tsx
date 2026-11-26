// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useMemo, useState } from 'react';
import { useResizablePanes } from './hooks/useResizablePanes';
import { useStore } from './store/useStore';
import { initAIModels } from './store/aiModels';
import ResizeHandle from './components/ResizeHandle';
import SourcesPane from './components/SourcesPane';
import KeyPointsPane from './components/KeyPointsPane';
import DocumentPane from './components/DocumentPane';
import SimilarResultsPane from './components/SimilarResultsPane';
import PotentialEdgesPane from './components/PotentialEdgesPane';
import ErrorBoundary from './components/ErrorBoundary';
import SettingsDialog from './components/SettingsDialog';

function useThemeEffect() {
  const theme = useStore(s => s.theme);

  useEffect(() => {
    const root = document.documentElement;

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const apply = () => { root.dataset.theme = mq.matches ? 'dark' : 'light'; };
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }

    root.dataset.theme = theme;
  }, [theme]);
}

export default function App() {
  useThemeEffect();
  const { widths, containerRef, onMouseDown, draggingRef } = useResizablePanes();
  const loaded = useStore(s => s.loaded);
  const loadSources = useStore(s => s.loadSources);
  const pane1Visible = useStore(s => s.pane1Visible);
  const togglePane1 = useStore(s => s.togglePane1);
  const similarQuery = useStore(s => s.similarQuery);
  const potentialEdgesQuery = useStore(s => s.potentialEdgesQuery);
  const showSimilar = similarQuery !== null;
  const showPotentialEdges = potentialEdgesQuery !== null;
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    // t/785: once the catalog settles, a saved retired/unknown model falls back to the default.
    void initAIModels().then(() => useStore.getState().revalidateAIModel());
  }, []);

  useEffect(() => {
    if (!loaded) {
      loadSources();
    }
  }, [loaded, loadSources]);

  // Listen for Settings menu click
  useEffect(() => {
    return window.electronAPI.onMenuSettings(() => {
      setShowSettings(true);
    });
  }, []);

  // When pane 1 is hidden, redistribute its width proportionally to panes 2 and 3
  const effectiveWidths = useMemo(() => {
    if (pane1Visible) return widths;
    const p2p3Total = widths[1] + widths[2];
    const ratio = 100 / p2p3Total;
    return [0, widths[1] * ratio, widths[2] * ratio];
  }, [pane1Visible, widths]);

  if (!loaded) return null;

  return (
    <div className="app-container" ref={containerRef}>
      {pane1Visible && (
        <>
          <div className="pane" style={{ width: `${effectiveWidths[0]}%` }}>
            <ErrorBoundary fallbackLabel="Sources">
              <SourcesPane />
            </ErrorBoundary>
          </div>
          <ResizeHandle index={0} onMouseDown={onMouseDown} isActive={draggingRef.current === 0} />
        </>
      )}
      <div className="pane" style={{ width: `${effectiveWidths[1]}%` }}>
        <ErrorBoundary fallbackLabel="Key Points">
          <KeyPointsPane />
        </ErrorBoundary>
      </div>
      <ResizeHandle index={1} onMouseDown={onMouseDown} isActive={draggingRef.current === 1} />
      <div className="pane" style={{ width: `${effectiveWidths[2]}%` }}>
        <ErrorBoundary fallbackLabel={showPotentialEdges ? 'Potential Edges' : showSimilar ? 'Similar Search' : 'Document'}>
          {showPotentialEdges ? <PotentialEdgesPane /> : showSimilar ? <SimilarResultsPane /> : <DocumentPane />}
        </ErrorBoundary>
      </div>

      <button
        className="pane1-toggle"
        onClick={togglePane1}
        title={pane1Visible ? 'Hide sources pane' : 'Show sources pane'}
      >
        {pane1Visible ? '\u25C0' : '\u25B6'}
      </button>

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
