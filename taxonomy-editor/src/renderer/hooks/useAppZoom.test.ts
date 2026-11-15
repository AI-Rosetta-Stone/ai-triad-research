// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockApi, electron } = vi.hoisted(() => {
  const electron = { on: false };
  const mockApi = {
    setZoomFactor: vi.fn(() => electron.on),
    onZoomCommand: vi.fn((_cb: (c: 'in' | 'out' | 'reset') => void) => () => {}),
  };
  return { mockApi, electron };
});
vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: () => electron.on }));

import { useAppZoom, BASE_FONT_PCT } from './useAppZoom';

const handlers = () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn() });
const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true }));

describe('useAppZoom (t/163)', () => {
  beforeEach(() => { document.documentElement.style.fontSize = ''; });
  afterEach(() => { vi.clearAllMocks(); electron.on = false; });

  describe('desktop: one page-zoom model', () => {
    beforeEach(() => { electron.on = true; });

    it('drives the page zoom from zoomLevel and keeps the root font at the baseline, so px panes scale too', () => {
      const h = handlers();
      const { rerender } = renderHook(({ z }) => useAppZoom(z, h.zoomIn, h.zoomOut, h.zoomReset), { initialProps: { z: 150 } });
      expect(mockApi.setZoomFactor).toHaveBeenLastCalledWith(1.5);
      expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_PCT}%`);
      rerender({ z: 60 });
      expect(mockApi.setZoomFactor).toHaveBeenLastCalledWith(0.6);
      expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_PCT}%`);
    });

    it('routes View-menu zoom commands into the store (no second zoom model)', () => {
      const h = handlers();
      renderHook(() => useAppZoom(100, h.zoomIn, h.zoomOut, h.zoomReset));
      const cb = mockApi.onZoomCommand.mock.calls[0][0];
      cb('in'); cb('out'); cb('reset');
      expect([h.zoomIn, h.zoomOut, h.zoomReset].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    });

    it('leaves Ctrl+= / Ctrl+- / Ctrl+0 to the menu accelerators, so one press steps once', () => {
      const h = handlers();
      renderHook(() => useAppZoom(100, h.zoomIn, h.zoomOut, h.zoomReset));
      press('='); press('-'); press('0');
      expect([h.zoomIn, h.zoomOut, h.zoomReset].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    });
  });

  describe('web: root font-size fallback', () => {
    it('scales the root font-size with zoomLevel when there is no page zoom', () => {
      const h = handlers();
      renderHook(() => useAppZoom(150, h.zoomIn, h.zoomOut, h.zoomReset));
      expect(mockApi.setZoomFactor).toHaveBeenCalledWith(1.5);
      expect(document.documentElement.style.fontSize).toBe(`${(BASE_FONT_PCT * 150) / 100}%`);
    });

    it('handles the keyboard shortcuts itself', () => {
      const h = handlers();
      renderHook(() => useAppZoom(100, h.zoomIn, h.zoomOut, h.zoomReset));
      press('='); press('-'); press('0');
      expect([h.zoomIn, h.zoomOut, h.zoomReset].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    });
  });
});
