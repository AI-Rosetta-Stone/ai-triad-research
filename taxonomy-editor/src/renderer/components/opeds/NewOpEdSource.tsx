// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276: the source selector and the "Document" source for NewOpEdDialog (Design t/272).
// Kept apart from the dialog so each file stays inside its complexity budget.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { documentPickErrorLine } from './documentPickError';

/** One source is active at a time (Design t/272#1). Each mode keeps its value until the dialog closes. */
export type SourceMode = 'topic' | 'web' | 'document';
/** idle = no file; reading = picker and extraction running; ready = text extracted; error = failed or empty. */
export type DocumentState = 'idle' | 'reading' | 'ready' | 'error';
export interface DocumentChoice { name: string; text: string; words: number }

export const SOURCE_MODES: SourceMode[] = ['topic', 'web', 'document'];
const SOURCE_LABELS: Record<SourceMode, string> = { topic: 'Topic', web: 'Web page', document: 'Document' };

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Whether the active source can be submitted. Only the active mode counts (Design t/272#7). */
export function hasSourceFor(mode: SourceMode, topic: string, url: string, docState: DocumentState, docFile: DocumentChoice | null): boolean {
  if (mode === 'topic') return topic.trim().length > 0;
  if (mode === 'web') return url.trim().length > 0;
  return docState === 'ready' && docFile !== null;
}

/**
 * The visible Start reason (Design t/272#7). Checked in order: the source, then voices, then the key.
 * Undefined when Start is on.
 */
export function sourceStartReason(mode: SourceMode, docState: DocumentState, hasSource: boolean, voiceCount: number, modelHasKey: boolean): string | undefined {
  if (!hasSource) {
    if (mode === 'topic') return 'Enter a topic';
    if (mode === 'web') return 'Enter a web page URL';
    if (docState === 'reading') return 'Reading the document…';
    return docState === 'error' ? 'Choose a readable document' : 'Choose a document';
  }
  if (voiceCount < 1) return 'Select at least one voice';
  if (!modelHasKey) return 'No API key configured for the selected model';
  return undefined;
}

/** Radio group for the source; arrow keys move and select, Tab leaves the group (Design t/272#1). */
export function SourceSelector({ sourceMode, setSourceMode, modes }: {
  sourceMode: SourceMode; setSourceMode: (v: SourceMode) => void; modes: SourceMode[];
}) {
  const handleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = (modes.indexOf(sourceMode) + step + modes.length) % modes.length;
    buttons[next]?.focus();
    setSourceMode(modes[next]);
  };
  return (
    <div className="oped-source-selector" role="radiogroup" aria-label="Source" onKeyDown={handleKey}>
      {modes.map(m => {
        const selected = sourceMode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`oped-source-seg${selected ? ' is-selected' : ''}`}
            onClick={() => setSourceMode(m)}
          >
            {SOURCE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}

/** The Document field: an empty drop-zone state, or the chosen-file chip (Design t/272#2–6). */
export function DocumentField({ docFile, docState, docError, isAnonymous, onPick, onRemove }: {
  docFile: DocumentChoice | null; docState: DocumentState; docError: string | null;
  isAnonymous: boolean; onPick: () => void; onRemove: () => void;
}) {
  const reading = docState === 'reading';
  const chooseRef = useRef<HTMLButtonElement>(null);
  const removingRef = useRef(false);
  // Removing the chip unmounts its × button, so focus would fall to <body>. Hand it to Choose a file (Design t/272#4).
  useEffect(() => {
    if (!docFile && removingRef.current) {
      removingRef.current = false;
      chooseRef.current?.focus();
    }
  }, [docFile]);
  const handleRemove = () => {
    removingRef.current = true;
    onRemove();
  };
  return (
    <div>
      <span className="oped-field-label" id="oped-document-label">
        Document <span className="oped-required-mark" aria-hidden="true">*</span>
      </span>
      {docFile ? (
        <div className={`oped-doc-chip${docState === 'error' ? ' is-error' : ''}`}>
          <span className="oped-doc-name" title={docFile.name}>{docFile.name}</span>
          <span className="oped-doc-meta" aria-live="polite">
            {reading ? 'Reading document…' : docState === 'ready' ? `~${docFile.words.toLocaleString()} words` : ''}
          </span>
          <button type="button" className="oped-source-toggle" onClick={onPick} disabled={reading || isAnonymous}>Replace</button>
          <button type="button" className="oped-doc-remove" aria-label={`Remove ${docFile.name}`} onClick={handleRemove} disabled={reading}>×</button>
        </div>
      ) : (
        <div className={`oped-doc-zone${isAnonymous ? ' is-disabled' : ''}`} aria-disabled={isAnonymous || undefined}>
          {reading ? (
            <p className="oped-doc-status" aria-live="polite">Reading document…</p>
          ) : (
            <button ref={chooseRef} type="button" className="btn" onClick={onPick} disabled={isAnonymous}>
              Choose a file…
            </button>
          )}
          <p className="oped-doc-hint">PDF, Word (.docx), plain text or Markdown · up to 10 MB</p>
        </div>
      )}
      {isAnonymous && <p className="oped-signin-note">Sign in to upload a document.</p>}
      {docError && <p className="oped-doc-error" role="alert">{docError}</p>}
    </div>
  );
}

/**
 * The picked document and its state. The desktop picker extracts in main; web sends the bytes to
 * /api/documents/extract (web-bridge). Either way the text arrives before the chip shows, so a bad
 * file never reaches create (Design t/272#3–5).
 */
export function useDocumentSource() {
  const [docFile, setDocFile] = useState<DocumentChoice | null>(null);
  const [docState, setDocState] = useState<DocumentState>('idle');
  const [docError, setDocError] = useState<string | null>(null);

  const pick = async () => {
    setDocState('reading');
    setDocError(null);
    try {
      const res = await api.pickDocumentFile();
      if (res.cancelled || res.content === undefined) {
        setDocState(docFile ? 'ready' : 'idle');
        return;
      }
      const name = res.filePath ?? 'document';
      const words = countWords(res.content);
      setDocFile({ name, text: res.content, words });
      if (words === 0) {
        setDocState('error');
        setDocError('This file has no readable text.');
        return;
      }
      setDocState('ready');
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped-new-dialog', level: 'warn', message: 'WARN: document pick failed; the field shows a plain line, the raw error is recorded here', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      setDocFile(null);
      setDocState('error');
      // t/632: never the raw text (the desktop IPC wrapper carries an ActionableError dump and the user's paths).
      setDocError(documentPickErrorLine(err));
    }
  };

  const remove = () => {
    setDocFile(null);
    setDocState('idle');
    setDocError(null);
  };

  return { docFile, docState, docError, pick, remove };
}
