// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { bridgeGet, bridgePost } from '../bridge/web-bridge';
import { useTaxonomyStore } from './useTaxonomyStore';
import { mapErrorToUserMessage } from '../utils/errorMessages';
import type { OpEdCommunityEntry } from '../../../../lib/oped/types';
import type { SpeakerId } from '../../../../lib/chat/types';

export interface CommunityItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  community_metadata?: {
    submitted_by_display: string;
    submitted_at: string;
    approved_at: string;
    original_id: string;
  };
}

export interface CommunityChat extends CommunityItem {
  mode?: string;
  model?: string;
  pover?: Exclude<SpeakerId, 'user'>;
}

export interface CommunityDebate extends CommunityItem {
  phase?: string;
  // Populated by the community list payload once the server-side surfacing lands
  // (t/2368, ServerAPI); optional so the type is valid before/after that. Lets
  // DebateTable read cd.model / cd.turn_count directly instead of duck-typing (t/2362).
  model?: string;
  turn_count?: number;
}

/** t/3622 — community inquiry entry. Mirrors OpEdCommunityEntry's shape (question ~ topic,
 *  verdict_count ~ voice_count); server projection lives in community.ts's listCommunityInquiries. */
export interface CommunityInquiry {
  id: string;
  question: string;
  created_at: string;
  updated_at: string;
  camps: string[];
  verdict_count: number;
  community_metadata?: CommunityItem['community_metadata'];
}

export interface Submission {
  id: string;
  type: 'chat' | 'debate' | 'oped' | 'inquiry';
  originalId: string;
  submittedBy: string;
  submittedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  note?: string;
}

interface CommunityStore {
  chats: CommunityChat[];
  debates: CommunityDebate[];
  opeds: OpEdCommunityEntry[];
  inquiries: CommunityInquiry[];
  submissions: Submission[];
  loading: boolean;
  error: string | null;

  fetchChats: () => Promise<void>;
  fetchDebates: () => Promise<void>;
  fetchOpeds: () => Promise<void>;
  fetchInquiries: () => Promise<void>;
  fetchSubmissions: (status?: string) => Promise<void>;
  submitItem: (type: 'chat' | 'debate' | 'oped' | 'inquiry', data: unknown, note?: string) => Promise<string>;
  copyItem: (type: 'chats' | 'debates' | 'opeds' | 'inquiries', communityId: string) => Promise<string>;
  removeItem: (type: 'chats' | 'debates' | 'opeds' | 'inquiries', id: string, reason?: string) => Promise<void>;
  approveSubmission: (id: string) => Promise<void>;
  rejectSubmission: (id: string) => Promise<void>;
}

function isElectronMode(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

function getCommunityBaseUrl(): string {
  if (!isElectronMode()) return '';
  const url = useTaxonomyStore.getState().communityServerUrl;
  return url.replace(/\/+$/, '');
}

export const useCommunityStore = create<CommunityStore>((set) => ({
  chats: [],
  debates: [],
  opeds: [],
  inquiries: [],
  submissions: [],
  loading: false,
  error: null,

  fetchChats: async () => {
    if (isElectronMode()) { set({ chats: [], loading: false }); return; }
    set({ loading: true, error: null });
    try {
      const chats = await bridgeGet<CommunityChat[]>('/api/community/chats');
      set({ chats, loading: false });
      api.trackEvent('community_browse', 'community', { type: 'chats', count: chats.length });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'error', message: 'Failed to fetch community chats', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ error: mapErrorToUserMessage(err), loading: false });
    }
  },

  fetchDebates: async () => {
    if (isElectronMode()) { set({ debates: [], loading: false }); return; }
    set({ loading: true, error: null });
    try {
      const debates = await bridgeGet<CommunityDebate[]>('/api/community/debates');
      set({ debates, loading: false });
      api.trackEvent('community_browse', 'community', { type: 'debates', count: debates.length });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'error', message: 'Failed to fetch community debates', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ error: mapErrorToUserMessage(err), loading: false });
    }
  },

  fetchOpeds: async () => {
    if (isElectronMode()) { set({ opeds: [], loading: false }); return; }
    set({ loading: true, error: null });
    try {
      const opeds = await bridgeGet<OpEdCommunityEntry[]>('/api/community/opeds');
      const missing = opeds.filter(e => !e.topic);
      if (missing.length > 0) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'warn', message: `community opeds missing topic on ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.map(e => e.id).join(', ')}` });
      }
      set({ opeds, loading: false });
      api.trackEvent('community_browse', 'community', { type: 'opeds', count: opeds.length });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'error', message: 'Failed to fetch community op-eds', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ error: mapErrorToUserMessage(err), loading: false });
    }
  },

  fetchInquiries: async () => {
    if (isElectronMode()) { set({ inquiries: [], loading: false }); return; }
    set({ loading: true, error: null });
    try {
      const inquiries = await bridgeGet<CommunityInquiry[]>('/api/community/inquiries');
      set({ inquiries, loading: false });
      api.trackEvent('community_browse', 'community', { type: 'inquiries', count: inquiries.length });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'error', message: 'Failed to fetch community inquiries', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ error: mapErrorToUserMessage(err), loading: false });
    }
  },

  fetchSubmissions: async (status?: string) => {
    if (isElectronMode()) { set({ submissions: [], loading: false }); return; }
    set({ loading: true, error: null });
    try {
      const qs = status ? `?status=${status}` : '';
      const submissions = await bridgeGet<Submission[]>(`/api/admin/submissions${qs}`);
      set({ submissions, loading: false });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'error', message: 'Failed to fetch submissions', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ error: mapErrorToUserMessage(err), loading: false });
    }
  },

  submitItem: async (type, data, note) => {
    const base = getCommunityBaseUrl();
    if (isElectronMode()) {
      // Electron renderer fetch to the remote server is blocked by browser CORS
      // (the renderer origin is never in the server's allowlist). Route through the
      // main process (net.fetch), which is not subject to CORS.
      if (!base) {
        throw new Error('Community server URL not configured. Set it in Settings to share debates.');
      }
      const result = await api.communitySubmit(base, { type, data, note });
      return result.submissionId;
    }
    const result = await bridgePost<{ submissionId: string }>(`${base}/api/community/submit`, { type, data, note });
    return result.submissionId;
  },

  copyItem: async (type, communityId) => {
    if (isElectronMode()) throw new Error('Community Library is not available in desktop mode');
    const result = await bridgePost<{ newId: string }>('/api/community/copy', { type, communityId });
    api.trackEvent('community_copy', 'community', { type, communityId });
    return result.newId;
  },

  removeItem: async (type, id, reason) => {
    const listKey = type;
    const prev = useCommunityStore.getState()[listKey];
    set({ [listKey]: prev.filter(item => item.id !== id) });
    try {
      if (isElectronMode()) {
        await api.adminRemoveCommunityItem(type, id, reason);
      } else {
        // bridgeDel doesn't support request bodies; inline fetch for DELETE-with-reason
        const res = await fetch(`/api/community/${type}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) throw new Error(`DELETE failed: HTTP ${res.status}`);
      }
      api.trackEvent('community_admin_remove', 'community', { type, id });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'community-store', level: 'error', message: 'Failed to remove community item', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ [listKey]: prev });
      throw err;
    }
  },

  approveSubmission: async (id) => {
    if (isElectronMode()) return;
    await bridgePost(`/api/admin/submissions/${id}/approve`, {});
  },

  rejectSubmission: async (id) => {
    if (isElectronMode()) return;
    await bridgePost(`/api/admin/submissions/${id}/reject`, {});
  },
}));
