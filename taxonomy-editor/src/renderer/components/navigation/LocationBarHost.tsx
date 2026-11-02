// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown } from 'lucide-react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { useOpEdStore } from '../../hooks/useOpEdStore';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { placeOf } from '../../navigation/placeOf';
import { navHistory } from '../../navigation';
import { goToPath } from '../../navigation/restore';
import type { Crumb, HistoryEntry } from '../../navigation/types';
import { isRunning, subscribeRunning, type RunningToolId } from '../../navigation/runningSignal';
import { LocationBar } from './LocationBar';
import './LocationBarHost.css';

const isElectron = import.meta.env.VITE_TARGET !== 'web';
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const RECENT_MAX = 15;
const LABEL_MAX = 60;

const TOOL_NAMES: Record<string, string> = {
  'rosetta-stone': 'Rosetta Stone', chat: 'Chat', opeds: 'Op-Ed Studies', inquiry: 'Ask a Question',
  debate: 'Debate', taxonomy: 'Taxonomy', conflicts: 'Conflicts', cruxes: 'Cruxes',
  summaries: 'Summaries', validation: 'Validation', organizations: 'Organizations',
};

const CAMP_CRUMBS: Record<string, Crumb> = {
  acc: { text: 'Accelerationist', camp: 'acc' },
  saf: { text: 'Safetyist', camp: 'saf' },
  skp: { text: 'Skeptic', camp: 'skp' },
};

// t/4689: "Running…" for a Recent entry whose place has a run finishing elsewhere.
const RUNNING_TOOLS: ReadonlySet<string> = new Set<RunningToolId>(['chat', 'debate']);
function entryIsRunning(placeKey: string): boolean {
  const [tool, itemId] = placeKey.split(':');
  if (!tool || !itemId || !RUNNING_TOOLS.has(tool)) return false;
  return isRunning(tool as RunningToolId, itemId);
}

const truncate = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

/** "Back to {label}" / "Forward to {label}", or plain "Back" / "Forward" with no destination. */
function historyButtonName(verb: 'Back' | 'Forward', dest: HistoryEntry | undefined): string {
  return dest?.label ? `${verb} to ${truncate(dest.label)}` : verb;
}

function toolNameOf(placeKey: string): string {
  const tool = placeKey.startsWith('taxonomy:') ? 'taxonomy' : placeKey.split(':')[0];
  return TOOL_NAMES[tool] ?? '';
}

interface RecentMenuProps {
  entries: HistoryEntry[];
  index: number;
  /** Jump to stack index `i` — one go(delta), never a replay. */
  onJump: (i: number) => void;
}

/**
 * ▾ Recent locations (§ ▾ Recent locations menu): the stack newest first, at most 15 (web: only
 * entries with a label), the current one marked. Opening focuses the current entry; ↑/↓ and
 * Home/End move; Esc closes and refocuses ▾; Tab or a click outside closes.
 */
