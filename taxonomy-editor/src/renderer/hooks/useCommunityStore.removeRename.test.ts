// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4898: admin remove/rename of a published community item. removeItem had no test coverage
// before this ticket; adding it here alongside the new renameItem, now that both route through
// the same api.adminRemoveCommunityItem/renameCommunityItem bridge calls uniformly (no more
// isElectronMode()/bare-fetch branch in removeItem — Quality, t/4898#3/p/356#166).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommunityChat } from './useCommunityStore';

const adminRemoveCommunityItem = vi.fn();
const renameCommunityItem = vi.fn();
const trackEvent = vi.fn();
vi.mock('@bridge', () => ({ api: { adminRemoveCommunityItem, renameCommunityItem, trackEvent } }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { useCommunityStore } = await import('./useCommunityStore');

const CHAT: CommunityChat = { id: 'chat-1', title: 'Original chat title', created_at: '2026-01-01', updated_at: '2026-01-01', mode: 'explore' };
const DEBATE = { id: 'deb-1', title: 'Original title', created_at: '2026-01-01', updated_at: '2026-01-01' };
const INQUIRY = { id: 'inq-1', question: 'Is X true?', created_at: '2026-01-01', updated_at: '2026-01-01', camps: [], verdict_count: 0 };
const OPED = { id: 'oped-1', topic: 'Original topic', created_at: '2026-01-01', updated_at: '2026-01-01', camps: [], voice_count: 0 };

beforeEach(() => {
  adminRemoveCommunityItem.mockReset().mockResolvedValue(undefined);
  renameCommunityItem.mockReset().mockResolvedValue(undefined);
  trackEvent.mockReset();
  useCommunityStore.setState({ chats: [CHAT], debates: [DEBATE], opeds: [OPED], inquiries: [INQUIRY], submissions: [], loading: false, error: null });
});

describe('useCommunityStore.removeItem (t/4898)', () => {
  it('optimistically removes the row, then calls the admin API', async () => {
    const p = useCommunityStore.getState().removeItem('debates', 'deb-1', 'spam');
    expect(useCommunityStore.getState().debates).toEqual([]);
    await p;
    expect(adminRemoveCommunityItem).toHaveBeenCalledWith('debates', 'deb-1', 'spam');
    expect(trackEvent).toHaveBeenCalledWith('community_admin_remove', 'community', { type: 'debates', id: 'deb-1' });
  });

  it('restores the row and rethrows on failure', async () => {
    adminRemoveCommunityItem.mockRejectedValue(new Error('boom'));
    await expect(useCommunityStore.getState().removeItem('debates', 'deb-1')).rejects.toThrow('boom');
    expect(useCommunityStore.getState().debates).toEqual([DEBATE]);
  });

  // t/90: 'chats' had no direct coverage; same optimistic-remove/restore contract as the other types.
  it('optimistically removes a chat row, then calls the admin API', async () => {
    const p = useCommunityStore.getState().removeItem('chats', 'chat-1', 'spam');
    expect(useCommunityStore.getState().chats).toEqual([]);
    await p;
    expect(adminRemoveCommunityItem).toHaveBeenCalledWith('chats', 'chat-1', 'spam');
    expect(trackEvent).toHaveBeenCalledWith('community_admin_remove', 'community', { type: 'chats', id: 'chat-1' });
  });

  it('restores the chat row and rethrows on failure', async () => {
    adminRemoveCommunityItem.mockRejectedValue(new Error('boom'));
    await expect(useCommunityStore.getState().removeItem('chats', 'chat-1')).rejects.toThrow('boom');
    expect(useCommunityStore.getState().chats).toEqual([CHAT]);
  });
});

describe('useCommunityStore.renameItem (t/4898)', () => {
  it('optimistically renames chats/debates/inquiries via the title field', async () => {
    const p = useCommunityStore.getState().renameItem('debates', 'deb-1', 'New title', 'typo');
    expect(useCommunityStore.getState().debates).toEqual([{ ...DEBATE, title: 'New title' }]);
    await p;
    expect(renameCommunityItem).toHaveBeenCalledWith('debates', 'deb-1', 'New title', 'typo');
    expect(trackEvent).toHaveBeenCalledWith('community_admin_rename', 'community', { type: 'debates', id: 'deb-1' });
  });

  it('renames an inquiry via the title field (not question — t/4891\'s display precedence)', async () => {
    await useCommunityStore.getState().renameItem('inquiries', 'inq-1', 'Clearer phrasing');
    expect(useCommunityStore.getState().inquiries).toEqual([{ ...INQUIRY, title: 'Clearer phrasing' }]);
  });

  it('renames an op-ed via the topic field, mirroring the server\'s per-type mapping', async () => {
    await useCommunityStore.getState().renameItem('opeds', 'oped-1', 'New topic');
    expect(useCommunityStore.getState().opeds).toEqual([{ ...OPED, topic: 'New topic' }]);
  });

  it('restores the prior value and rethrows on failure', async () => {
    renameCommunityItem.mockRejectedValue(new Error('boom'));
    await expect(useCommunityStore.getState().renameItem('debates', 'deb-1', 'New title')).rejects.toThrow('boom');
    expect(useCommunityStore.getState().debates).toEqual([DEBATE]);
  });

  // t/90: chats rename through the title field, like debates/inquiries.
  it('optimistically renames a chat via the title field, then calls the admin API', async () => {
    const p = useCommunityStore.getState().renameItem('chats', 'chat-1', 'New chat title', 'typo');
    expect(useCommunityStore.getState().chats).toEqual([{ ...CHAT, title: 'New chat title' }]);
    await p;
    expect(renameCommunityItem).toHaveBeenCalledWith('chats', 'chat-1', 'New chat title', 'typo');
    expect(trackEvent).toHaveBeenCalledWith('community_admin_rename', 'community', { type: 'chats', id: 'chat-1' });
  });

  it('restores the prior chat title and rethrows on failure', async () => {
    renameCommunityItem.mockRejectedValue(new Error('boom'));
    await expect(useCommunityStore.getState().renameItem('chats', 'chat-1', 'New chat title')).rejects.toThrow('boom');
    expect(useCommunityStore.getState().chats).toEqual([CHAT]);
  });
});
