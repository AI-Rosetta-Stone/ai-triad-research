// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidElement } from 'react';
import { getShareProvider } from '../../navigation/shareProvider';
import type { PlaceInfo } from '../../navigation/types';

const shareInquiryMock = vi.fn();
const unshareInquiryMock = vi.fn();
vi.mock('@bridge', () => ({
  api: { shareInquiry: (id: string) => shareInquiryMock(id), unshareInquiry: (id: string) => unshareInquiryMock(id) },
}));

let storeState: { result: unknown; jobId: string | null } = { result: null, jobId: null };
vi.mock('../../hooks/useInquiryStore', () => ({
  useInquiryStore: { getState: () => storeState },
}));

vi.mock('./InquiryShareDialog', () => ({
  InquiryShareDialog: (props: Record<string, unknown>) => ({ type: 'InquiryShareDialog', props }),
}));

import './inquiryShareProvider'; // self-registers for 'inquiry' at import time

const place = (placeKey: string): PlaceInfo => ({ tool: 'inquiry', placeKey, path: '/x', label: 'x', crumbs: [] });
const RESULT = { request: { question: 'q' } } as const;

describe('inquiryShareProvider', () => {
  beforeEach(() => {
    shareInquiryMock.mockReset();
    unshareInquiryMock.mockReset();
    storeState = { result: null, jobId: null };
  });

  it('returns null for the library (inquiry:none)', () => {
    expect(getShareProvider(place('inquiry:none'))).toBeNull();
  });

  it('returns null when the store has no result matching this job id (stale place)', () => {
    storeState = { result: RESULT, jobId: 'other-job' };
    expect(getShareProvider(place('inquiry:q1'))).toBeNull();
  });

  it('resolves when the store result matches the place job id, requires confirmation, names "question"', () => {
    storeState = { result: RESULT, jobId: 'q1' };
    const provider = getShareProvider(place('inquiry:q1'));
    expect(provider).not.toBeNull();
    expect(provider!.needsConfirm).toBe(true);
    expect(provider!.contentLabel).toBe('question');
  });

  it('renderPreview returns the InquiryShareDialog, fed this result (TL point 5)', () => {
    storeState = { result: RESULT, jobId: 'q1' };
    const provider = getShareProvider(place('inquiry:q1'))!;
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const preview = provider.renderPreview!(onConfirm, onCancel);
    expect(isValidElement(preview)).toBe(true);
    expect((preview as { props: Record<string, unknown> }).props).toMatchObject({ result: RESULT, onConfirm, onCancel });
  });

  it('create()/current()/revoke() mirror the op-ed provider\'s session-cache shape', async () => {
    storeState = { result: RESULT, jobId: 'q2' };
    shareInquiryMock.mockResolvedValue({ shareId: 'sid', url: '/inquiries/sid' });
    unshareInquiryMock.mockResolvedValue({ ok: true });
    const provider = getShareProvider(place('inquiry:q2'))!;

    expect(await provider.current()).toBeNull();
    const url = await provider.create();
    expect(url).toContain('/inquiries/sid');
    expect(await provider.current()).toBe(url);

    await provider.revoke!();
    expect(unshareInquiryMock).toHaveBeenCalledWith('q2');
    expect(await provider.current()).toBeNull();
  });
});
