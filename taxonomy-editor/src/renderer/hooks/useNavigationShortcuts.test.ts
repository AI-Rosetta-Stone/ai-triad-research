// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { navHistory } from '../navigation';

describe('useNavigationShortcuts mouse buttons', () => {
  let backSpy: any;
  let forwardSpy: any;
  let preventDefaultSpy: any;

  beforeEach(() => {
    backSpy = vi.spyOn(navHistory, 'back');
    forwardSpy = vi.spyOn(navHistory, 'forward');
    vi.spyOn(navHistory, 'canGoBack').mockReturnValue(true);
    vi.spyOn(navHistory, 'canGoForward').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('button 3 (back) triggers navHistory.back()', () => {
    const event = new MouseEvent('mouseup', { bubbles: true });
    Object.defineProperty(event, 'button', { value: 3, writable: false });
    preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    window.dispatchEvent(event);

    expect(backSpy).toHaveBeenCalled();
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it('button 4 (forward) triggers navHistory.forward()', () => {
    const event = new MouseEvent('mouseup', { bubbles: true });
    Object.defineProperty(event, 'button', { value: 4, writable: false });
    preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    window.dispatchEvent(event);

    expect(forwardSpy).toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it('mouse buttons do not fire while focus is in a text input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = new MouseEvent('mouseup', { bubbles: true });
    Object.defineProperty(event, 'button', { value: 3, writable: false });
    Object.defineProperty(event, 'target', { value: input, writable: false });

    window.dispatchEvent(event);

    expect(backSpy).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});
