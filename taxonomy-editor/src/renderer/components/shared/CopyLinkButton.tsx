// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useCopyWithFeedback } from '../../hooks/useCopyWithFeedback';
import './CopyLinkButton.css';

const ICON_SIZES = { sm: 16, md: 20 } as const;

function LinkIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

interface CopyLinkButtonProps {
  hash: string;
  title?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function CopyLinkButton({ hash, title, size = 'sm', className }: CopyLinkButtonProps) {
  const [baseUrl, setBaseUrl] = useState<string | null | undefined>(undefined);
  const { copied, failed, copy } = useCopyWithFeedback();
  const iconSize = ICON_SIZES[size];

  useEffect(() => {
    api.getWebAppUrl().then(setBaseUrl).catch((err) => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'copy-link-button',
        level: 'warn',
        message: 'Failed to resolve web app URL',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setBaseUrl(null);
    });
  }, []);

  if (baseUrl === undefined) return null;

  const disabled = baseUrl === null;
  const label = title ?? 'Copy link';
  const url = `${baseUrl}${hash}`;
  const tooltipText = disabled
    ? 'Deep links require the web app'
    : copied
      ? 'Copied!'
      : label;

  // t/4786 (TL point 4): a failed clipboard write is never silent — a read-only, pre-selected
  // field stands in for the icon button so the user can still copy the link by hand.
  if (failed) {
    return (
      <span className={`copy-link-fallback${className ? ` ${className}` : ''}`}>
        <input
          className="copy-link-fallback-url"
          type="text"
          readOnly
          value={url}
          aria-label={label}
          onFocus={e => e.currentTarget.select()}
        />
        <button type="button" className="btn-xs btn-ghost" onClick={() => void copy(url)}>Copy this link</button>
      </span>
    );
  }

  return (
    <button
      className={`btn-xs btn-ghost${disabled ? ' btn-disabled' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => { if (!disabled) void copy(url); }}
      title={tooltipText}
      aria-label={label}
      disabled={disabled}
    >
      {copied ? <CheckIcon size={iconSize} /> : <LinkIcon size={iconSize} />}
    </button>
  );
}
