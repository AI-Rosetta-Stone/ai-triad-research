// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './NavController.css';
import { navHistory } from '../../navigation/navHistory';

export function NavController() {
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [backLabel, setBackLabel] = useState('Back');
  const [forwardLabel, setForwardLabel] = useState('Forward');

  useEffect(() => {
    const updateState = () => {
      setCanGoBack(navHistory.canGoBack());
      setCanGoForward(navHistory.canGoForward());

      const back = navHistory.peekBack();
      setBackLabel(back?.label ?? 'Back');

      const forward = navHistory.peekForward();
      setForwardLabel(forward?.label ?? 'Forward');
    };

    updateState();
    const unsub = navHistory.subscribe(() => updateState());
    return unsub;
  }, []);

  const handleBack = (e: React.MouseEvent) => {
    e.preventDefault();
    if (canGoBack) navHistory.back();
  };

  const handleForward = (e: React.MouseEvent) => {
    e.preventDefault();
    if (canGoForward) navHistory.forward();
  };

  const isElectron = import.meta.env.VITE_TARGET !== 'web';

  return (
    <div className="nav-controller" role="group" aria-label="Navigation">
      <button
        className="nav-button nav-back"
        onClick={handleBack}
        disabled={!canGoBack}
        aria-label="Back"
        aria-disabled={!canGoBack}
        title={`Back to ${backLabel}`}
      >
        <ChevronLeft size={18} />
      </button>
      {isElectron && (
        <button
          className="nav-button nav-forward"
          onClick={handleForward}
          disabled={!canGoForward}
          aria-label="Forward"
          aria-disabled={!canGoForward}
          title={`Forward to ${forwardLabel}`}
        >
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
