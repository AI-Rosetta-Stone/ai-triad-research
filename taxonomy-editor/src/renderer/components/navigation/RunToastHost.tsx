// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { subscribeRunCompletion, type RunCompletion } from '../../navigation/runningSignal';
import { subscribeNavNotice } from '../../navigation/navNotice';
import './RunToastHost.css';

const AUTO_DISMISS_MS = 8000;

/** A finished run (with "Open"), or a navigation notice such as an item that wasn't found. */
type ToastEntry =
  | (RunCompletion & { kind: 'run'; key: string })
  | { kind: 'notice'; text: string; key: string };

function runLabel(t: RunCompletion): string {
  if (t.tool === 'debate') return t.outcome === 'done' ? `Debate finished: ${t.title}` : `Debate stopped: ${t.title}`;
  return t.outcome === 'done' ? `Chat reply ready: ${t.title}` : `Chat reply failed: ${t.title}`;
}

// t/4689: the finished-run toast. Design spec (t/4689#5): fires for `done`/`error` only
// (never `aborted` — the user caused that themselves), only when the run was elsewhere at
// completion, with an "Open" action, role="status", and an 8s auto-dismiss paused on
// hover/focus. t/4640 AC3 reuses the same stack for navigation notices (no action).
export function RunToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (key: string) => {
    const timer = timers.current.get(key);
    if (timer) { clearTimeout(timer); timers.current.delete(key); }
    setToasts(prev => prev.filter(t => t.key !== key));
  };

  const add = (entry: ToastEntry) => {
    setToasts(prev => [...prev, entry]);
    timers.current.set(entry.key, setTimeout(() => dismiss(entry.key), AUTO_DISMISS_MS));
  };

  useEffect(() => {
    const unsubscribeRuns = subscribeRunCompletion((completion) => {
      if (completion.outcome === 'aborted' || !completion.wasElsewhere) return;
      add({ ...completion, kind: 'run', key: `${completion.tool}:${completion.itemId}:${Date.now()}` });
    });
    const unsubscribeNotices = subscribeNavNotice((text) => {
      add({ kind: 'notice', text, key: `notice:${Date.now()}:${Math.random()}` });
    });
    return () => { unsubscribeRuns(); unsubscribeNotices(); };
  }, []);

  const pause = (key: string) => {
    const timer = timers.current.get(key);
    if (timer) { clearTimeout(timer); timers.current.delete(key); }
  };

  const resume = (key: string) => {
    if (timers.current.has(key)) return;
    timers.current.set(key, setTimeout(() => dismiss(key), AUTO_DISMISS_MS));
  };

  const openToast = (t: RunCompletion & { key: string }) => {
    dismiss(t.key);
    useTaxonomyStore.setState({ activeTab: t.tool });
    if (t.tool === 'chat') void useChatStore.getState().loadChat(t.itemId);
    else void useDebateStore.getState().loadDebate(t.itemId);
  };

  if (toasts.length === 0) return null;

  return (
    <div className="run-toast-stack">
      {toasts.map(t => (
        <div
          key={t.key}
          className={`run-toast${t.kind === 'run' && t.outcome === 'error' ? ' run-toast-error' : ''}`}
          role="status"
          onMouseEnter={() => pause(t.key)}
          onMouseLeave={() => resume(t.key)}
          onFocus={() => pause(t.key)}
          onBlur={() => resume(t.key)}
        >
          <span className="run-toast-text">{t.kind === 'run' ? runLabel(t) : t.text}</span>
          {t.kind === 'run' && <button className="run-toast-btn" onClick={() => openToast(t)}>Open</button>}
          <button className="run-toast-dismiss" onClick={() => dismiss(t.key)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
