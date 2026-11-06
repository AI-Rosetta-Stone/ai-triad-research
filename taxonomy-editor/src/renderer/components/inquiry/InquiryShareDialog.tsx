// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Mint-time disclosure preview (t/3654, SO condition on t/3623 e/201#2). Before an owner's
// public share link is minted, this shows them exactly what will be public — rendered, not a
// field list.
//
// TL constraint (t/3654#1): derive the preview from `toPublicInquiryShare(result)`, the real
// projector, and render it with the SAME component the public page uses
// (PublicInquiryShareContent) — never a separately hand-built mock. A preview assembled
// independently is a second implementation of "what goes public"; the moment it drifts it
// shows the user one thing while publishing another, which is worse than no preview at all.

import { toPublicInquiryShare } from '@lib/inquiry';
import type { InquiryResult } from '../../bridge/types';
import { PublicInquiryShareContent } from '../PublicInquiryShareContent';
import { useDialog } from '../shared/useDialog'; // t/4909
import '../shared/DialogOverlay.css';
import './InquiryShareDialog.css';

export function InquiryShareDialog({
  result, onConfirm, onCancel,
}: {
  result: InquiryResult;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const doc = toPublicInquiryShare(result);
  const { dialogRef, titleId } = useDialog({ onCancel });

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="dialog inquiry-share-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 className="inquiry-share-dialog-title" id={titleId}>This is what will be public</h3>
        <p className="inquiry-share-dialog-desc">
          Anyone with the link can read this — no sign-in required. Check the question text
          below: it&rsquo;s shared as written, so make sure it doesn&rsquo;t name anyone or
          reference anything you didn&rsquo;t intend to make public.
        </p>
        <div className="inquiry-share-dialog-preview">
          <PublicInquiryShareContent doc={doc} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>Create public link</button>
        </div>
      </div>
    </div>
  );
}
