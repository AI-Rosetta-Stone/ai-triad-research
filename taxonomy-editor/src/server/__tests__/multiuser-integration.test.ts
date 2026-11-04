// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnonymousSessionStore } from '../storage/anonymousSessionStore.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── In-memory StorageBackend for isolation testing ──

class MemoryBackend {
  files = new Map<string, string>();

  async readFile(filePath: string): Promise<string | null> {
    return this.files.get(this.norm(filePath)) ?? null;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(this.norm(filePath), content);
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    const prefix = this.norm(dirPath) + '/';
    const entries = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const top = rest.split('/')[0];
        entries.add(top);
      }
    }
    return [...entries];
  }

  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(this.norm(filePath));
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.files.has(this.norm(filePath));
  }

  norm(p: string): string {
    return p.replace(/\\/g, '/');
  }
}

// ── Helpers ──

function makeUserCtx(
  principalName: string,
  idp: string,
  deriveStorageUserId: (p: string, i: string) => string,
) {
  return {
    principalName,
    idp,
    storageUserId: deriveStorageUserId(principalName, idp),
    isAnonymous: false,
    stableId: `${idp}:${principalName}`, // t/4328: admin keys on the idp-qualified stableId
  };
}

function makeAnonCtx(sessionId: string) {
  return {
    principalName: '_local',
    idp: '',
    storageUserId: '_local',
    isAnonymous: true,
    anonymousSessionId: sessionId,
  };
}

// ── Tests ──

