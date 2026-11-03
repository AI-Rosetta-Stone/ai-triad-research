// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState, useRef } from 'react';
import { useCommunityStore, type CommunityChat, type CommunityDebate, type CommunityInquiry } from '../../hooks/useCommunityStore';
import type { OpEdCommunityEntry } from '../../../../../lib/oped/types';
import { opedCommunityTagText } from '../opeds/opedTagScopeText';
import { resolvePovMeta } from '../opeds/povResolve';
import { useFlag } from '../../hooks/useFeatureFlags';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { TOAST_DURATION_INFO, TOAST_DURATION_ERROR } from '../../constants';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import './CommunityLibrary.css';

type Tab = 'chats' | 'debates' | 'opeds' | 'inquiries';

/** Owner-facing tab labels (t/2891) — the raw key 'opeds' must never surface in UI copy. */
const TAB_LABELS: Record<Tab, string> = { debates: 'Debates', chats: 'Chats', opeds: 'Op-Ed Studies', inquiries: 'Questions' };

/** A community card renders any of the four shared item types. Op-eds carry `topic` and
 *  inquiries carry `question` (neither is `title`), with `unknown`-typed community_metadata,
 *  so title/submitter go through helpers. */
export type CommunityItem = CommunityChat | CommunityDebate | OpEdCommunityEntry | CommunityInquiry;

function cardTitle(item: CommunityItem): string {
  // Op-eds title from `topic`, inquiries from `question`; the store warns on either being
  // missing, so guard the UI too rather than render a blank card title (Design note, t/2891#2).
  if ('title' in item) return item.title;
  if ('question' in item) return item.question || 'Untitled question';
  return item.topic || 'Untitled study';
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'CommunityLibrary',
      level: 'warn',
      message: `Date parse fallback for '${iso}'`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return iso;
  }
}

function RemoveConfirmPopover({ item, onConfirm, onCancel }: {
  item: CommunityItem;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onCancel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className="community-remove-popover" ref={ref}>
      <div className="community-remove-popover-title">Remove from Community Library?</div>
      <div className="community-remove-popover-detail">
        <strong>{cardTitle(item)}</strong>
      </div>
      <textarea
        className="community-remove-reason"
        rows={2}
        maxLength={200}
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason (optional)"
        autoFocus
      />
      <div className="community-remove-actions">
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-danger" onClick={() => onConfirm(reason.trim())}>Remove</button>
      </div>
    </div>
  );
}

export function CommunityCard({ item, isAdmin, onCopy, onRemove }: {
  item: CommunityItem;
  isAdmin: boolean;
  onCopy: () => void;
  onRemove: (reason: string) => void;
}) {
  const [copying, setCopying] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleCopy = async () => {
    setCopying(true);
    try { await onCopy(); } finally { setCopying(false); }
  };

  return (
    <div className={`community-card${removing ? ' community-card-removing' : ''}`}>
      <div className="community-card-header">
        <div className="community-card-title">{cardTitle(item)}</div>
        {isAdmin && (
          <button
            className="btn btn-icon btn-ghost community-card-remove"
            onClick={() => setShowConfirm(true)}
            aria-label="Remove from community"
            title="Remove from community"
          >
            &#x2715;
          </button>
        )}
      </div>
      <div className="community-card-meta">
        <span>{formatDate(item.updated_at || item.created_at)}</span>
        {'phase' in item && item.phase && <span className="community-card-badge">{item.phase}</span>}
        {'mode' in item && item.mode && <span className="community-card-badge">{item.mode}</span>}
        {/* t/3992: an op-ed scoped to one wing says so in the list (TL t/3960#3 cond 2). */}
        {'voice_count' in item && item.tag && (
          <span className="community-card-badge">{opedCommunityTagText(resolvePovMeta(item.tag.pov).label, item.tag)}</span>
        )}
      </div>
      <button
        className="btn btn-sm btn-primary community-card-copy"
        onClick={() => void handleCopy()}
        disabled={copying}
      >
        {copying ? 'Copying...' : 'Copy to My Library'}
      </button>
      {showConfirm && (
        <RemoveConfirmPopover
          item={item}
          onCancel={() => setShowConfirm(false)}
          onConfirm={(reason) => {
            setShowConfirm(false);
            setRemoving(true);
            onRemove(reason);
          }}
        />
      )}
    </div>
  );
}

