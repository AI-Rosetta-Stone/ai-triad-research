// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The "How" disclosure shared by Chat (t/4824) and the Op-Ed reader (t/173): a collapsed "How"
// toggle, collapsible sub-sections, raw-text boxes with an explicit "not recorded" state, and
// Methods links. Extracted from ChatWorkspace so the two read the same.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './HowPanel.css';

export interface HowMethodsLinkSpec { label: string; url: string }

/** A collapsible sub-section (Raw Prompt, Methods, one op-ed stage …). */
export function HowSection({ title, defaultExpanded, children }: { title: string; defaultExpanded: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="how-section">
      <button type="button" className="how-section-toggle" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <span className={`how-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true">▸</span>
        {title}
      </button>
      {expanded && <div className="how-section-body">{children}</div>}
    </div>
  );
}

/** Raw text in a ~15-visible-line scroll box, or the "not recorded" message when it was never
 *  captured, so a missing value never reads as a rendering bug. */
export function HowRawContent({ value, label, missingText }: { value: string | undefined; label: string; missingText: string }) {
  if (!value) return <p className="how-unavailable">{missingText}</p>;
  // t/4856 (Design): tabIndex + aria-label so the scroll box is keyboard-reachable and announced.
  return <pre className="how-textbox" tabIndex={0} aria-label={label}>{value}</pre>;
}

/** An explanatory line in the "not recorded" style (e.g. a failed call). */
export function HowNote({ children }: { children: ReactNode }) {
  return <p className="how-unavailable">{children}</p>;
}

/** The tool's methods docs, opened externally. */
export function HowMethodsLinks({ links, component }: { links: readonly HowMethodsLinkSpec[]; component: string }) {
  return (
    <ul className="how-methods-list">
      {links.map(link => (
        <li key={link.url}>
          <button
            type="button"
            className="btn-ghost how-methods-link"
            onClick={() => {
              void api.openExternal(link.url).catch((err: unknown) => {
                getGlobalRecorder()?.record({
                  type: 'system.error', component, level: 'error',
                  message: 'Failed to open methods link',
                  error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
                });
              });
            }}
          >
            {link.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The outer "How" toggle, collapsed by default (t/4824). */
export function HowPanel({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="how-panel">
      <button type="button" className="how-toggle" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <span className={`how-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true">▸</span>
        How
      </button>
      {expanded && <div className="how-body">{children}</div>}
    </div>
  );
}
