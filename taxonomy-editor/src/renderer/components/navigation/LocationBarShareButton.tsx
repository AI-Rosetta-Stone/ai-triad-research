// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4786: ⧉ "copy public link" at the location bar's right end, web build only — desktop
// items are local, so there's no server link (TL t/4786#2: isElectronMode(), matching the
// existing runtime check InquiryShareControl/ShareOpEdControl already use).
//
// Popover focus management mirrors LocationBarHost.tsx's RecentMenu: focus moves into the
// popover on open, Esc closes it and returns focus to the trigger button, and a click outside
// closes it too.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Share2, Check } from 'lucide-react';
import { isElectronMode } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { PlaceInfo } from '../../navigation/types';
import { getShareProvider, type ShareProvider } from '../../navigation/shareProvider';
import { useCopyWithFeedback } from '../../hooks/useCopyWithFeedback';
import './LocationBarShareButton.css';

type Popover = 'none' | 'confirm' | 'preview' | 'replace';

function tooltipFor(failed: boolean, copied: boolean, label: string): string {
  if (failed) return 'Copy failed — use the field below';
  if (copied) return 'Copied!';
  return label;
}

/** Already shared → copy at once (TL point 2: never re-confirm or re-mint). Not shared and no
 *  confirmation needed (POV) → create and copy. Otherwise, open the confirm/preview popover. */
function nextPopoverFor(sharedUrl: string | null, provider: ShareProvider): Popover | 'copy' | 'create' {
  if (sharedUrl) return 'copy';
  if (!provider.needsConfirm) return 'create';
  return provider.renderPreview ? 'preview' : 'confirm';
}

/** Design review (t/4786#review): a failed create()/replace()/revoke() is never silent. */
function InlineActionError({ message }: { message: string }) {
  return <p className="nav-locbar-share-error" role="alert">{message}</p>;
}

