// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect } from 'react';
import { navHistory } from '../navigation';

export function useNavigationShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts while typing
      if (isInTextInput(e.target as HTMLElement)) {
        return;
      }

      // Alt+Left or Cmd+[: go back
      if ((e.altKey && e.key === 'ArrowLeft') || (e.metaKey && e.key === '[')) {
        e.preventDefault();
        if (navHistory.canGoBack()) {
          navHistory.back();
        }
      }
      // Alt+Right or Cmd+]: go forward
      else if ((e.altKey && e.key === 'ArrowRight') || (e.metaKey && e.key === ']')) {
        e.preventDefault();
        if (navHistory.canGoForward()) {
          navHistory.forward();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Electron: mouse buttons 4/5 (back/forward)
  useEffect(() => {
    // Only in Electron
    if (import.meta.env.VITE_TARGET === 'web') {
      return;
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (isInTextInput(e.target as HTMLElement)) {
        return;
      }

      // Button 3 = back, Button 4 = forward
      if (e.button === 3) {
        e.preventDefault();
        if (navHistory.canGoBack()) {
          navHistory.back();
        }
      } else if (e.button === 4) {
        e.preventDefault();
        if (navHistory.canGoForward()) {
          navHistory.forward();
        }
      }
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);
}

function isInTextInput(target: HTMLElement): boolean {
  if (!target) return false;
  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea') return true;
  if (target.contentEditable === 'true') return true;
  return false;
}
