// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './HowPanel.css';

// ── Exports ──────────────────────────────────────────────

export interface HowMethodsLink {
  label: string;
  url: string;
}

export interface HowPanelProps {
  rawPrompt?: string;
  rawResponse?: string;
}

export interface HowSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

export interface HowRawContentProps {
  value?: string;
  label: string;
  missingText: string;
}

export interface HowMethodsLinksProps {
  links: HowMethodsLink[];
  component?: string;
}

// ── HowMethodsLink ───────────────────────────────────────

export function HowMethodsLink({ label, url, component = 'how-panel' }: HowMethodsLink & { component?: string }) {
  return (
    <button
      type="button"
      className="btn-ghost how-methods-link"
      onClick={() => {
        void api.openExternal(url).catch((err: unknown) => {
          getGlobalRecorder()?.record({
            type: 'system.error', component, level: 'error',
            message: 'Failed to open methods link',
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          });
        });
      }}
    >
      {label}
    </button>
  );
}

// ── HowSection ───────────────────────────────────────────

export function HowSection({ title, defaultExpanded = true, children }: HowSectionProps) {
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

// ── HowRawContent ────────────────────────────────────────

/**
 * Raw Prompt/Response content: the real text in a ~15-visible-line scroll box when present,
 * or a "not recorded" message when absent (e.g., old entries before raw fields were captured).
 */
export function HowRawContent({ value, label, missingText }: HowRawContentProps) {
  if (!value) return <p className="how-unavailable">{missingText}</p>;
  return <pre className="how-textbox" tabIndex={0} aria-label={label}>{value}</pre>;
}

// ── HowNote ──────────────────────────────────────────────

export function HowNote({ children }: { children: React.ReactNode }) {
  return <p className="how-unavailable">{children}</p>;
}

// ── HowMethodsLinks ──────────────────────────────────────

export function HowMethodsLinks({ links, component = 'how-panel' }: HowMethodsLinksProps) {
  return (
    <ul className="how-methods-list">
      {links.map(link => (
        <li key={link.url}><HowMethodsLink label={link.label} url={link.url} component={component} /></li>
      ))}
    </ul>
  );
}

// ── HowPanel ─────────────────────────────────────────────

/**
 * Collapsible How panel for displaying raw prompt/response and methods links.
 * Rendered below each POV response in Chat, and in Op-Ed reader.
 */
export function HowPanel({ rawPrompt, rawResponse }: HowPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const methods: HowMethodsLink[] = [
    { label: 'Theory of Success', url: 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/ux/chat-tool-theory-of-success.md' },
    { label: 'Theory of Operations', url: 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/ux/chat-tool-theory-of-operations.md' },
  ];
  return (
    <div className="how-panel">
      <button type="button" className="how-toggle" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <span className={`how-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true">▸</span>
        How
      </button>
      {expanded && (
        <div className="how-body">
          <HowSection title="Raw Prompt" defaultExpanded>
            <HowRawContent value={rawPrompt} label="Raw Prompt" missingText="Raw prompt not recorded for this message." />
          </HowSection>
          <HowSection title="Raw Response" defaultExpanded={false}>
            <HowRawContent value={rawResponse} label="Raw Response" missingText="Raw response not recorded for this message." />
          </HowSection>
          <HowSection title="Methods" defaultExpanded={false}>
            <HowMethodsLinks links={methods} />
          </HowSection>
        </div>
      )}
    </div>
  );
}