describe('Multi-user data isolation (integration)', () => {
  let mem: MemoryBackend;
  let fileIO: typeof import('../storage/fileIO.js');
  let userContext: typeof import('../security/userContext.js');
  let DATA_ROOT: string;

  beforeEach(async () => {
    mem = new MemoryBackend();
    // Use a cross-platform temp path
    DATA_ROOT = path.resolve(process.cwd(), '__test_data__');
    vi.stubEnv('AI_TRIAD_DATA_ROOT', DATA_ROOT);

    vi.resetModules();
    userContext = await import('../security/userContext.js');
    fileIO = await import('../storage/fileIO.js');
    fileIO.setBackend(mem as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function norm(p: string) { return p.replace(/\\/g, '/'); }

  it('routes chats to different directories per user', async () => {
    const userA = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const userB = makeUserCtx('bob', 'github', userContext.deriveStorageUserId);

    await userContext.runWithUser(userA, async () => {
      await fileIO.saveChatSession({ id: 'chat-1', title: 'Alice Chat', created_at: '2026-01-01' });
    });

    await userContext.runWithUser(userB, async () => {
      await fileIO.saveChatSession({ id: 'chat-2', title: 'Bob Chat', created_at: '2026-01-01' });
    });

    const aliceChats = await userContext.runWithUser(userA, () => fileIO.listChatSessions());
    expect(aliceChats).toHaveLength(1);
    expect((aliceChats[0] as any).title).toBe('Alice Chat');

    const bobChats = await userContext.runWithUser(userB, () => fileIO.listChatSessions());
    expect(bobChats).toHaveLength(1);
    expect((bobChats[0] as any).title).toBe('Bob Chat');
  });

  it('routes debates to different directories per user', async () => {
    const userA = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const userB = makeUserCtx('bob', 'github', userContext.deriveStorageUserId);

    await userContext.runWithUser(userA, async () => {
      await fileIO.saveDebateSession({
        id: 'debate-1', title: 'Alice Debate', phase: 'completed',
        created_at: '2026-01-01', updated_at: '2026-01-01', transcript: [],
      }, 'test');
    });

    await userContext.runWithUser(userB, async () => {
      await fileIO.saveDebateSession({
        id: 'debate-2', title: 'Bob Debate', phase: 'completed',
        created_at: '2026-01-02', updated_at: '2026-01-02', transcript: [],
      }, 'test');
    });

    const aliceDebates = await userContext.runWithUser(userA, () => fileIO.listDebateSessions());
    expect(aliceDebates).toHaveLength(1);
    expect((aliceDebates[0] as any).title).toBe('Alice Debate');

    const bobDebates = await userContext.runWithUser(userB, () => fileIO.listDebateSessions());
    expect(bobDebates).toHaveLength(1);
    expect((bobDebates[0] as any).title).toBe('Bob Debate');
  });

  it('prevents cross-user data access — loading another user chat fails', async () => {
    const userA = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const userB = makeUserCtx('bob', 'github', userContext.deriveStorageUserId);

    await userContext.runWithUser(userA, async () => {
      await fileIO.saveChatSession({ id: 'secret', title: 'Private', created_at: '2026-01-01' });
    });

    await expect(
      userContext.runWithUser(userB, () => fileIO.loadChatSession('secret'))
    ).rejects.toThrow(/not found/i);
  });

  it('user data persists on disk at correct paths', async () => {
    const user = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);

    await userContext.runWithUser(user, async () => {
      await fileIO.saveChatSession({ id: 'c1', title: 'Test', created_at: '2026-01-01' });
    });

    const expectedPath = norm(path.resolve(DATA_ROOT, 'users/jpsnover/chats/chat-c1.json'));
    expect(mem.files.has(expectedPath)).toBe(true);

    const content = JSON.parse(mem.files.get(expectedPath)!);
    expect(content.title).toBe('Test');
  });

  it('Google email users get normalized storage paths', async () => {
    const user = makeUserCtx('jsnover13@gmail.com', 'google', userContext.deriveStorageUserId);

    await userContext.runWithUser(user, async () => {
      await fileIO.saveChatSession({ id: 'g1', title: 'Google Chat', created_at: '2026-01-01' });
    });

    const expectedPath = norm(path.resolve(DATA_ROOT, 'users/jsnover13-at-gmail-com/chats/chat-g1.json'));
    expect(mem.files.has(expectedPath)).toBe(true);
  });

  it('deleting a chat only affects the owning user', async () => {
    const userA = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const userB = makeUserCtx('bob', 'github', userContext.deriveStorageUserId);

    await userContext.runWithUser(userA, async () => {
      await fileIO.saveChatSession({ id: 'shared-id', title: 'Alice Version', created_at: '2026-01-01' });
    });

    await userContext.runWithUser(userB, async () => {
      await fileIO.saveChatSession({ id: 'shared-id', title: 'Bob Version', created_at: '2026-01-01' });
    });

    await userContext.runWithUser(userA, () => fileIO.deleteChatSession('shared-id'));

    const bobChat = await userContext.runWithUser(userB, () => fileIO.loadChatSession('shared-id'));
    expect((bobChat as any).title).toBe('Bob Version');

    await expect(
      userContext.runWithUser(userA, () => fileIO.loadChatSession('shared-id'))
    ).rejects.toThrow(/not found/i);
  });
});

describe('Anonymous session isolation (integration)', () => {
  let store: AnonymousSessionStore;
  let anonDir: string;

  beforeEach(() => {
    anonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-iso-'));
    store = new AnonymousSessionStore({
      baseDir: anonDir,
      maxSessions: 10,
      sessionTtlMs: 60_000,
      maxSessionSizeBytes: 1024 * 1024,
      cleanupIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    store.stop();
    fs.rmSync(anonDir, { recursive: true, force: true });
  });

  it('different anonymous sessions are isolated', async () => {
    await store.saveChat('session-a', { id: 'c1', title: 'Session A Chat' });
    await store.saveChat('session-b', { id: 'c2', title: 'Session B Chat' });

    expect(await store.listChats('session-a')).toHaveLength(1);
    expect(((await store.listChats('session-a'))[0] as any).title).toBe('Session A Chat');

    expect(await store.listChats('session-b')).toHaveLength(1);
    expect(((await store.listChats('session-b'))[0] as any).title).toBe('Session B Chat');

    expect(await store.loadChat('session-a', 'c2')).toBeNull();
    expect(await store.loadChat('session-b', 'c1')).toBeNull();
  });

  it('destroying one session does not affect another', async () => {
    await store.saveChat('s1', { id: 'c1', title: 'First' });
    await store.saveChat('s2', { id: 'c2', title: 'Second' });

    await store.destroy('s1');

    expect(await store.listChats('s1')).toHaveLength(0);
    expect(await store.listChats('s2')).toHaveLength(1);
  });

  it('concurrent saves across sessions maintain correct size tracking', async () => {
    const data = { id: 'd1', title: 'test', content: 'x'.repeat(100) };
    await store.saveDebate('s1', data);
    await store.saveDebate('s2', data);

    expect(await store.listDebates('s1')).toHaveLength(1);
    expect(await store.listDebates('s2')).toHaveLength(1);
    expect(await store.activeSessionCount()).toBe(2);
  });
});

describe('Quota enforcement (integration)', () => {
  let mem: MemoryBackend;
  let fileIO: typeof import('../storage/fileIO.js');
  let userContext: typeof import('../security/userContext.js');
  let DATA_ROOT: string;

  beforeEach(async () => {
    mem = new MemoryBackend();
    // Use a real temp directory so quotas.ts can read the config via fs
    DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
    vi.stubEnv('AI_TRIAD_DATA_ROOT', DATA_ROOT);

    vi.resetModules();
    userContext = await import('../security/userContext.js');
    fileIO = await import('../storage/fileIO.js');
    fileIO.setBackend(mem as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  });

  function writeQuotaConfig(config: object) {
    const adminDir = path.join(DATA_ROOT, 'admin');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'quotas.json'), JSON.stringify(config));
  }

  it('allows saves within quota', async () => {
    const user = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);

    for (let i = 0; i < 3; i++) {
      await userContext.runWithUser(user, async () => {
        await fileIO.saveChatSession({ id: `c${i}`, title: `Chat ${i}`, created_at: '2026-01-01' });
      });
    }

    const chats = await userContext.runWithUser(user, () => fileIO.listChatSessions());
    expect(chats).toHaveLength(3);
  });

  it('blocks new chats when quota is reached', async () => {
    const user = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);

    writeQuotaConfig({ defaults: { maxChats: 3, maxDebates: 2 }, elevated: [] });

    for (let i = 0; i < 3; i++) {
      await userContext.runWithUser(user, async () => {
        await fileIO.saveChatSession({ id: `c${i}`, title: `Chat ${i}`, created_at: '2026-01-01' });
      });
    }

    await expect(
      userContext.runWithUser(user, async () => {
        await fileIO.saveChatSession({ id: 'c-over', title: 'Over Limit', created_at: '2026-01-01' });
      })
    ).rejects.toThrow(/quota/i);
  });

  it('allows updates to existing items even at quota', async () => {
    const user = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);

    writeQuotaConfig({ defaults: { maxChats: 2, maxDebates: 2 }, elevated: [] });

    for (let i = 0; i < 2; i++) {
      await userContext.runWithUser(user, async () => {
        await fileIO.saveChatSession({ id: `c${i}`, title: `Chat ${i}`, created_at: '2026-01-01' });
      });
    }

    await userContext.runWithUser(user, async () => {
      await fileIO.saveChatSession({ id: 'c0', title: 'Updated Chat', created_at: '2026-01-01' });
    });

    const chat = await userContext.runWithUser(user, () => fileIO.loadChatSession('c0'));
    expect((chat as any).title).toBe('Updated Chat');
  });

  it('elevated users get higher limits', async () => {
    const user = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);

    writeQuotaConfig({
      defaults: { maxChats: 2, maxDebates: 2 },
      elevated: [{ userId: 'jpsnover', maxChats: 100, maxDebates: 50 }],
    });

    for (let i = 0; i < 5; i++) {
      await userContext.runWithUser(user, async () => {
        await fileIO.saveChatSession({ id: `c${i}`, title: `Chat ${i}`, created_at: '2026-01-01' });
      });
    }

    const chats = await userContext.runWithUser(user, () => fileIO.listChatSessions());
    expect(chats).toHaveLength(5);
  });

  it('per-user quotas are independent — one user full does not block another', async () => {
    const alice = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const bob = makeUserCtx('bob', 'github', userContext.deriveStorageUserId);

    writeQuotaConfig({ defaults: { maxChats: 2, maxDebates: 2 }, elevated: [] });

    for (let i = 0; i < 2; i++) {
      await userContext.runWithUser(alice, async () => {
        await fileIO.saveChatSession({ id: `ac${i}`, title: `Alice ${i}`, created_at: '2026-01-01' });
      });
    }

    await expect(
      userContext.runWithUser(alice, async () => {
        await fileIO.saveChatSession({ id: 'ac-over', title: 'Over', created_at: '2026-01-01' });
      })
    ).rejects.toThrow(/quota/i);

    await userContext.runWithUser(bob, async () => {
      await fileIO.saveChatSession({ id: 'bc0', title: 'Bob Chat', created_at: '2026-01-01' });
    });

    const bobChats = await userContext.runWithUser(bob, () => fileIO.listChatSessions());
    expect(bobChats).toHaveLength(1);
  });
});

