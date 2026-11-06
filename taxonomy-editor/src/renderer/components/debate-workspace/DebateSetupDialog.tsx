// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState, Fragment } from 'react';
import { api } from '@bridge';
import { DEBATE_AUDIENCES } from '../../types/debate';
import { DebateSourceViewer } from '../debate/DebateSourceViewer';
import { useDebateStore } from '../../hooks/useDebateStore';
import { humanizeUrl } from './DebateHeader';
import { useDialog } from '../shared/useDialog'; // t/4909
import './DebateSetupDialog.css';

type DWStore = ReturnType<typeof useDebateStore.getState>;
type ActiveDebateSession = NonNullable<DWStore['activeDebate']>;

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      className="btn btn-sm"
      onClick={() => {
        void api.clipboardWriteText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={copied ? 'Copied' : (label ?? 'Copy')}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** t/4906: this dialog is view-only (no edit controls), so read-only community readers get it
 *  too, named Details; own debates keep Setup. */
export function setupNamingFor(communityReadOnly: boolean): { label: string; title: string } {
  return communityReadOnly ? { label: 'Details', title: 'Debate Details' } : { label: 'Setup', title: 'Debate Setup' };
}

export function DebateSetupDialog({
  activeDebate,
  onClose,
  title,
}: {
  activeDebate: ActiveDebateSession;
  onClose: () => void;
  title: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [sourceEverOpened, setSourceEverOpened] = useState(false);
  // t/4909: initialFocusRef matches this dialog's pre-existing "focus the close button"
  // behavior. aria-labelledby/id below already pair correctly on a hardcoded id — no need for
  // the hook's generated titleId.
  const { dialogRef } = useDialog({ onCancel: onClose, initialFocusRef: closeRef });

  const audienceLabel = activeDebate.audience
    ? (DEBATE_AUDIENCES.find(a => a.id === activeDebate.audience)?.label ?? activeDebate.audience)
    : null;

  const topicChanged =
    (activeDebate.topic.original !== '' && activeDebate.topic.original !== activeDebate.topic.final) ||
    (activeDebate.topic.refined != null && activeDebate.topic.refined !== activeDebate.topic.final);

  const showSource = activeDebate.source_type !== 'topic';
  const srcIsUrl = /^https?:\/\//i.test(activeDebate.source_ref);
  const hasSourceContent = activeDebate.source_content !== '';

  const created = new Date(activeDebate.created_at);
  const createdStr =
    created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' +
    created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const stageModels = activeDebate.stage_models;
  const hasDistinctStageModels =
    stageModels != null &&
    Object.values(stageModels).some(v => v !== activeDebate.debate_model);

  const scopeChips = activeDebate.topic.scope
    ? [
        activeDebate.topic.scope.domain || null,
        activeDebate.topic.scope.risk_level ? `Risk: ${activeDebate.topic.scope.risk_level}` : null,
        activeDebate.topic.scope.time_horizon || null,
      ].filter((c): c is string => c != null)
    : [];

  return (
    <div className="dialog-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="dialog dsd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dsd-header">
          <h3 id="dsd-title" style={{ margin: 0 }}>{title}</h3>
          <button ref={closeRef} className="debate-inspect-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {/* TOPIC */}
        <section className="dsd-section">
          <div className="dsd-section-label">Topic</div>
          <div className="dsd-topic-row">
            <p className="dsd-topic-text">{activeDebate.topic.final}</p>
            <CopyButton text={activeDebate.topic.final} label="Copy topic" />
          </div>
          {topicChanged && (
            <details style={{ marginTop: 10 }}>
              <summary className="dsd-summary">Topic evolution</summary>
              <dl style={{ margin: '8px 0 0', display: 'grid', gap: 4 }}>
                {activeDebate.topic.original !== activeDebate.topic.final && (
                  <Fragment>
                    <dt style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Original</dt>
                    <dd style={{ margin: 0 }}>{activeDebate.topic.original}</dd>
                  </Fragment>
                )}
                {activeDebate.topic.refined != null && activeDebate.topic.refined !== activeDebate.topic.final && (
                  <Fragment>
                    <dt style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Refined</dt>
                    <dd style={{ margin: 0 }}>{activeDebate.topic.refined}</dd>
                  </Fragment>
                )}
              </dl>
            </details>
          )}
          {activeDebate.topic.clauses && activeDebate.topic.clauses.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="dsd-summary">
                Clauses ({activeDebate.topic.clauses.length})
              </summary>
              <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {activeDebate.topic.clauses.map((c, i) => (
                  <li key={i} style={{ fontSize: '0.9rem', marginBottom: 4 }}>{c}</li>
                ))}
              </ol>
            </details>
          )}
          {scopeChips.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="dsd-summary">Scope</summary>
              <div className="dsd-scope-chips">
                {scopeChips.map((chip, i) => (
                  <span key={i} className="dsd-scope-chip">{chip}</span>
                ))}
              </div>
            </details>
          )}
        </section>

        {/* SOURCE */}
        {showSource && (
          <section className="dsd-section">
            <div className="dsd-section-label">Source</div>
            <div className="dsd-source-row">
              <span className="dsd-source-badge">{activeDebate.source_type}</span>
              {activeDebate.source_ref !== '' && (
                srcIsUrl ? (
                  <button
                    className="dsd-source-url-btn"
                    onClick={() => void api.openExternal(activeDebate.source_ref)}
                    aria-label={`Open source URL in browser: ${activeDebate.source_ref}`}
                  >
                    {humanizeUrl(activeDebate.source_ref)}
                  </button>
                ) : (
                  <code style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{activeDebate.source_ref}</code>
                )
              )}
              {activeDebate.source_ref !== '' && (
                <>
                  {srcIsUrl && (
                    <button
                      className="btn btn-sm"
                      onClick={() => void api.openExternal(activeDebate.source_ref)}
                      aria-label="Open source URL in browser"
                    >
                      Open
                    </button>
                  )}
                  <CopyButton text={activeDebate.source_ref} label="Copy source reference" />
                </>
              )}
            </div>
            {hasSourceContent && (
              <details
                style={{ marginTop: 10 }}
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open) setSourceEverOpened(true);
                }}
              >
                <summary className="dsd-summary">View source content</summary>
                {sourceEverOpened && (
                  <div className="dsd-source-content-wrap">
                    <DebateSourceViewer
                      content={activeDebate.source_content}
                      sourceType={srcIsUrl ? 'url' : 'document'}
                      sourceRef={activeDebate.source_ref}
                    />
                  </div>
                )}
              </details>
            )}
          </section>
        )}

        {/* BACKGROUND */}
        {activeDebate.topic.background && (
          <section className="dsd-section">
            <div className="dsd-section-label">Background</div>
            <p style={{ margin: 0, lineHeight: 1.6, fontSize: '0.9rem' }}>{activeDebate.topic.background}</p>
          </section>
        )}

        {/* SETUP */}
        <section className="dsd-section">
          <div className="dsd-section-label">Setup</div>
          <dl className="dsd-setup-dl">
            {audienceLabel && (
              <Fragment>
                <dt className="dsd-setup-dt">Audience</dt>
                <dd className="dsd-setup-dd">{audienceLabel}</dd>
              </Fragment>
            )}
            {activeDebate.debate_model && (
              <Fragment>
                <dt className="dsd-setup-dt">Model</dt>
                <dd className="dsd-setup-dd">{activeDebate.debate_model}</dd>
              </Fragment>
            )}
            {activeDebate.evaluator_model && (
              <Fragment>
                <dt className="dsd-setup-dt">Evaluator</dt>
                <dd className="dsd-setup-dd">{activeDebate.evaluator_model}</dd>
              </Fragment>
            )}
            {activeDebate.protocol_id && (
              <Fragment>
                <dt className="dsd-setup-dt">Protocol</dt>
                <dd className="dsd-setup-dd">
                  {activeDebate.protocol_id}
                  {activeDebate.moderator_mode ? ` · moderator: ${activeDebate.moderator_mode}` : ''}
                </dd>
              </Fragment>
            )}
            {activeDebate.debate_temperature !== undefined && (
              <Fragment>
                <dt className="dsd-setup-dt">Temp</dt>
                <dd className="dsd-setup-dd">
                  {activeDebate.debate_temperature}
                  {activeDebate.model_tier ? ` · Tier ${activeDebate.model_tier}` : ''}
                </dd>
              </Fragment>
            )}
            <Fragment>
              <dt className="dsd-setup-dt">Created</dt>
              <dd className="dsd-setup-dd">{createdStr}</dd>
            </Fragment>
            {activeDebate.origin && (
              <Fragment>
                <dt className="dsd-setup-dt">Origin</dt>
                <dd className="dsd-setup-dd">
                  {activeDebate.origin.mode}
                  {activeDebate.origin.command && (
                    <code style={{ marginLeft: 6, fontSize: '0.8rem', wordBreak: 'break-all' }}>
                      {activeDebate.origin.command}
                    </code>
                  )}
                </dd>
              </Fragment>
            )}
            <Fragment>
              <dt className="dsd-setup-dt">Well-tested nodes</dt>
              <dd className="dsd-setup-dd">{activeDebate.exclude_greatest_hits ? 'excluded' : 'included'}</dd>
            </Fragment>
          </dl>
          {hasDistinctStageModels && (
            <details style={{ marginTop: 10 }}>
              <summary className="dsd-summary">Per-stage models</summary>
              <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: '0.85rem' }}>
                {Object.entries(stageModels!).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt style={{ color: 'var(--text-secondary)' }}>{k}</dt>
                    <dd style={{ margin: 0 }}>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>
          )}
        </section>

        {/* IDENTIFIERS */}
        <section>
          <div className="dsd-section-label">Identifiers</div>
          <dl className="dsd-id-dl">
            <dt className="dsd-id-dt">id</dt>
            <dd style={{ margin: 0 }}><code className="dsd-id-code">{activeDebate.id}</code></dd>
            <dd style={{ margin: 0 }}><CopyButton text={activeDebate.id} label="Copy debate ID" /></dd>
            {activeDebate.run_id && (
              <Fragment>
                <dt className="dsd-id-dt">run_id</dt>
                <dd style={{ margin: 0 }}><code className="dsd-id-code">{activeDebate.run_id}</code></dd>
                <dd style={{ margin: 0 }}><CopyButton text={activeDebate.run_id} label="Copy run ID" /></dd>
              </Fragment>
            )}
          </dl>
        </section>

        <div className="dsd-live-region" aria-live="polite" aria-atomic="true" />
      </div>
    </div>
  );
}