export function CommunityLibrary() {
  const { chats, debates, opeds, inquiries, loading, error, fetchChats, fetchDebates, fetchOpeds, fetchInquiries, copyItem, removeItem } = useCommunityStore();
  const [tab, setTab] = useState<Tab>('debates');
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'info' | 'error' } | null>(null);
  const isAdmin = useFlag('permission-admin-features');

  useEffect(() => { void fetchChats(); void fetchDebates(); void fetchOpeds(); void fetchInquiries(); }, []);

  const showToast = (text: string, type: 'info' | 'error' = 'info', durationMs = TOAST_DURATION_INFO) => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), durationMs);
  };

  const handleCopy = async (type: 'chats' | 'debates' | 'opeds' | 'inquiries', id: string) => {
    try {
      await copyItem(type, id);
      showToast('Copied to your library!');
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'CommunityLibrary', level: 'error', message: 'Failed to copy community item', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      showToast(`Error: ${mapErrorToUserMessage(err)}`, 'error', TOAST_DURATION_ERROR);
    }
  };

  const handleRemove = async (type: 'chats' | 'debates' | 'opeds' | 'inquiries', id: string, reason: string) => {
    try {
      await removeItem(type, id, reason || undefined);
      showToast('Removed from community library.');
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'CommunityLibrary', level: 'error', message: 'Failed to remove community item', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      showToast(`Removal failed: ${mapErrorToUserMessage(err)}`, 'error', TOAST_DURATION_ERROR);
    }
  };

  const handleBack = () => { window.location.hash = ''; window.location.reload(); };

  const itemsByTab: Record<Tab, CommunityItem[]> = { chats, debates, opeds, inquiries };
  const items = itemsByTab[tab];

  return (
    <div className="community-library">
      <div className="community-header">
        <button className="btn btn-ghost" onClick={handleBack}>&larr; Back</button>
        <h2>Community Library</h2>
        {isAdmin && (
          <button
            className="btn btn-ghost"
            onClick={() => { window.location.hash = '#admin'; }}
          >
            Admin Panel
          </button>
        )}
      </div>

      <div className="community-tabs">
        <button
          className={`community-tab ${tab === 'debates' ? 'active' : ''}`}
          onClick={() => setTab('debates')}
        >
          Debates ({debates.length})
        </button>
        <button
          className={`community-tab ${tab === 'chats' ? 'active' : ''}`}
          onClick={() => setTab('chats')}
        >
          Chats ({chats.length})
        </button>
        <button
          className={`community-tab ${tab === 'opeds' ? 'active' : ''}`}
          onClick={() => setTab('opeds')}
        >
          Op-Ed Studies ({opeds.length})
        </button>
        <button
          className={`community-tab ${tab === 'inquiries' ? 'active' : ''}`}
          onClick={() => setTab('inquiries')}
        >
          Questions ({inquiries.length})
        </button>
      </div>

      {toastMsg && (
        <div className={`community-toast${toastMsg.type === 'error' ? ' community-toast-error' : ''}`}>
          {toastMsg.text}
        </div>
      )}
      {error && <div className="community-error">{error}</div>}

      <div className="community-grid">
        {loading && items.length === 0 && <div className="community-empty">Loading...</div>}
        {!loading && items.length === 0 && <div className="community-empty">No community {TAB_LABELS[tab]} yet. Be the first to submit!</div>}
        {items.map(item => (
          <CommunityCard
            key={item.id}
            item={item}
            isAdmin={isAdmin}
            onCopy={() => handleCopy(tab, item.id)}
            onRemove={(reason) => void handleRemove(tab, item.id, reason)}
          />
        ))}
      </div>
    </div>
  );
}
