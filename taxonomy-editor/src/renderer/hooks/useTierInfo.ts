// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useCallback } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { bridgeGet } from '../bridge/web-bridge';
import { gatedInterval } from '../lib/pollGate';

export interface TierInfo {
  level: string;
  limits: { requestsPerMinute: number; tokensPerDay: number };
  allowedBackends: string[];
  principalName: string | null;
  serverProvidedKey?: boolean;
  pinnedModel?: string;
}

export interface TierUsage {
  tier: string;
  limits: { requestsPerMinute: number; tokensPerDay: number };
  usage: { requestsInWindow: number; tokensToday: number; resetsAt?: string };
}

const USAGE_POLL_MS = 30_000;

export function useTierInfo(): { tier: TierInfo | null; usage: TierUsage | null; loading: boolean; refresh: () => void } {
  const [tier, setTier] = useState<TierInfo | null>(null);
  const [usage, setUsage] = useState<TierUsage | null>(null);
  const [loading, setLoading] = useState(true);

  const isWeb = import.meta.env.VITE_TARGET === 'web';

  const fetchTier = useCallback(() => {
    if (!isWeb) { setLoading(false); return; }
    bridgeGet<TierInfo>('/api/proxy/tier')
      .then((data) => setTier(data))
      .catch((err) => {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'useTierInfo', level: 'warn',
          message: 'Failed to fetch proxy tier',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      })
      .finally(() => setLoading(false));
  }, [isWeb]);

  const fetchUsage = useCallback(() => {
    if (!isWeb) return;
    bridgeGet<TierUsage>('/api/proxy/usage')
      .then((data) => setUsage(data))
      .catch((err) => {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'useTierInfo', level: 'warn',
          message: 'Failed to fetch proxy usage',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      });
  }, [isWeb]);

  useEffect(() => {
    fetchTier();
    fetchUsage();
    if (!isWeb) return;
    // t/4251: only while the tab is visible and the user is active.
    return gatedInterval(fetchUsage, USAGE_POLL_MS);
  }, [fetchTier, fetchUsage, isWeb]);

  const refresh = useCallback(() => { fetchTier(); fetchUsage(); }, [fetchTier, fetchUsage]);

  return { tier, usage, loading, refresh };
}

export function isFreeTier(tier: TierInfo | null): boolean {
  return tier?.level === 'free';
}