function RecentMenu({ entries, index, onJump }: RecentMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const recent = entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => entry.label)
    .reverse()
    .slice(0, RECENT_MAX);
  const disabled = !recent.some(({ i }) => i !== index);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': focus(at + 1); break;
      case 'ArrowUp': focus(at - 1); break;
      case 'Home': focus(0); break;
      case 'End': focus(items.length - 1); break;
      case 'Escape': e.preventDefault(); close(true); break;
      case 'Tab': close(false); break;
    }
  };

  const pick = (i: number) => {
    close(true);
    if (i !== index) onJump(i);
  };

  return (
    <div className="nav-locbar-recent-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="nav-locbar-btn nav-locbar-recent-btn"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Recent locations"
        title="Recent locations"
      >
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div ref={menuRef} className="nav-locbar-menu" role="menu" aria-label="Recent locations" onKeyDown={handleKeyDown}>
          {recent.map(({ entry, i }) => {
            const isCurrent = i === index;
            const running = entryIsRunning(entry.placeKey);
            const toolName = toolNameOf(entry.placeKey);
            const side = running ? 'Running…' : (toolName !== entry.label ? toolName : '');
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`nav-locbar-menu-item${isCurrent ? ' nav-locbar-menu-current' : ''}`}
                aria-current={isCurrent ? 'page' : undefined}
                aria-label={`${entry.label}${isCurrent ? ', you are here' : ''}${running ? ', running' : ''}`}
                onClick={() => pick(i)}
              >
                <span className="nav-locbar-menu-label">{entry.label}</span>
                {isCurrent && <span className="nav-locbar-menu-here"> · you are here</span>}
                {side && <span className="nav-locbar-menu-tool">{side}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The location bar (t/4640; docs/ux/navigation-location-bar.md): ← (→ in Electron) ▾ and the
 * breadcrumb, as the first row of the main content column. Store hooks live here, not in
 * MainApp, so a store change re-renders the bar and not the app shell.
 */
export function LocationBarHost() {
  const [, setHistoryVersion] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const announceNext = useRef(false);

  const taxonomyState = useTaxonomyStore();
  const debateState = useDebateStore();
  const chatState = useChatStore();
  const opEdState = useOpEdStore();
  const inquiryState = useInquiryStore();
  const place = placeOf({
    taxonomyStore: taxonomyState,
    debateStore: debateState,
    chatStore: chatState,
    opEdStore: opEdState,
    inquiryStore: inquiryState,
    activeTab: taxonomyState.activeTab,
  });

  // Re-render on every history change (buttons, Recent, the op-ed camp crumb), and announce the
  // new place after a Back / Forward / Recent / up navigation (§ Announcements).
  useEffect(() => navHistory.subscribe((entry) => {
    setHistoryVersion(v => v + 1);
    if (announceNext.current) {
      announceNext.current = false;
      setAnnouncement(entry.label);
    }
  }), []);
  useEffect(() => subscribeRunning(() => setHistoryVersion(v => v + 1)), []);

  const entries = navHistory.entries();
  const index = navHistory.index();
  const canGoBack = navHistory.canGoBack();
  const canGoForward = isElectron && navHistory.canGoForward();

  // The op-ed camp is a view of the set (?pov=), not part of the store — read it off the entry.
  const crumbs = [...place.crumbs];
  if (place.tool === 'opeds' && place.placeKey !== 'opeds:none') {
    const pov = new URLSearchParams(navHistory.current()?.path.split('?')[1] ?? '').get('pov');
    if (pov && CAMP_CRUMBS[pov]) crumbs.push(CAMP_CRUMBS[pov]);
  }

  const navigate = (action: () => void) => {
    announceNext.current = true;
    action();
  };

  const backName = historyButtonName('Back', canGoBack ? entries[index - 1] : undefined);
  const forwardName = historyButtonName('Forward', canGoForward ? entries[index + 1] : undefined);

  return (
    <div className="nav-locbar location-bar-host">
      <div className="nav-locbar-history" role="group" aria-label="History">
        <button
          type="button"
          className="nav-locbar-btn"
          onClick={() => navigate(() => navHistory.back())}
          disabled={!canGoBack}
          aria-disabled={!canGoBack}
          aria-label={backName}
          aria-keyshortcuts={isMac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft'}
          title={`${backName} (${isMac ? '⌘[' : 'Alt+←'})`}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        {isElectron && (
          <button
            type="button"
            className="nav-locbar-btn"
            onClick={() => navigate(() => navHistory.forward())}
            disabled={!canGoForward}
            aria-disabled={!canGoForward}
            aria-label={forwardName}
            aria-keyshortcuts={isMac ? 'Meta+BracketRight' : 'Alt+ArrowRight'}
            title={`${forwardName} (${isMac ? '⌘]' : 'Alt+→'})`}
          >
            <ArrowRight aria-hidden="true" />
          </button>
        )}
        <RecentMenu entries={entries} index={index} onJump={i => navigate(() => navHistory.go(i - index))} />
      </div>

      <LocationBar crumbs={crumbs} tool={place.tool} onUp={href => navigate(() => goToPath(href))} />

      <div className="nav-locbar-live" aria-live="polite">{announcement}</div>
    </div>
  );
}
