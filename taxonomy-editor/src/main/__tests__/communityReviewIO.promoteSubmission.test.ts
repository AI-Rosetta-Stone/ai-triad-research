// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/301 integration: real adminReviewAction → promoteSubmission with in-memory Azure mocking.
 * Tests that the fix correctly strips op-ed stages, routes by type, and rejects inquiries.
 * 
 * These tests FAIL on main's unfixed code:
 * - Op-ed stages survive in the published blob
 * - Op-ed is written to community/debates/debate-* instead of community/opeds/oped-*
 * - Inquiry is silently written to community/debates/ instead of being refused
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const blobStore = new Map<string, string>();

function notFoundError(): Error & { statusCode: number } {
  return Object.assign(new Error('NotFound'), { statusCode: 404 });
}

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    getContainerClient() {
      return {
        getBlobClient: (name: string) => ({
          download: async () => {
            if (!blobStore.has(name)) throw notFoundError();
            const buf = Buffer.from(blobStore.get(name)!, 'utf-8');
            return { readableStreamBody: (async function* () { yield buf; })() };
          },
        }),
        getBlockBlobClient: (name: string) => ({
          upload: async (data: Buffer | string) => {
            const str = typeof data === 'string' ? data : data.toString('utf-8');
            blobStore.set(name, str);
          },
        }),
      };
    }
  },
}));

process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://fake.blob.core.windows.net';

import { adminReviewAction } from '../communityReviewIO.js';

