// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCopyWithFeedback } from './useCopyWithFeedback';

const clipboardWriteTextMock = vi.fn();
vi.mock('@bridge', () => ({ api: { clipboardWriteText: (t: string) => clipboardWriteTextMock(t) } }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

describe('useCopyWithFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    clipboardWriteTextMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('a successful copy sets copied and clears it after the timeout', async () => {
    clipboardWriteTextMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useCopyWithFeedback(2000));

    await act(async () => { await result.current.copy('https://x.test'); });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('https://x.test');
    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBe(false);

    act(() => { vi.advanceTimersByTime(2000); });
    await waitFor(() => expect(result.current.copied).toBe(false));
  });

  it('a failed copy sets failed, not copied — never silent (TL point 4)', async () => {
    clipboardWriteTextMock.mockRejectedValue(new Error('denied'));
    const { result } = renderHook(() => useCopyWithFeedback());

    await act(async () => { await result.current.copy('https://x.test'); });
    expect(result.current.failed).toBe(true);
    expect(result.current.copied).toBe(false);
  });

  it('reset() clears both flags', async () => {
    clipboardWriteTextMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useCopyWithFeedback());
    await act(async () => { await result.current.copy('https://x.test'); });
    expect(result.current.copied).toBe(true);
    act(() => result.current.reset());
    expect(result.current.copied).toBe(false);
  });
});
