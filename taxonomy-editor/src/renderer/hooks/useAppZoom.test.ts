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
const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

import { useAppZoom, BASE_FONT_PCT, __resetZoomWarnForTests } from './useAppZoom';

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

  describe('web: the browser zooms (TL p/10#53, Design t/163#6)', () => {
    beforeEach(() => { __resetZoomWarnForTests(); record.mockClear(); });

    it('keeps the root font at the baseline whatever level is stored', () => {
      const h = handlers();
      renderHook(() => useAppZoom(150, h.zoomIn, h.zoomOut, h.zoomReset));
      expect(mockApi.setZoomFactor).toHaveBeenCalledWith(1.5);
      expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_PCT}%`);
    });

    it('leaves Ctrl+= / Ctrl+- / Ctrl+0 to the browser (not prevented, store untouched)', () => {
      const h = handlers();
      renderHook(() => useAppZoom(100, h.zoomIn, h.zoomOut, h.zoomReset));
      const events = ['=', '-', '0'].map((key) => new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true }));
      events.forEach((e) => window.dispatchEvent(e));
      expect(events.map((e) => e.defaultPrevented)).toEqual([false, false, false]);
      expect([h.zoomIn, h.zoomOut, h.zoomReset].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    });

    it('WARNs once when a stored non-default level is ignored, and not at 100%', () => {
      const h = handlers();
      const { rerender } = renderHook(({ z }) => useAppZoom(z, h.zoomIn, h.zoomOut, h.zoomReset), { initialProps: { z: 100 } });
      expect(record).not.toHaveBeenCalled();
      rerender({ z: 150 });
      rerender({ z: 60 });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({ level: 'warn', component: 'app-zoom' });
    });
  });
});
