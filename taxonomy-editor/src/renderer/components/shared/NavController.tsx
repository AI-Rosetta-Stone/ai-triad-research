// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import './NavController.css';
import { navHistory } from '../../navigation';

export function NavController() {
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [backLabel, setBackLabel] = useState('');
  const [forwardLabel, setForwardLabel] = useState('');

  useEffect(() => {
    const updateState = () => {
      setCanGoBack(navHistory.canGoBack());
      setCanGoForward(navHistory.canGoForward());

      const back = navHistory.peekBack();
      setBackLabel(back?.label ?? '');

      const forward = navHistory.peekForward();
      setForwardLabel(forward?.label ?? '');
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
  const backTitle = backLabel ? `Back to ${backLabel}` : 'Back';
  const forwardTitle = forwardLabel ? `Forward to ${forwardLabel}` : 'Forward';

  return (
    <div className="nav-controller" role="group" aria-label="Navigation">
      <button
        className="nav-button nav-back"
        onClick={handleBack}
        disabled={!canGoBack}
        aria-label="Back"
        aria-disabled={!canGoBack}
        title={backTitle}
      >
        <ArrowLeft size={18} />
      </button>
      {isElectron && (
        <button
          className="nav-button nav-forward"
          onClick={handleForward}
          disabled={!canGoForward}
          aria-label="Forward"
          aria-disabled={!canGoForward}
          title={forwardTitle}
        >
          <ArrowRight size={18} />
        </button>
      )}
    </div>
  );
}
