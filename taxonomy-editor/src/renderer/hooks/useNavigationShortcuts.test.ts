// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { navHistory } from '../navigation';
import { useNavigationShortcuts } from './useNavigationShortcuts';

// The hook must be RENDERED for its listeners to exist — dispatching without renderHook
// tests nothing (t/4640, #4196). Events are dispatched from real elements so the
// text-input guard sees a real target, as in the app.
function mouseUp(target: EventTarget, button: number): MouseEvent {
  const event = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button });
  target.dispatchEvent(event);
  return event;
}

describe('useNavigationShortcuts mouse buttons (AC5)', () => {
  let unmount: () => void;

  beforeEach(() => {
    vi.spyOn(navHistory, 'canGoBack').mockReturnValue(true);
    vi.spyOn(navHistory, 'canGoForward').mockReturnValue(true);
    vi.spyOn(navHistory, 'back').mockImplementation(() => {});
    vi.spyOn(navHistory, 'forward').mockImplementation(() => {});
    ({ unmount } = renderHook(() => useNavigationShortcuts()));
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('button 3 goes back and prevents the default', () => {
    const event = mouseUp(document.body, 3);
    expect(navHistory.back).toHaveBeenCalledTimes(1);
    expect(navHistory.forward).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('button 4 goes forward and prevents the default', () => {
    const event = mouseUp(document.body, 4);
    expect(navHistory.forward).toHaveBeenCalledTimes(1);
    expect(navHistory.back).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('other buttons do nothing', () => {
    mouseUp(document.body, 0);
    mouseUp(document.body, 1);
    mouseUp(document.body, 2);
    expect(navHistory.back).not.toHaveBeenCalled();
    expect(navHistory.forward).not.toHaveBeenCalled();
  });

  it('mouse buttons are ignored when the target is a text input', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    document.body.append(input, textarea);
    mouseUp(input, 3);
    mouseUp(textarea, 4);
    expect(navHistory.back).not.toHaveBeenCalled();
    expect(navHistory.forward).not.toHaveBeenCalled();
  });

  it('does nothing at the ends of the stack', () => {
    vi.mocked(navHistory.canGoBack).mockReturnValue(false);
    vi.mocked(navHistory.canGoForward).mockReturnValue(false);
    mouseUp(document.body, 3);
    mouseUp(document.body, 4);
    expect(navHistory.back).not.toHaveBeenCalled();
    expect(navHistory.forward).not.toHaveBeenCalled();
  });
});
