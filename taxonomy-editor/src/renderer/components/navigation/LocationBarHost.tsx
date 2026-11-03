// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink } from 'lucide-react';
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
import { canOpenInNewWindow, openPlaceInNewWindow, type ItemPlace, type ItemToolId } from '../../navigation/openInWindow';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { LocationBar } from './LocationBar';
import { backAction, historyButtonName, type BackAction } from './backAction';
import './LocationBarHost.css';

const isElectron = import.meta.env.VITE_TARGET !== 'web';
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const RECENT_MAX = 15;

// t/4772: the four tools with item places (Tool › item). Any other place (a library, taxonomy,
// conflicts, …) never shows ⧉.
const ITEM_TOOLS: ReadonlySet<string> = new Set<ItemToolId>(['chat', 'debate', 'opeds', 'inquiry']);

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

function toolNameOf(placeKey: string): string {
  const tool = placeKey.startsWith('taxonomy:') ? 'taxonomy' : placeKey.split(':')[0];
  return TOOL_NAMES[tool] ?? '';
}

/** t/4772: null on a library or any non-item place (`placeKey` ends in `:none`, or the tool has
 *  no item concept at all). */
function itemPlaceOf(tool: string, placeKey: string, path: string): ItemPlace | null {
  if (!ITEM_TOOLS.has(tool)) return null;
  const id = placeKey.slice(placeKey.indexOf(':') + 1);
  if (!id || id === 'none') return null;
  return { tool: tool as ItemToolId, id, path };
}

/** ⧉ at the location bar's right end, item places only (§ spec "⧉ Open in new window"). */
function NewWindowButton({ place }: { place: ItemPlace }) {
  const label = isElectron ? 'Open in new window' : 'Open in new tab';
  return (
    <button
      type="button"
      className="nav-locbar-btn nav-locbar-newwin"
      onClick={() => openPlaceInNewWindow(place)}
      aria-label={label}
      title={label}
    >
      <ExternalLink aria-hidden="true" />
    </button>
  );
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
            // The label carries a "Tool: " prefix for Back/Forward names; the row shows the tool in
            // its own right-hand column instead, so drop the prefix from the row text.
            const rowText = toolName && entry.label.startsWith(`${toolName}: `)
              ? entry.label.slice(toolName.length + 2)
              : entry.label;
            const side = running ? 'Running…' : (toolName !== rowText ? toolName : '');
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
                <span className="nav-locbar-menu-label">{rowText}</span>
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
 * ← — plain Back, or "Up to {ancestor}" under the phone up rule (see backAction). The shortcut
 * belongs to Back only, so the up form carries no shortcut hint.
 */
function BackButton({ action, onBack, onUp }: { action: BackAction; onBack: () => void; onUp: (href: string) => void }) {
  const isUp = action.kind === 'up';
  const disabled = !isUp && !action.enabled;
  return (
    <button
      type="button"
      className="nav-locbar-btn"
      onClick={() => (isUp ? onUp(action.href) : onBack())}
      disabled={disabled}
      aria-disabled={disabled}
      aria-label={action.name}
      aria-keyshortcuts={isUp ? undefined : (isMac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft')}
      title={isUp ? action.name : `${action.name} (${isMac ? '⌘[' : 'Alt+←'})`}
    >
      <ArrowLeft aria-hidden="true" />
    </button>
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

  const isPhone = useBreakpoint() === 'phone';
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

  const back = backAction({ isPhone, canGoBack, backDest: entries[index - 1], crumbs });
  const forwardName = historyButtonName('Forward', canGoForward ? entries[index + 1] : undefined);

  const itemPlace = itemPlaceOf(place.tool, place.placeKey, place.path);
  const showNewWindow = !isPhone && itemPlace !== null && canOpenInNewWindow(itemPlace);

  return (
    <div className="nav-locbar location-bar-host">
      <div className="nav-locbar-history" role="group" aria-label="History">
        <BackButton
          action={back}
          onBack={() => navigate(() => navHistory.back())}
          onUp={href => navigate(() => goToPath(href))}
        />
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

      {showNewWindow && itemPlace && <NewWindowButton place={itemPlace} />}

      <div className="nav-locbar-live" aria-live="polite">{announcement}</div>
    </div>
  );
}