function ConfirmPopover({ provider, error, onConfirm, onCancel }: { provider: ShareProvider; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const label = provider.contentLabel ?? 'item';
  return (
    <div className="nav-locbar-share-popover" role="dialog" aria-label={`Share this ${label}`}>
      <p>Anyone with this link can view this {label}, without signing in.</p>
      {error && <InlineActionError message={error} />}
      <div className="nav-locbar-share-popover-actions">
        <button type="button" className="btn-xs" onClick={onConfirm}>Create link</button>
        <button type="button" className="btn-xs btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** TL p/336#781: replacing a link is a separate, confirmed action — never folded into
 *  create()'s "already shared → same link" path. */
function ReplacePopover({ provider, error, onConfirm, onCancel }: { provider: ShareProvider; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const label = provider.contentLabel ?? 'item';
  return (
    <div className="nav-locbar-share-popover" role="dialog" aria-label={`Create a new link for this ${label}`}>
      <p>This turns off the old link — anyone who has it will no longer be able to view this {label}.</p>
      {error && <InlineActionError message={error} />}
      <div className="nav-locbar-share-popover-actions">
        <button type="button" className="btn-xs" onClick={onConfirm}>Create a new link</button>
        <button type="button" className="btn-xs btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function SharePopover({ popover, provider, error, onConfirm, onCancel, popoverRef, onKeyDown }: {
  popover: Popover;
  provider: ShareProvider;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}): ReactNode {
  if (popover === 'confirm') {
    return (
      <div ref={popoverRef} onKeyDown={onKeyDown}>
        <ConfirmPopover provider={provider} error={error} onConfirm={onConfirm} onCancel={onCancel} />
      </div>
    );
  }
  if (popover === 'replace') {
    return (
      <div ref={popoverRef} onKeyDown={onKeyDown}>
        <ReplacePopover provider={provider} error={error} onConfirm={onConfirm} onCancel={onCancel} />
      </div>
    );
  }
  if (popover === 'preview' && provider.renderPreview) {
    // InquiryShareDialog (the only current renderPreview) is its own full overlay+dialog —
    // this wraps it only for the Esc/outside-click/focus plumbing, not a second dialog role.
    // It has no error slot of its own, so a create() failure here surfaces via the button's
    // own inline error below (the dialog stays open; onConfirm doesn't close it on failure).
    return (
      <div ref={popoverRef} onKeyDown={onKeyDown}>
        {provider.renderPreview(onConfirm, onCancel)}
      </div>
    );
  }
  return null;
}

export function LocationBarShareButton({ place }: { place: PlaceInfo }) {
  const provider = isElectronMode() ? null : getShareProvider(place);
  return provider ? <ShareButtonInner key={place.placeKey} provider={provider} /> : null;
}

function ShareButtonInner({ provider }: { provider: ShareProvider }) {
  const [sharedUrl, setSharedUrl] = useState<string | null | undefined>(undefined);
  const [popover, setPopover] = useState<Popover>('none');
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const { copied, failed, copy, reset } = useCopyWithFeedback();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void provider.current().then(url => { if (!cancelled) setSharedUrl(url); });
    return () => { cancelled = true; };
  }, [provider]);

  useEffect(() => {
    if (popover === 'none') return;
    popoverRef.current?.querySelector<HTMLElement>('button, input')?.focus();
  }, [popover]);

  useEffect(() => {
    if (popover === 'none') return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!popoverRef.current?.contains(target) && !buttonRef.current?.contains(target)) setPopover('none');
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [popover]);

  const close = (refocus: boolean) => {
    setPopover('none');
    setActionError(null);
    if (refocus) buttonRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
  };

  // Keeps the popover open and shows an inline error on failure (Design review): a failed
  // create()/replace() is never silent, and the user doesn't lose their place to retry.
  const doCreateAndCopy = async () => {
    setActionError(null);
    try {
      const url = await provider.create();
      setSharedUrl(url);
      setPopover('none');
      await copy(url);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'LocationBarShareButton', level: 'warn',
        message: 'Failed to create a public share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setActionError("Couldn't create the link. Try again.");
    }
  };

  const doReplaceAndCopy = async () => {
    if (!provider.replace) return;
    setActionError(null);
    try {
      const url = await provider.replace();
      setSharedUrl(url);
      setPopover('none');
      await copy(url);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'LocationBarShareButton', level: 'warn',
        message: 'Failed to replace a public share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setActionError("Couldn't create the link. Try again.");
    }
  };

  const onClick = () => {
    reset();
    const next = nextPopoverFor(sharedUrl ?? null, provider);
    if (next === 'copy') { void copy(sharedUrl as string); return; }
    if (next === 'create') { void doCreateAndCopy(); return; }
    setActionError(null);
    setPopover(next);
  };

  const onRevoke = async () => {
    if (!provider.revoke) return;
    setActionError(null);
    try {
      await provider.revoke();
      setSharedUrl(null);
      setAnnouncement('Link turned off');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'LocationBarShareButton', level: 'warn',
        message: 'Failed to revoke a public share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setActionError("Couldn't turn off the link. Try again.");
    }
  };

  if (sharedUrl === undefined) return null; // still resolving current() — avoid a flash of the wrong state

  return (
    <span className="nav-locbar-share-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="nav-locbar-btn nav-locbar-share"
        onClick={onClick}
        aria-label={provider.label}
        aria-haspopup={popover !== 'none' ? 'dialog' : undefined}
        aria-expanded={popover !== 'none' || undefined}
        title={tooltipFor(failed, copied, provider.label)}
      >
        {copied ? <Check aria-hidden="true" /> : <Share2 aria-hidden="true" />}
      </button>

      {sharedUrl && provider.replace && (
        <button type="button" className="nav-locbar-btn nav-locbar-share-revoke" onClick={() => { setActionError(null); setPopover('replace'); }} aria-label="Create a new link" title="Create a new link (turns off the old one)">
          New link
        </button>
      )}

      {sharedUrl && provider.revoke && (
        <button type="button" className="nav-locbar-btn nav-locbar-share-revoke" onClick={() => void onRevoke()} aria-label="Un-share" title="Un-share">
          Un-share
        </button>
      )}

      {/* Un-share's own failure — the confirm/replace popovers show theirs inline above. */}
      {actionError && popover === 'none' && <InlineActionError message={actionError} />}

      {failed && (
        <span className="nav-locbar-share-fallback">
          <input
            type="text"
            readOnly
            value={sharedUrl ?? ''}
            aria-label="Public share link"
            onFocus={e => e.currentTarget.select()}
          />
          <button type="button" className="btn-xs btn-ghost" onClick={() => sharedUrl && void copy(sharedUrl)}>Copy this link</button>
        </span>
      )}

      <span className="sr-only" aria-live="polite">{copied ? 'Link copied' : announcement}</span>

      <SharePopover
        popover={popover}
        provider={provider}
        error={actionError}
        onConfirm={() => void (popover === 'replace' ? doReplaceAndCopy() : doCreateAndCopy())}
        onCancel={() => close(true)}
        popoverRef={popoverRef}
        onKeyDown={handleKeyDown}
      />
    </span>
  );
}