describe('Community Library workflow (integration)', () => {
  let mem: MemoryBackend;
  let community: typeof import('../community/community.js');
  let fileIO: typeof import('../storage/fileIO.js');
  let userContext: typeof import('../security/userContext.js');
  let DATA_ROOT: string;

  beforeEach(async () => {
    mem = new MemoryBackend();
    DATA_ROOT = path.resolve(process.cwd(), '__test_data__');
    vi.stubEnv('AI_TRIAD_DATA_ROOT', DATA_ROOT);
    vi.stubEnv('ADMIN_USERS', 'github:jpsnover'); // t/4328: idp-qualified; bare entries never match

    vi.resetModules();
    userContext = await import('../security/userContext.js');
    fileIO = await import('../storage/fileIO.js');
    community = await import('../community/community.js');
    fileIO.setBackend(mem as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('admin check works for configured users', () => {
    const admin = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);
    const regular = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);

    const isAdmin = userContext.runWithUser(admin, () => community.isAdmin());
    expect(isAdmin).toBe(true);

    const isNotAdmin = userContext.runWithUser(regular, () => community.isAdmin());
    expect(isNotAdmin).toBe(false);
  });

  it('submit → approve → list flow works end-to-end', async () => {
    const author = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const admin = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);

    const chatData = {
      id: 'original-chat-1',
      title: 'Great Discussion',
      created_at: '2026-01-01',
      transcript: [{ role: 'user', content: 'Hello' }],
      flight_recorder: { should: 'be stripped' },
      debug: { internal: true },
    };

    // Alice submits
    const { submissionId } = await userContext.runWithUser(author, () =>
      community.submitToCommunity('chat', chatData, 'Please share this!')
    );
    expect(submissionId).toBeTruthy();

    // Admin lists pending submissions
    const pending = await userContext.runWithUser(admin, () => community.listSubmissions('pending'));
    expect(pending).toHaveLength(1);
    expect((pending[0] as any).submittedBy).toBe('alice');

    // Admin approves
    const { communityId } = await userContext.runWithUser(admin, () =>
      community.approveSubmission(submissionId)
    );
    expect(communityId).toBeTruthy();

    // Community library now has the chat
    const communityChats = await userContext.runWithUser(author, () => community.listCommunityChats());
    expect(communityChats).toHaveLength(1);

    const listed = communityChats[0] as any;
    expect(listed.title).toBe('Great Discussion');
    expect(listed.community_metadata).toBeTruthy();
    expect(listed.community_metadata.submitted_by_display).toBe('alice');

    // Verify sanitization: debug/flight_recorder stripped
    const raw = await community.loadCommunityItem('chats', communityId);
    expect(raw).toBeTruthy();
    expect((raw as any).flight_recorder).toBeUndefined();
    expect((raw as any).debug).toBeUndefined();
    // t/856: original_id (pre-share private UUID) is stripped from public
    // responses; submitted_by_display is retained.
    expect((raw as any).community_metadata.original_id).toBeUndefined();
    expect((raw as any).community_metadata.submitted_by_display).toBe('alice');
  });

  it('submit → reject flow', async () => {
    const author = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const admin = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);

    await userContext.runWithUser(author, () =>
      community.submitToCommunity('debate', { id: 'd1', title: 'Bad Take', phase: 'completed' })
    );

    const pending = await userContext.runWithUser(admin, () => community.listSubmissions('pending'));
    expect(pending).toHaveLength(1);

    const subId = (pending[0] as any).id;
    await userContext.runWithUser(admin, () => community.rejectSubmission(subId));

    const afterReject = await userContext.runWithUser(admin, () => community.listSubmissions('pending'));
    expect(afterReject).toHaveLength(0);

    const rejected = await userContext.runWithUser(admin, () => community.listSubmissions('rejected'));
    expect(rejected).toHaveLength(1);

    const debates = await userContext.runWithUser(author, () => community.listCommunityDebates());
    expect(debates).toHaveLength(0);
  });

  it('anonymous users can submit (guarded by admin approval, not auth)', async () => {
    // Commit 1d02a13 intentionally removed the anonymous guard on submitToCommunity:
    // submissions are gated by admin review, and the guard was blocking Electron app
    // users who lack Azure Easy Auth cookies. Anonymous users may still NOT copy
    // community items (see the following test).
    const anon = makeAnonCtx('anon-123');

    const { submissionId } = await userContext.runWithUser(anon, () =>
      community.submitToCommunity('chat', { id: 'x', title: 'Anon Chat' })
    );
    expect(submissionId).toBeTruthy();
  });

  it('anonymous users cannot copy community items', async () => {
    const anon = makeAnonCtx('anon-123');

    await expect(
      userContext.runWithUser(anon, () => community.copyFromCommunity('chats', 'some-id'))
    ).rejects.toThrow(/anonymous/i);
  });

  it('max 20 pending submissions per user', async () => {
    // Limit raised from 5 to 20 in commit 4fadbdfe.
    const author = makeUserCtx('prolific', 'github', userContext.deriveStorageUserId);

    for (let i = 0; i < 20; i++) {
      await userContext.runWithUser(author, () =>
        community.submitToCommunity('chat', { id: `c${i}`, title: `Chat ${i}` })
      );
    }

    await expect(
      userContext.runWithUser(author, () =>
        community.submitToCommunity('chat', { id: 'c21', title: 'One Too Many' })
      )
    ).rejects.toThrow(/20 pending/i);
  });

  it('approving a submission cannot be done twice', async () => {
    const author = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const admin = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);

    const { submissionId } = await userContext.runWithUser(author, () =>
      community.submitToCommunity('chat', { id: 'c1', title: 'Once' })
    );

    await userContext.runWithUser(admin, () => community.approveSubmission(submissionId));

    await expect(
      userContext.runWithUser(admin, () => community.approveSubmission(submissionId))
    ).rejects.toThrow(/already approved/i);
  });

  it('copy from community creates item in user personal store', async () => {
    const author = makeUserCtx('alice', 'github', userContext.deriveStorageUserId);
    const copier = makeUserCtx('bob', 'github', userContext.deriveStorageUserId);
    const admin = makeUserCtx('jpsnover', 'github', userContext.deriveStorageUserId);

    const { submissionId } = await userContext.runWithUser(author, () =>
      community.submitToCommunity('chat', {
        id: 'original',
        title: 'Shareable Chat',
        created_at: '2026-01-01',
        transcript: [{ role: 'user', content: 'Hello World' }],
      })
    );
    const { communityId } = await userContext.runWithUser(admin, () =>
      community.approveSubmission(submissionId)
    );

    // Bob copies to his library
    const { newId } = await userContext.runWithUser(copier, () =>
      community.copyFromCommunity('chats', communityId)
    );
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(communityId);

    // Bob can load from his personal store
    const bobChat = await userContext.runWithUser(copier, () => fileIO.loadChatSession(newId));
    expect((bobChat as any).title).toBe('Shareable Chat');
    expect((bobChat as any).copied_from_community).toBe(communityId);

    // Alice doesn't have Bob's copy
    await expect(
      userContext.runWithUser(author, () => fileIO.loadChatSession(newId))
    ).rejects.toThrow(/not found/i);
  });
});
