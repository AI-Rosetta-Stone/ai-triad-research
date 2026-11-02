// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4689: the finished-run toast. Design (t/4689#5): fires for done/error only (never
// aborted), only when the run was elsewhere at completion, with an "Open" action and an
// 8s auto-dismiss paused on hover/focus. Exercised against the real runningSignal module —
// the behavior under test is the subscription wiring itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { RunToastHost } from './RunToastHost';
import { registerRun, __resetRunningSignalForTest } from '../../navigation/runningSignal';
import { postNavNotice } from '../../navigation/navNotice';

const loadChatMock = vi.fn();
const loadDebateMock = vi.fn();
const setTaxonomyStateMock = vi.fn();

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: { setState: (...args: unknown[]) => setTaxonomyStateMock(...args) },
}));
vi.mock('../../hooks/useChatStore', () => ({
  useChatStore: { getState: () => ({ loadChat: loadChatMock }) },
}));
vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: { getState: () => ({ loadDebate: loadDebateMock }) },
}));

describe('RunToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetRunningSignalForTest();
    loadChatMock.mockClear();
    loadDebateMock.mockClear();
    setTaxonomyStateMock.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing when no run has completed', () => {
    const { container } = render(<RunToastHost />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a toast for a "done" outcome that finished elsewhere', () => {
    render(<RunToastHost />);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    act(() => { finish('done'); }); // never navigated to chat:chat-1 — wasElsewhere stays true
    expect(screen.getByRole('status')).toHaveTextContent('Chat reply ready: My chat');
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('shows an error-variant toast for an "error" outcome', () => {
    render(<RunToastHost />);
    const finish = registerRun('debate', 'debate-1', 'My debate');
    act(() => { finish('error'); });
    expect(screen.getByRole('status')).toHaveTextContent('Debate stopped: My debate');
    expect(screen.getByRole('status')).toHaveClass('run-toast-error');
  });

  it('never shows a toast for an "aborted" outcome', () => {
    render(<RunToastHost />);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    act(() => { finish('aborted'); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('"Open" switches the tab and loads the item, then dismisses the toast', () => {
    render(<RunToastHost />);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    act(() => { finish('done'); });

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(setTaxonomyStateMock).toHaveBeenCalledWith({ activeTab: 'chat' });
    expect(loadChatMock).toHaveBeenCalledWith('chat-1');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('auto-dismisses after 8s', () => {
    render(<RunToastHost />);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    act(() => { finish('done'); });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('pauses the auto-dismiss timer on hover and resumes on mouse-leave', () => {
    render(<RunToastHost />);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    act(() => { finish('done'); });
    const toast = screen.getByRole('status');

    fireEvent.mouseEnter(toast);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByRole('status')).toBeInTheDocument(); // still there — paused

    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the dismiss button clears the toast immediately', () => {
    render(<RunToastHost />);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    act(() => { finish('done'); });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  // t/4640 AC3: a navigation notice (an item that wasn't found) uses the same stack.
  it('shows a navigation notice as a status toast with no "Open" action, auto-dismissed', () => {
    render(<RunToastHost />);
    act(() => { postNavNotice('That debate couldn’t be found. It may have been deleted.'); });

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('That debate couldn’t be found. It may have been deleted.');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
