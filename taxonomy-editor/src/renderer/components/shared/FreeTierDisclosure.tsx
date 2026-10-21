// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4410 item D: shown once per browser to web users the server serves from the free Gemini pool
// (`/api/proxy/tier` → level 'free' with serverProvidedKey), at load, so it is in front of them before their
// first AI request. Non-blocking (TL p/336#645). If storage is unavailable it shows again next visit: a repeat
// notice is the safe failure for a disclosure, never a missing one.

import { useEffect, useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { bridgeGet } from '../../bridge/web-bridge';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';
import type { TierInfo } from '../../hooks/useTierInfo';
import { FREE_TIER_NOTICE, FREE_TIER_SETTINGS_LINE, GEMINI_TERMS_URL } from './freeTierDisclosureCopy';
import './FreeTierDisclosure.css';

/** Versioned: a material copy change bumps it so everyone sees the new text once. */
export const FREE_TIER_DISCLOSURE_STORAGE_KEY = 'aitriad.freeTierDisclosure.v1';

function readAcknowledged(): boolean {
  try {
    return localStorage.getItem(FREE_TIER_DISCLOSURE_STORAGE_KEY) === 'ack';
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-tier-disclosure', level: 'warn',
      message: 'localStorage unreadable; showing the free-tier disclosure (WARN: fallback to show)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

function writeAcknowledged(): void {
  try {
    localStorage.setItem(FREE_TIER_DISCLOSURE_STORAGE_KEY, 'ack');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-tier-disclosure', level: 'warn',
      message: 'localStorage unwritable; the free-tier disclosure will show again next visit (WARN: fallback)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

const servedByFreePool = (t: TierInfo | null): boolean => t?.level === 'free' && t.serverProvidedKey === true;

/** One tier fetch (web build only, and only when `enabled`): whether the server serves this user from the free pool. */
function useServedByFreePool(enabled: boolean): boolean {
  const [served, setServed] = useState(false);
  useEffect(() => {
    if (import.meta.env.VITE_TARGET !== 'web' || !enabled) return;
    let cancelled = false;
    bridgeGet<TierInfo>('/api/proxy/tier')
      .then((tier) => { if (!cancelled) setServed(servedByFreePool(tier)); })
      .catch((err) => {
        // Without the tier we can't tell whether this user is on the free pool. The same request gates the AI
        // features, so retrying on the next load is enough; record it rather than guessing.
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'free-tier-disclosure', level: 'warn',
          message: 'Tier fetch failed; free-tier disclosure not evaluated this load',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      });
    return () => { cancelled = true; };
  }, [enabled]);
  return served;
}

export function FreeTierDisclosure() {
  const [acknowledged, setAcknowledged] = useState(readAcknowledged);
  const show = useServedByFreePool(!acknowledged) && !acknowledged;
  const openSettings = useSettingsDialog((s) => s.open);

  useEffect(() => {
    if (show) getGlobalRecorder()?.record({ type: 'state.change', component: 'free-tier-disclosure', level: 'info', message: 'Free-tier data-use disclosure shown' });
  }, [show]);

  if (!show) return null;

  const acknowledge = (via: 'got-it' | 'add-key') => {
    writeAcknowledged();
    setAcknowledged(true);
    getGlobalRecorder()?.record({ type: 'state.change', component: 'free-tier-disclosure', level: 'info', message: 'Free-tier data-use disclosure acknowledged', data: { via } });
    if (via === 'add-key') openSettings('apiKeys');
  };

  return (
    <div className="free-tier-disclosure" role="region" aria-label={FREE_TIER_NOTICE.title}>
      <div className="free-tier-disclosure-text">
        <strong className="free-tier-disclosure-title">{FREE_TIER_NOTICE.title}</strong>{' '}
        {FREE_TIER_NOTICE.body} {FREE_TIER_NOTICE.remedy}{' '}
        <a href={GEMINI_TERMS_URL} target="_blank" rel="noopener noreferrer">{FREE_TIER_NOTICE.terms}</a>
      </div>
      <div className="free-tier-disclosure-actions">
        <button type="button" className="free-tier-disclosure-add" onClick={() => acknowledge('add-key')}>
          {FREE_TIER_NOTICE.addKey}
        </button>
        <button type="button" className="free-tier-disclosure-ack" onClick={() => acknowledge('got-it')}>
          {FREE_TIER_NOTICE.acknowledge}
        </button>
      </div>
    </div>
  );
}

/** The key-settings line (t/4410 item D): shown whenever this user is served by the free pool, acknowledged or not. */
export function FreeTierSettingsNote() {
  if (!useServedByFreePool(true)) return null;
  return (
    <p className="free-tier-settings-note">
      {FREE_TIER_SETTINGS_LINE}{' '}
      <a href={GEMINI_TERMS_URL} target="_blank" rel="noopener noreferrer">{FREE_TIER_NOTICE.terms}</a>
    </p>
  );
}