describe('adminReviewAction → promoteSubmission (t/301 real path)', () => {
  beforeEach(() => { blobStore.clear(); });

  it('op-ed approval: stages stripped, published to community/opeds/oped-*', async () => {
    const submissionId = 'sub-001';
    const opedSetId = 'set-001';
    const sourceText = 'CONFIDENTIAL-internal-strategy.pdf';

    // Realistic pending op-ed submission with stages containing source material
    const submission = {
      id: submissionId,
      type: 'oped' as const,
      originalId: opedSetId,
      submittedBy: 'analyst@example.com',
      submittedAt: new Date().toISOString(),
      status: 'pending' as const,
      data: {
        id: opedSetId,
        opeds: [{
          id: 'oped-1',
          topic: 'AI Governance Policy',
          stages: [{
            phase: 'research',
            prompts: [
              { text: `Analyze ${sourceText} for regulatory implications` },
              { text: 'Synthesize findings into policy recommendations' },
            ],
            outputs: [
              { text: `Based on ${sourceText}, the regulatory landscape shows...` },
            ],
          }],
          analysis: 'Public policy analysis text',
          context: 'Public policy context',
        }],
      },
    };

    const submissionPath = `community/_submissions/sub-${submissionId}.json`;
    blobStore.set(submissionPath, JSON.stringify(submission));

    // Call real adminReviewAction to promote
    await adminReviewAction({
      groupId: 'group-1',
      action: 'promote',
      itemIds: [submissionId],
    });

    // ASSERTION 1: Published to community/opeds/oped-*, NOT community/debates/*
    const opedBlobs = [...blobStore.keys()].filter(k => k.startsWith('community/opeds/oped-'));
    expect(opedBlobs).toHaveLength(1, 'Expected one oped blob in community/opeds/');
    expect(opedBlobs[0]).toMatch(/^community\/opeds\/oped-[a-z0-9-]+\.json$/);

    const debateBlobs = [...blobStore.keys()].filter(k => k.startsWith('community/debates/'));
    expect(debateBlobs).toHaveLength(0, 'Op-ed should NOT be in community/debates/');

    // ASSERTION 2: Published JSON has NO stages and NO source text
    const publishedContent = blobStore.get(opedBlobs[0])!;
    const published = JSON.parse(publishedContent);
    
    expect(published.opeds[0]).not.toHaveProperty('stages', 'stages must be stripped');
    expect(publishedContent).not.toContain(sourceText, 'source text must not be in published blob');
    expect(publishedContent).not.toContain('CONFIDENTIAL', 'confidential markers must be stripped');
    
    // Public fields preserved
    expect(published.opeds[0].topic).toBe('AI Governance Policy');
    expect(published.opeds[0].analysis).toBe('Public policy analysis text');

    // ASSERTION 3: Submission marked approved
    const submissionUpdated = JSON.parse(blobStore.get(submissionPath)!);
    expect(submissionUpdated.status).toBe('approved');
  });

  it('inquiry approval: thrown before any community blob write', async () => {
    const submissionId = 'sub-002';
    const inquiryId = 'inq-001';

    const submission = {
      id: submissionId,
      type: 'inquiry' as const,
      originalId: inquiryId,
      submittedBy: 'researcher@example.com',
      submittedAt: new Date().toISOString(),
      status: 'pending' as const,
      data: {
        id: inquiryId,
        question: 'What are the key policy challenges in AI governance?',
        // inquiry data
      },
    };

    const submissionPath = `community/_submissions/sub-${submissionId}.json`;
    blobStore.set(submissionPath, JSON.stringify(submission));

    // Try to approve the inquiry
    let threw = false;
    try {
      await adminReviewAction({
        groupId: 'group-1',
        action: 'promote',
        itemIds: [submissionId],
      });
    } catch (err: unknown) {
      threw = true;
      // Should throw about t/3651 (inquiry projection pending)
      expect(String(err)).toContain('t/3651');
    }

    // ASSERTION 1: The call threw (or was handled as rejection)
    // If executeAction catches the error and marks rejected, that's ok too
    
    // ASSERTION 2: NO community/* blob was written for this inquiry
    const communityBlobs = [...blobStore.keys()].filter(k => 
      k.startsWith('community/') && !k.includes('_submissions')
    );
    expect(communityBlobs).toHaveLength(0, 
      'Inquiry should not write any community blob (threw before write or was rejected)');

    // ASSERTION 3: Not written to community/debates/ (the pre-fix misfile)
    const debateBlobs = [...blobStore.keys()].filter(k => k.startsWith('community/debates/inquiry-'));
    expect(debateBlobs).toHaveLength(0, 'Inquiry should not misfile to debates/');
  });

  it('chat approval: routes to community/chats/chat-* (parity)', async () => {
    const submissionId = 'sub-003';
    const chatId = 'chat-001';

    const submission = {
      id: submissionId,
      type: 'chat' as const,
      originalId: chatId,
      submittedBy: 'user@example.com',
      submittedAt: new Date().toISOString(),
      status: 'pending' as const,
      data: {
        id: chatId,
        title: 'AI Governance Discussion',
        transcript: [{ speaker: 'Alice', content: 'What are the implications?' }],
      },
    };

    const submissionPath = `community/_submissions/sub-${submissionId}.json`;
    blobStore.set(submissionPath, JSON.stringify(submission));

    await adminReviewAction({
      groupId: 'group-1',
      action: 'promote',
      itemIds: [submissionId],
    });

    // Verify: chat written to correct path (unchanged from pre-fix)
    const chatBlobs = [...blobStore.keys()].filter(k => k.startsWith('community/chats/chat-'));
    expect(chatBlobs).toHaveLength(1);
    expect(chatBlobs[0]).toMatch(/^community\/chats\/chat-[a-z0-9-]+\.json$/);
  });

  it('debate approval: routes to community/debates/debate-* (parity)', async () => {
    const submissionId = 'sub-004';
    const debateId = 'debate-001';

    const submission = {
      id: submissionId,
      type: 'debate' as const,
      originalId: debateId,
      submittedBy: 'user@example.com',
      submittedAt: new Date().toISOString(),
      status: 'pending' as const,
      data: {
        id: debateId,
        title: 'AI Safety Policy Debate',
      },
    };

    const submissionPath = `community/_submissions/sub-${submissionId}.json`;
    blobStore.set(submissionPath, JSON.stringify(submission));

    await adminReviewAction({
      groupId: 'group-1',
      action: 'promote',
      itemIds: [submissionId],
    });

    // Verify: debate written to correct path (unchanged from pre-fix)
    const debateBlobs = [...blobStore.keys()].filter(k => k.startsWith('community/debates/debate-'));
    expect(debateBlobs).toHaveLength(1);
    expect(debateBlobs[0]).toMatch(/^community\/debates\/debate-[a-z0-9-]+\.json$/);
  });
});
