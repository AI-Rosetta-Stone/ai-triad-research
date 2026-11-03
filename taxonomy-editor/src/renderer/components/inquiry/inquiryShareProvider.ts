// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4786: inquiry share provider for the location bar's ⧉ button. Wraps the SAME bridge
// calls as InquiryShareControl.tsx (api.shareInquiry/unshareInquiry) — not a new endpoint.
// TL t/4786#2 point 5: the confirmation offers "Preview what's public", opening the existing
// InquiryShareDialog (the SAME mint-time disclosure preview InquiryShareControl uses) rather
// than a less-informed generic confirm — inquiry answers can contain more to review than an
// op-ed's already-visible content.
//
// `current()` is a session-scoped cache (see opedShareProvider.ts's identical note) —
// publishInquiryShare is idempotent (reuses the existing shareId; inquiryShareStore.ts's own
// doc comment), so a prior-session share just re-shows the preview once, never a dup mint.

import { createElement } from 'react';
import { api } from '@bridge';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { registerShareProvider, type ShareProvider } from '../../navigation/shareProvider';
import { InquiryShareDialog } from './InquiryShareDialog';

const sharedUrlByJobId = new Map<string, string>();

function shareUrl(shareId: string): string {
  return new URL(`/inquiries/${encodeURIComponent(shareId)}`, window.location.origin).href;
}

registerShareProvider('inquiry', (place): ShareProvider | null => {
  const jobId = place.placeKey.slice(place.placeKey.indexOf(':') + 1);
  if (!jobId || jobId === 'none') return null;
  const { result, jobId: storeJobId } = useInquiryStore.getState();
  if (!result || storeJobId !== jobId) return null;

  const create = async () => {
    const { shareId } = await api.shareInquiry(jobId);
    const url = shareUrl(shareId);
    sharedUrlByJobId.set(jobId, url);
    return url;
  };

  return {
    label: 'Copy public link',
    needsConfirm: true,
    contentLabel: 'question',
    current: () => Promise.resolve(sharedUrlByJobId.get(jobId) ?? null),
    create,
    revoke: async () => {
      await api.unshareInquiry(jobId);
      sharedUrlByJobId.delete(jobId);
    },
    renderPreview: (onConfirm, onCancel) => createElement(InquiryShareDialog, { result, onConfirm, onCancel }),
  };
});
