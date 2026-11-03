// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Public share control for inquiry answers (t/3654). Mirrors OpEdTab.tsx's ShareOpEdControl
// exactly (same ShareState shape, same copy/un-share flow) with one addition: clicking "Share"
// opens a mint-time disclosure preview (InquiryShareDialog) first — Confirm there mints the
// link, Cancel mints nothing. TL (t/3654#1): Electron hides this control entirely rather than
// shipping a button that always errors — same web-only posture as op-ed sharing.

import { useState, useCallback } from 'react';
import { api, isElectronMode } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import type { InquiryResult } from '../../bridge/types';
import { InquiryShareDialog } from './InquiryShareDialog';
import '../opeds/OpEdTab.css';

type ShareState =
  | { status: 'idle' }
  | { status: 'previewing' }
  | { status: 'working' }
  | { status: 'shared'; url: string; copied: boolean }
  | { status: 'error'; message: string };

export function InquiryShareControl({ jobId, result }: { jobId: string; result: InquiryResult }) {
  const [state, setState] = useState<ShareState>({ status: 'idle' });

  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setState({ status: 'shared', url, copied: true });
    } catch {
      /* clipboard denied — silent by design; link shown for manual copy */
      setState({ status: 'shared', url, copied: false });
    }
  }, []);

  const onConfirmShare = useCallback(async () => {
    setState({ status: 'working' });
    try {
      const { shareId } = await api.shareInquiry(jobId);
      const url = new URL(`/inquiries/${encodeURIComponent(shareId)}`, window.location.origin).href;
      await copy(url);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'InquiryShareControl', level: 'error',
        message: 'Failed to publish an inquiry share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setState({ status: 'error', message: mapErrorToUserMessage(err) });
    }
  }, [jobId, copy]);

  const onUnshare = useCallback(async () => {
    setState({ status: 'working' });
    try {
      await api.unshareInquiry(jobId);
      setState({ status: 'idle' });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'InquiryShareControl', level: 'error',
        message: 'Failed to revoke an inquiry share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setState({ status: 'error', message: mapErrorToUserMessage(err) });
    }
  }, [jobId]);

  // t/4611: Show unavailability reason instead of silently hiding (was: hide, don't error per t/3654#1).
  if (isElectronMode()) {
    return (
      <span className="oped-share" title="Public sharing is available in the web app only">
        <button
          type="button"
          className="inquiry-ghost"
          disabled
          title="Public sharing is available in the web app only"
        >
          Share (web only)
        </button>
      </span>
    );
  }

  if (state.status === 'previewing') {
    return (
      <InquiryShareDialog
        result={result}
        onCancel={() => setState({ status: 'idle' })}
        onConfirm={() => void onConfirmShare()}
      />
    );
  }

  if (state.status === 'shared') {
    return (
      <span className="oped-share oped-share-active">
        <span className="oped-share-status" role="status">{state.copied ? 'Link copied' : 'Public link ready'}</span>
        <input className="oped-share-url" type="text" readOnly value={state.url} aria-label="Public share link"
          onFocus={e => e.currentTarget.select()} />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy(state.url)}>Copy</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onUnshare()}>Un-share</button>
      </span>
    );
  }

  return (
    <span className="oped-share">
      <button
        type="button"
        className="inquiry-ghost"
        onClick={() => setState({ status: 'previewing' })}
        disabled={state.status === 'working'}
        aria-label="Create a public share link"
        title="Creates a public, no-login link — different from this page's address bar URL"
      >
        {state.status === 'working' ? 'Sharing…' : '🔗 Share'}
      </button>
      {state.status === 'error' && <span className="oped-share-error" role="alert">{state.message}</span>}
    </span>
  );
}
