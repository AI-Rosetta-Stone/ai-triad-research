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
import { Share2 } from 'lucide-react';
import { isElectronMode } from '@bridge';
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

function ConfirmPopover({ provider, onConfirm, onCancel }: { provider: ShareProvider; onConfirm: () => void; onCancel: () => void }) {
  const label = provider.contentLabel ?? 'item';
  return (
    <div className="nav-locbar-share-popover" role="dialog" aria-label={`Share this ${label}`}>
      <p>Anyone with this link can view this {label}, without signing in.</p>
      <div className="nav-locbar-share-popover-actions">
        <button type="button" className="btn-xs" onClick={onConfirm}>Create link</button>
        <button type="button" className="btn-xs btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** TL p/336#781: replacing a link is a separate, confirmed action — never folded into
 *  create()'s "already shared → same link" path. */
function ReplacePopover({ provider, onConfirm, onCancel }: { provider: ShareProvider; onConfirm: () => void; onCancel: () => void }) {
  const label = provider.contentLabel ?? 'item';
  return (
    <div className="nav-locbar-share-popover" role="dialog" aria-label={`Create a new link for this ${label}`}>
      <p>This turns off the old link — anyone who has it will no longer be able to view this {label}.</p>
      <div className="nav-locbar-share-popover-actions">
        <button type="button" className="btn-xs" onClick={onConfirm}>Create a new link</button>
        <button type="button" className="btn-xs btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function SharePopover({ popover, provider, onConfirm, onCancel, popoverRef, onKeyDown }: {
  popover: Popover;
  provider: ShareProvider;
  onConfirm: () => void;
  onCancel: () => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}): ReactNode {
  if (popover === 'confirm') {
    return (
      <div ref={popoverRef} onKeyDown={onKeyDown}>
        <ConfirmPopover provider={provider} onConfirm={onConfirm} onCancel={onCancel} />
      </div>
    );
  }
  if (popover === 'replace') {
    return (
      <div ref={popoverRef} onKeyDown={onKeyDown}>
        <ReplacePopover provider={provider} onConfirm={onConfirm} onCancel={onCancel} />
      </div>
    );
  }
  if (popover === 'preview' && provider.renderPreview) {
    // InquiryShareDialog (the only current renderPreview) is its own full overlay+dialog —
    // this wraps it only for the Esc/outside-click/focus plumbing, not a second dialog role.
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
    if (refocus) buttonRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
  };

  const doCreateAndCopy = async () => {
    const url = await provider.create();
    setSharedUrl(url);
    setPopover('none');
    await copy(url);
  };

  const doReplaceAndCopy = async () => {
    if (!provider.replace) return;
    const url = await provider.replace();
    setSharedUrl(url);
    setPopover('none');
    await copy(url);
  };

  const onClick = () => {
    reset();
    const next = nextPopoverFor(sharedUrl ?? null, provider);
    if (next === 'copy') { void copy(sharedUrl as string); return; }
    if (next === 'create') { void doCreateAndCopy(); return; }
    setPopover(next);
  };

  const onRevoke = async () => {
    if (!provider.revoke) return;
    await provider.revoke();
    setSharedUrl(null);
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
        <Share2 aria-hidden="true" />
      </button>

      {sharedUrl && provider.replace && (
        <button type="button" className="nav-locbar-btn nav-locbar-share-revoke" onClick={() => setPopover('replace')} aria-label="Create a new link" title="Create a new link (turns off the old one)">
          New link
        </button>
      )}

      {sharedUrl && provider.revoke && (
        <button type="button" className="nav-locbar-btn nav-locbar-share-revoke" onClick={() => void onRevoke()} aria-label="Un-share" title="Un-share">
          Un-share
        </button>
      )}

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

      <span className="sr-only" aria-live="polite">{copied ? 'Link copied' : ''}</span>

      <SharePopover
        popover={popover}
        provider={provider}
        onConfirm={() => void (popover === 'replace' ? doReplaceAndCopy() : doCreateAndCopy())}
        onCancel={() => close(true)}
        popoverRef={popoverRef}
        onKeyDown={handleKeyDown}
      />
    </span>
  );
}
