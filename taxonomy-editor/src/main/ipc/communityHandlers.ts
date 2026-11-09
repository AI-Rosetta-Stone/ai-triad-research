// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Community handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// Submit to the remote Community Library (via main-process net.fetch to bypass
// renderer CORS) and the Azure-backed admin review queue/stats/detail/actions.
// Handler bodies moved verbatim; channel names unchanged.

import { ipcMain, net } from 'electron';
import { z } from 'zod';
import {
  isAzureReviewConfigured,
  adminReviewQueue,
  adminReviewStats,
  adminReviewDetail,
  adminReviewAction,
  adminRemoveCommunityItem,
  adminRenameCommunityItem,
  type CommunityType,
} from '../communityReviewIO.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { communitySubmitPayloadSchema } from './communitySubmitSchema.js';
import { inquiryPayloadSchema } from '../../../../lib/inquiry/index.js';

export function registerCommunityHandlers(): void {
  // Submit a debate/chat to the remote Community Library.
  // Routed through the main process (net.fetch) rather than a renderer fetch:
  // the renderer origin (http://localhost:5173 in dev, file:// when packaged) is
  // never in the server's CORS allowlist, so a renderer fetch is blocked with
  // "Failed to fetch". Main-process requests are not subject to browser CORS.
  ipcMain.handle(
    'community-submit',
    async (_event, baseUrl: unknown, payload: unknown) => {
      // Validate untrusted IPC input at the boundary (TS types are erased at runtime).
      const base = z.string().url().parse(baseUrl).replace(/\/+$/, '');
      // S-SSRF: only allow http/https to prevent file:// and internal protocols.
      if (!/^https?:\/\//i.test(base)) {
        throw new Error('Community server URL must be an http(s) URL. Set it in Settings to share debates.');
      }
      // t/2986: 'oped' MUST be in the enum — the op-ed share sends type:'oped', which
      // the client bridge type + server already accept. Schema single-sourced +
      // tested in communitySubmitSchema.ts to prevent this drift recurring.
      const submitPayload = communitySubmitPayloadSchema.parse(payload);
      const url = `${base}/api/community/submit`;
      try {
        const res = await net.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submitPayload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return (await res.json()) as { submissionId: string };
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'ipc-handlers',
          level: 'error',
          message: 'Community submit failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw err;
      }
    },
  );

  // t/4746/t/4612: desktop Ask "Share to Community" — uploads the FULL InquiryResult to the
  // unauthenticated draft endpoint (a desktop result has no server-side counterpart to load,
  // t/4611), for human moderation. Distinct from 'community-submit' above: separate endpoint,
  // separate (stricter) payload schema, no submissionId — a draft link + id instead.
  // Same main-process net.fetch CORS-bypass rationale as 'community-submit'.
  ipcMain.handle(
    'submit-ask-to-community',
    async (_event, baseUrl: unknown, result: unknown, note: unknown) => {
      // Validate untrusted IPC input at the boundary (TS types are erased at runtime).
      const base = z.string().url().parse(baseUrl).replace(/\/+$/, '');
      // S-SSRF: only allow http/https to prevent file:// and internal protocols.
      if (!/^https?:\/\//i.test(base)) {
        throw new Error('Community server URL must be an http(s) URL. Set it in Settings to share debates.');
      }
      // t/4743: strict Zod parse at the client boundary too — not just server-side — so a
      // malformed payload (or an oversized note) never reaches the network call at all.
      const payload = inquiryPayloadSchema.parse({ result, note });
      const url = `${base}/api/community/submit/draft`;
      try {
        const res = await net.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return (await res.json()) as { draftId: string; link: string };
      } catch (err) {
        // Every failure must surface to the renderer (t/4611) — never swallowed here.
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'ipc-handlers',
          level: 'error',
          message: 'Ask-to-community draft submission failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw err;
      }
    },
  );

  // ── Community Review (Azure Blob) ──

  ipcMain.handle('admin-review-configured', () => {
    return isAzureReviewConfigured();
  });

  ipcMain.handle('admin-review-queue', async () => {
    // Read — degrade gracefully when Azure isn't configured or the call fails (t/1088).
    if (!isAzureReviewConfigured()) return { items: [] };
    try {
      return await adminReviewQueue();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-admin-review-queue',
        level: 'warn',
        message: 'admin-review-queue failed; returning empty queue',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { items: [] };
    }
  });

  ipcMain.handle('admin-review-stats', async () => {
    // Polled by the renderer Toolbar. Degrade gracefully when Azure isn't configured
    // or the stats call fails — return empty rather than throwing on every poll (t/1088).
    if (!isAzureReviewConfigured()) return { total: 0, byDomain: {} };
    try {
      return await adminReviewStats();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-admin-review-stats',
        level: 'warn',
        message: 'admin-review-stats failed; returning empty stats',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { total: 0, byDomain: {} };
    }
  });

  ipcMain.handle('admin-review-detail', async (_event, groupId: string) => {
    // Read — degrade gracefully (null) when Azure isn't configured or the call fails.
    if (!isAzureReviewConfigured()) return null;
    try {
      return await adminReviewDetail(groupId);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-admin-review-detail',
        level: 'warn',
        message: 'admin-review-detail failed; returning null',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  });

  ipcMain.handle('admin-review-action', async (_event, action: {
    groupId: string;
    action: 'promote' | 'reject';
    itemIds: string[];
    reason?: string;
    edits?: Record<string, Record<string, unknown>>;
  }) => {
    // Mutation — surface failures to the user (ADR-001), don't swallow.
    if (!isAzureReviewConfigured()) throw new ActionableError({
      goal: 'Apply a community-review moderation action',
      problem: 'Azure community review is not configured (AZURE_STORAGE_ACCOUNT_URL is unset)',
      location: 'ipcHandlers.admin-review-action',
      nextSteps: [
        'Set AZURE_STORAGE_ACCOUNT_URL for the desktop app to enable community review',
        'Confirm the admin review panel should be available in this environment',
      ],
    });
    try {
      return await adminReviewAction(action);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-admin-review-action',
        level: 'error',
        message: 'admin-review-action failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: 'Apply a community-review moderation action',
        problem: `The ${action.action} action could not be completed`,
        location: 'ipcHandlers.admin-review-action',
        nextSteps: ['Retry the action', 'Check Azure storage connectivity and credentials'],
        innerError: err,
      });
    }
  });

  ipcMain.handle('admin-remove-community-item', async (_event, type: CommunityType, id: string, reason?: string) => {
    // Mutation — surface failures to the user (ADR-001), don't swallow.
    if (!isAzureReviewConfigured()) throw new ActionableError({
      goal: 'Remove a community item',
      problem: 'Azure community review is not configured (AZURE_STORAGE_ACCOUNT_URL is unset)',
      location: 'ipcHandlers.admin-remove-community-item',
      nextSteps: ['Set AZURE_STORAGE_ACCOUNT_URL for the desktop app to enable community review'],
    });
    try {
      return await adminRemoveCommunityItem(type, id, reason);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-admin-remove-community-item',
        level: 'error',
        message: 'admin-remove-community-item failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: 'Remove a community item',
        problem: `Could not remove ${type} item ${id}`,
        location: 'ipcHandlers.admin-remove-community-item',
        nextSteps: ['Retry the removal', 'Check Azure storage connectivity and credentials'],
        innerError: err,
      });
    }
  });

  // t/4895/t/4894: admin rename with an audit record, all 4 community types.
  ipcMain.handle('admin-rename-community-item', async (_event, type: CommunityType, id: string, title: string, reason?: string) => {
    // Mutation — surface failures to the user (ADR-001), don't swallow.
    if (!isAzureReviewConfigured()) throw new ActionableError({
      goal: 'Rename a community item',
      problem: 'Azure community review is not configured (AZURE_STORAGE_ACCOUNT_URL is unset)',
      location: 'ipcHandlers.admin-rename-community-item',
      nextSteps: ['Set AZURE_STORAGE_ACCOUNT_URL for the desktop app to enable community review'],
    });
    try {
      return await adminRenameCommunityItem(type, id, title, reason);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-admin-rename-community-item',
        level: 'error',
        message: 'admin-rename-community-item failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: 'Rename a community item',
        problem: `Could not rename ${type} item ${id}`,
        location: 'ipcHandlers.admin-rename-community-item',
        nextSteps: ['Retry the rename', 'Check Azure storage connectivity and credentials'],
        innerError: err,
      });
    }
  });
}
