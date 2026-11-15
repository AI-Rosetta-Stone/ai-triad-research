// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4562: InquiryTab adopts the shared LibraryListPage (replacing the persistent Ask/My/
// Community strip, t/3678). t/4666 phase 1: "New Question" opens a dialog over the list (not a
// full-page Ask screen) — these tests pin that wiring: "+ New Question" and a getting-started
// chip both open the dialog with the list still rendered behind it; Cancel/onStarted close it;
// Running/Answer screens are still reachable once a job starts. LibraryListPage's own mechanics
// are covered by its own test file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockReset = vi.fn();
const mockSetQuestion = vi.fn();
const mockOpenFromHistory = vi.fn();
const mockOpenCommunityResult = vi.fn();
const mockFetchHistory = vi.fn();
const mockStopPolling = vi.fn();
const mockOpenList = vi.fn();
let mockScreen: 'running' | 'answer' | 'list' = 'list';

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
    openList: mockOpenList,
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

let capturedOnClose: (() => void) | undefined;
let capturedOnStarted: (() => void) | undefined;
vi.mock('./InquiryAskPanel', () => ({
  InquiryAskPanel: ({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) => {
    capturedOnClose = onClose;
    capturedOnStarted = onStarted;
    return <div>ask-dialog</div>;
  },
}));
vi.mock('./InquiryRunningPanel', () => ({ InquiryRunningPanel: () => <div>running-screen</div> }));
vi.mock('./InquiryAnswerPanel', () => ({ InquiryAnswerPanel: () => <div>answer-screen</div> }));

type FilterRow = { id: string; question?: string; title?: string };
let capturedOnNew: (() => void) | undefined;
let capturedFilter: ((rows: FilterRow[], q: string) => FilterRow[]) | undefined;
vi.mock('../shared/LibraryListPage', () => ({
  LibraryListPage: ({ config, intro }: {
    config: { onNew?: () => void; filter?: (rows: FilterRow[], q: string) => FilterRow[] }; intro?: React.ReactNode;
  }) => {
    capturedOnNew = config.onNew;
    capturedFilter = config.filter;
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

describe('InquiryTab (t/4562, t/4666)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScreen = 'list';
    capturedOnNew = undefined;
    capturedOnPickStarter = undefined;
    capturedOnClose = undefined;
    capturedOnStarted = undefined;
  });

  it('defaults to the library list screen, with the getting-started intro rendered inside it', () => {
    render(<InquiryTab />);
    expect(screen.getByText('list-screen')).toBeInTheDocument();
    expect(screen.getByText('getting-started')).toBeInTheDocument();
    expect(screen.queryByText('ask-dialog')).not.toBeInTheDocument();
  });

  it('"+ New Question" (LibraryListPage config.onNew) resets the store and opens the dialog over the list', () => {
    render(<InquiryTab />);
    capturedOnNew?.();
    expect(mockReset).toHaveBeenCalled();
  });

  // p/29#178 fix 2: a previous draft question must not resurface on a fresh "+ New Question".
  it('"+ New Question" clears any previous draft question', () => {
    render(<InquiryTab />);
    capturedOnNew?.();
    expect(mockSetQuestion).toHaveBeenCalledWith('');
  });

  it('opening the dialog renders it over the list, not instead of it', () => {
    const { rerender } = render(<InquiryTab />);
    capturedOnNew?.();
    rerender(<InquiryTab />);
    expect(screen.getByText('list-screen')).toBeInTheDocument();
    expect(screen.getByText('ask-dialog')).toBeInTheDocument();
  });

  it('a getting-started chip seeds the question, resets the store, and opens the dialog', () => {
    const { rerender } = render(<InquiryTab />);
    capturedOnPickStarter?.('Is AI hype outrunning the evidence?');
    expect(mockSetQuestion).toHaveBeenCalledWith('Is AI hype outrunning the evidence?');
    expect(mockReset).toHaveBeenCalled();
    rerender(<InquiryTab />);
    expect(screen.getByText('ask-dialog')).toBeInTheDocument();
  });

  it('the dialog\'s onClose returns to the list via openList and closes the dialog', () => {
    const { rerender } = render(<InquiryTab />);
    capturedOnNew?.();
    rerender(<InquiryTab />);
    capturedOnClose?.();
    expect(mockOpenList).toHaveBeenCalled();
    rerender(<InquiryTab />);
    expect(screen.queryByText('ask-dialog')).not.toBeInTheDocument();
  });

  it('the dialog\'s onStarted closes it, letting the Running screen take over', () => {
    const { rerender } = render(<InquiryTab />);
    capturedOnNew?.();
    rerender(<InquiryTab />);
    capturedOnStarted?.();
    mockScreen = 'running';
    rerender(<InquiryTab />);
    expect(screen.queryByText('ask-dialog')).not.toBeInTheDocument();
    expect(screen.getByText('running-screen')).toBeInTheDocument();
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

  it('fetches history and community inquiries on mount, regardless of which screen is active', () => {
    mockScreen = 'running';
    render(<InquiryTab />);
    expect(mockFetchHistory).toHaveBeenCalled();
    expect(mockFetchInquiries).toHaveBeenCalled();
  });

  it('unmount stops any in-flight poll', () => {
    const { unmount } = render(<InquiryTab />);
    unmount();
    expect(mockStopPolling).toHaveBeenCalled();
  });

  // t/84: search must match a renamed row's displayed title, and still its original question.
  describe('search filter (t/84)', () => {
    const renamed: FilterRow = { id: 'r1', question: 'Is AI hype outrunning evidence?', title: 'Hype vs. Evidence' };
    const other: FilterRow = { id: 'r2', question: 'Will compute keep scaling?' };

    it('finds a renamed row by a substring of its title, case-insensitively', () => {
      render(<InquiryTab />);
      expect(capturedFilter?.([renamed, other], 'hype VS')).toEqual([renamed]);
    });

    it('still finds a renamed row by a substring of its original question', () => {
      render(<InquiryTab />);
      expect(capturedFilter?.([renamed, other], 'outrunning')).toEqual([renamed]);
    });

    it('excludes a renamed row when neither title nor question matches', () => {
      render(<InquiryTab />);
      expect(capturedFilter?.([renamed, other], 'compute')).toEqual([other]);
    });
  });
});
