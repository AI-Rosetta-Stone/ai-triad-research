// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/673 (Design p/25#188): the dump-failed toast shows a plain line, never the raw ActionableError.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { showDumpErrorToast } from '../dumpToast';

const RAW = 'ActionableError: Goal: Send data to server Error: POST /api/flight-recorder/dump failed with HTTP 502 Location: web-bridge.post Resolve: 1. restart';

describe('dump-failed toast (t/673)', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  for (const isWeb of [true, false]) {
    it(`${isWeb ? 'web' : 'desktop'}: plain line, raw detail only in the console`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      showDumpErrorToast({ errorMessage: RAW, isWeb, onRetry: () => {}, onSaveLocally: () => {} } as never);
      const text = document.body.textContent ?? '';
      expect(text).toContain(isWeb ? "Couldn't send the diagnostic report. Try again, or save it locally." : "Couldn't save the diagnostic report. Try again.");
      expect(text).toContain('Diagnostic report failed');
      expect(text).not.toMatch(/Goal:|Resolve:|ActionableError|HTTP 502/);
      expect(warn.mock.calls.flat().join(' ')).toContain('HTTP 502');
    });
  }
});
