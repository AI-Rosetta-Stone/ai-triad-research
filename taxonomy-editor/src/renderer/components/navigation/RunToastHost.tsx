// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { subscribeRunCompletion, type RunCompletion } from '../../navigation/runningSignal';
import './RunToastHost.css';

const AUTO_DISMISS_MS = 8000;

interface ToastEntry extends RunCompletion {
  key: string;
}

// t/4689: the finished-run toast. Design spec (t/4689#5): fires for `done`/`error` only
// (never `aborted` — the user caused that themselves), only when the run was elsewhere at
// completion, with an "Open" action, role="status", and an 8s auto-dismiss paused on
// hover/focus.
export function RunToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (key: string) => {
    const timer = timers.current.get(key);
    if (timer) { clearTimeout(timer); timers.current.delete(key); }
    setToasts(prev => prev.filter(t => t.key !== key));
  };

  useEffect(() => {
    return subscribeRunCompletion((completion) => {
      if (completion.outcome === 'aborted' || !completion.wasElsewhere) return;
      const key = `${completion.tool}:${completion.itemId}:${Date.now()}`;
      setToasts(prev => [...prev, { ...completion, key }]);
      const timer = setTimeout(() => dismiss(key), AUTO_DISMISS_MS);
      timers.current.set(key, timer);
    });
  }, []);

  const pause = (key: string) => {
    const timer = timers.current.get(key);
    if (timer) { clearTimeout(timer); timers.current.delete(key); }
  };

  const resume = (key: string) => {
    if (timers.current.has(key)) return;
    timers.current.set(key, setTimeout(() => dismiss(key), AUTO_DISMISS_MS));
  };

  const openToast = (t: ToastEntry) => {
    dismiss(t.key);
    useTaxonomyStore.setState({ activeTab: t.tool });
    if (t.tool === 'chat') void useChatStore.getState().loadChat(t.itemId);
    else void useDebateStore.getState().loadDebate(t.itemId);
  };

  if (toasts.length === 0) return null;

  return (
    <div className="run-toast-stack">
      {toasts.map(t => {
        const label = t.tool === 'debate'
          ? (t.outcome === 'done' ? `Debate finished: ${t.title}` : `Debate stopped: ${t.title}`)
          : (t.outcome === 'done' ? `Chat reply ready: ${t.title}` : `Chat reply failed: ${t.title}`);
        return (
          <div
            key={t.key}
            className={`run-toast${t.outcome === 'error' ? ' run-toast-error' : ''}`}
            role="status"
            onMouseEnter={() => pause(t.key)}
            onMouseLeave={() => resume(t.key)}
            onFocus={() => pause(t.key)}
            onBlur={() => resume(t.key)}
          >
            <span className="run-toast-text">{label}</span>
            <button className="run-toast-btn" onClick={() => openToast(t)}>Open</button>
            <button className="run-toast-dismiss" onClick={() => dismiss(t.key)} aria-label="Dismiss">×</button>
          </div>
        );
      })}
    </div>
  );
}
