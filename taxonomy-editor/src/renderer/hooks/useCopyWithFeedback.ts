// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4786 (TL t/4786#2 point 3): one copy behaviour, shared by CopyLinkButton and
// LocationBarShareButton, so the two never drift. Point 4: the clipboard can fail
// (permissions, non-secure contexts, Firefox) — never fail silently. A failed copy sets
// `failed`, so the caller can show a read-only, pre-selected field with "Copy this link"
// instead of the normal copied state.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export interface CopyWithFeedback {
  /** True for `timeoutMs` after a successful copy. */
  copied: boolean;
  /** True after a failed copy, until the next `copy()` call. */
  failed: boolean;
  copy: (text: string) => Promise<void>;
  reset: () => void;
}

export function useCopyWithFeedback(timeoutMs = 2000): CopyWithFeedback {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), timeoutMs);
    return () => clearTimeout(timer);
  }, [copied, timeoutMs]);

  const copy = useCallback(async (text: string) => {
    try {
      await api.clipboardWriteText(text);
      setFailed(false);
      setCopied(true);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'useCopyWithFeedback', level: 'warn',
        message: 'Clipboard write failed — falling back to manual copy',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setCopied(false);
      setFailed(true);
    }
  }, []);

  const reset = useCallback(() => {
    setCopied(false);
    setFailed(false);
  }, []);

  return { copied, failed, copy, reset };
}
