// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4562: InquiryTab adopts the shared LibraryListPage (replacing the persistent Ask/My/
// Community strip, t/3678). These tests pin the screen-routing (list is the default landing,
// Ask/Running/Answer still reachable) and the two new wiring points LibraryListPage needs:
// "+ New Question" resets to the Ask screen, and a getting-started chip seeds the question
// before doing the same. LibraryListPage's own mechanics are covered by its own test file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockReset = vi.fn();
const mockSetQuestion = vi.fn();
const mockOpenFromHistory = vi.fn();
const mockOpenCommunityResult = vi.fn();
const mockFetchHistory = vi.fn();
const mockStopPolling = vi.fn();
let mockScreen: 'ask' | 'running' | 'answer' | 'list' = 'list';

vi.mock('../../hooks/useInquiryStore', () => ({
  useInquiryStore: (selector: (s: unknown) => unknown) => selector({
    screen: () => mockScreen,
    _stopPolling: mockStopPolling,
    history: [],
    historyLoading: false,
    reset: mockReset,
    setQuestion: mockSetQuestion,
    openFromHistory: mockOpenFromHistory,
    openCommunityResult: mockOpenCommunityResult,
    fetchHistory: mockFetchHistory,
  }),
}));

const mockFetchInquiries = vi.fn();
vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: (selector: (s: unknown) => unknown) => selector({
    inquiries: [], loading: false, fetchInquiries: mockFetchInquiries, copyItem: vi.fn(),
  }),
}));

vi.mock('@bridge', () => ({ api: {} }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

vi.mock('./InquiryAskPanel', () => ({ InquiryAskPanel: () => <div>ask-screen</div> }));
vi.mock('./InquiryRunningPanel', () => ({ InquiryRunningPanel: () => <div>running-screen</div> }));
vi.mock('./InquiryAnswerPanel', () => ({ InquiryAnswerPanel: () => <div>answer-screen</div> }));

let capturedOnNew: (() => void) | undefined;
vi.mock('../shared/LibraryListPage', () => ({
  LibraryListPage: ({ config, intro }: { config: { onNew?: () => void }; intro?: React.ReactNode }) => {
    capturedOnNew = config.onNew;
    return <div>list-screen{intro}</div>;
  },
}));

let capturedOnPickStarter: ((q: string) => void) | undefined;
vi.mock('./InquiryGettingStarted', () => ({
  InquiryGettingStarted: ({ onPickStarter }: { onPickStarter: (q: string) => void }) => {
    capturedOnPickStarter = onPickStarter;
    return <div>getting-started</div>;
  },
}));

const { InquiryTab } = await import('./InquiryTab');

describe('InquiryTab (t/4562)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScreen = 'list';
    capturedOnNew = undefined;
    capturedOnPickStarter = undefined;
  });

  it('defaults to the library list screen, with the getting-started intro rendered inside it', () => {
    render(<InquiryTab />);
    expect(screen.getByText('list-screen')).toBeInTheDocument();
    expect(screen.getByText('getting-started')).toBeInTheDocument();
  });

  it('renders the Ask screen when screen() is "ask"', () => {
    mockScreen = 'ask';
    render(<InquiryTab />);
    expect(screen.getByText('ask-screen')).toBeInTheDocument();
    expect(screen.queryByText('list-screen')).not.toBeInTheDocument();
  });

  it('renders the Running screen when screen() is "running"', () => {
    mockScreen = 'running';
    render(<InquiryTab />);
    expect(screen.getByText('running-screen')).toBeInTheDocument();
  });

  it('renders the Answer screen when screen() is "answer"', () => {
    mockScreen = 'answer';
    render(<InquiryTab />);
    expect(screen.getByText('answer-screen')).toBeInTheDocument();
  });

  it('"+ New Question" (LibraryListPage config.onNew) resets to the Ask screen', () => {
    render(<InquiryTab />);
    capturedOnNew?.();
    expect(mockReset).toHaveBeenCalled();
  });

  it('a getting-started chip seeds the question, then resets to the Ask screen', () => {
    render(<InquiryTab />);
    capturedOnPickStarter?.('Is AI hype outrunning the evidence?');
    expect(mockSetQuestion).toHaveBeenCalledWith('Is AI hype outrunning the evidence?');
    expect(mockReset).toHaveBeenCalled();
  });

  it('fetches history and community inquiries on mount, regardless of which screen is active', () => {
    mockScreen = 'ask';
    render(<InquiryTab />);
    expect(mockFetchHistory).toHaveBeenCalled();
    expect(mockFetchInquiries).toHaveBeenCalled();
  });

  it('unmount stops any in-flight poll', () => {
    const { unmount } = render(<InquiryTab />);
    unmount();
    expect(mockStopPolling).toHaveBeenCalled();
  });
});
