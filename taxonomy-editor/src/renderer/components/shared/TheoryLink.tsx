// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * TheoryLink (t/2343, unified in t/2410) — the app's general doc-link affordance:
 * a shared open-book glyph that opens a repo doc on GitHub in the system browser.
 * (Name kept for continuity; `DocLink` is exported as a readability alias.) Muted
 * glyph that brightens on hover (mirrors .field-help-btn), with a small ↗
 * external-jump badge + tooltip so the open-in-browser behavior is discoverable.
 *
 * Accepts either a full `url` or a repo-relative `docPath` (+ optional `anchor`);
 * the latter is built from a single `REPO_BLOB_BASE` constant so callers never
 * hand-assemble URLs and the canonical org is swappable in one place (t/2410).
 *
 * Activation routes through the bridge (`api.openExternal`) — never shell/window
 * directly — so it works in both the Electron (shell.openExternal) and web
 * (window.open, https-guarded) builds.
 *
 * The `data-theory-link` attribute marks the button for the app-level F1
 * hotkey (see useTheoryLinkHotkey), which activates the nearest instance.
 */

import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { usePreferencesStore } from '../../store/preferencesStore';
import './TheoryLink.css';

/** Canonical GitHub repo for doc links — single source of truth (t/2410, TL-confirmed org). */
const REPO_BLOB_BASE = 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main';

/** Build a GitHub blob URL from a repo-relative doc path (+ optional anchor). */
export function buildDocUrl(docPath: string, anchor?: string): string {
  return `${REPO_BLOB_BASE}/${docPath}${anchor ? `#${anchor}` : ''}`;
}

/**
 * Humanize a doc filename into a Title-Cased display name (t/2410).
 * Accepts a full URL or a repo-relative path; takes the last segment, drops the
 * `#anchor` and `.md`, and turns `-`/`_` separators into Title-Cased words.
 * e.g. `docs/debate-system-overview.md` → `"Debate System Overview"`.
 * (Acronyms like `ai` → `Ai` are acceptable for v1 — no current doc hits this.)
 */
export function humanizeDocName(source: string): string {
  const segment = source.split('#')[0].split('/').pop() ?? '';
  const stem = segment.replace(/\.md$/i, '');
  return stem
    .split(/[-_.]+/) // dot included so multi-dot stems (e.g. v2.migration-notes) title-case fully (t/2410#2)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface TheoryLinkBaseProps {
  /** Accessible label. Optional — defaults to the tooltip text. */
  label?: string;
  /** Hover tooltip. Optional — defaults to `"Open {Doc Name} in GitHub"`. */
  tooltip?: string;
  /** Glyph size in px, clamped to 12–16. Default 15. */
  size?: number;
  /** Extra class(es) for inline positioning by consumers — appended to the base class. */
  className?: string;
}

/** Exactly one of `url` or `docPath` must be supplied (discriminated union). */
export type TheoryLinkProps =
  | (TheoryLinkBaseProps & { url: string; docPath?: never; anchor?: never })
  | (TheoryLinkBaseProps & { docPath: string; anchor?: string; url?: never });

export function TheoryLink(props: TheoryLinkProps) {
  const { label, tooltip, size = 15, className } = props;

  // t/2867: Simple view hides ALL doc/help links app-wide — a single-point gate here
  // (mirrors PinnedPanel, t/2826) instead of ~40 per-site conditionals, which removes the
  // missed-surface risk. Store subscription ⇒ Simple↔Advanced toggles live with no reload.
  // (Redundant-but-harmless on the diagnostics surfaces that are already Advanced-only.)
  const viewMode = usePreferencesStore((s) => s.viewMode);
  if (viewMode !== 'advanced') return null;

  // Runtime guard (t/2410): exactly one of `url` / `docPath`. The discriminated union
  // catches static callers; this catches spread / `as any` / JS-caller bypasses — record a
  // diagnostic and no-op rather than silently opening the repo root (neither) or dropping
  // docPath+anchor (both).
  if ((props.url != null) === (props.docPath != null)) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'theory-link',
      level: 'error',
      message: 'TheoryLink requires exactly one of `url` or `docPath`',
      error: { name: 'InvalidTheoryLinkProps', message: `url=${props.url != null} docPath=${props.docPath != null}`, stack: new Error().stack },
    });
    return null;
  }

  const px = Math.min(16, Math.max(12, size));

  const targetUrl = props.url ?? buildDocUrl(props.docPath ?? '', props.anchor);
  const docName = humanizeDocName(props.docPath ?? props.url ?? '');
  const title = tooltip ?? `Open ${docName} in GitHub`;
  const ariaLabel = label ?? title;

  const handleOpen = () => {
    void api.openExternal(targetUrl).catch((err) => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'theory-link',
        level: 'error',
        message: 'Failed to open doc link externally',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    });
  };

  return (
    <button
      type="button"
      className={`theory-link ${className ?? ''}`}
      data-theory-link
      aria-label={ariaLabel}
      title={title}
      onClick={handleOpen}
      // eslint-disable-next-line local/no-inline-style -- dynamic glyph size drives the 1em SVG; em (px/16) scales with the root baseline + zoom (t/2416)
      style={{ fontSize: `${px / 16}em` }}
    >
      {/* Open-book glyph (currentColor so it can be tinted muted → hover-brighten) */}
      <svg className="theory-link-book" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H2z" />
        <path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H22z" />
      </svg>
      {/* External-jump badge (↗) — visual affordance paired with the tooltip text */}
      <span className="theory-link-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <line x1="6" y1="18" x2="18" y2="6" />
          <polyline points="9 6 18 6 18 15" />
        </svg>
      </span>
    </button>
  );
}

/** Readability alias — same component, clearer name at general doc-link call sites (t/2410). */
export const DocLink = TheoryLink;
