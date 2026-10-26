// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4514: the inline Explain panel — loading/result/error states, Copy/Regenerate/Collapse,
// model attribution, cancel-via-Esc/button, and the "Open in Gemini" escape hatch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ExplainPanel } from './ExplainPanel';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

const { generateText, clipboardWriteText, openExternal, record } = vi.hoisted(() => ({
  generateText: vi.fn(), clipboardWriteText: vi.fn(), openExternal: vi.fn(), record: vi.fn(),
}));
vi.mock('@bridge', () => ({
  api: { generateText: (...args: unknown[]) => generateText(...args), clipboardWriteText, openExternal },
}));

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: { getState: () => ({ debateModel: 'test-model' }) },
}));
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: { getState: () => ({}) },
  getStoredModel: () => 'fallback-model',
}));

vi.mock('./utils', () => ({
  fixMarkdownLinks: (s: string) => s,
  openPromptInGemini: (prompt: string) => { clipboardWriteText(prompt); openExternal('https://gemini.google.com/app'); },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ExplainPanel', () => {
  it('shows a loading state immediately, announced via aria-live', () => {
    generateText.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={vi.fn()} />);
    const loading = screen.getByText('Explaining…');
    expect(loading.closest('[aria-live="polite"]')).toBeTruthy();
  });

  it('renders the result as markdown with model attribution and action buttons', async () => {
    generateText.mockResolvedValue({ text: '**bold** answer', servedModel: 'claude-sonnet-5' });
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());
    expect(screen.getByTestId('markdown').textContent).toBe('**bold** answer');
    expect(screen.getByText('via claude-sonnet-5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('calls generateText with the debate model and the given prompt', async () => {
    generateText.mockResolvedValue({ text: 'answer', servedModel: 'm' });
    render(<ExplainPanel prompt="explain this exact prompt" scopeLabel="this exchange" onClose={vi.fn()} />);
    await waitFor(() => expect(generateText).toHaveBeenCalled());
    const [prompt, model] = generateText.mock.calls[0];
    expect(prompt).toBe('explain this exact prompt');
    expect(model).toBe('test-model');
  });

  it('on error, shows the ActionableError shape with a Retry button and WARN-logs it', async () => {
    generateText.mockRejectedValue({ goal: 'Explain the statement', problem: 'The model refused', nextSteps: ['Try again', 'Check your API key'] });
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Explain the statement/)).toBeInTheDocument();
    expect(screen.getByText(/The model refused/)).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Check your API key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('Explain generation failed') }));
  });

  it('Retry re-runs generateText and can recover into the result state', async () => {
    generateText.mockRejectedValueOnce(new Error('transient failure'));
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    generateText.mockResolvedValueOnce({ text: 'recovered answer', servedModel: 'm' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());
    expect(screen.getByTestId('markdown').textContent).toBe('recovered answer');
  });

  it('Cancel aborts the in-flight call and closes the panel, without an error', async () => {
    const onClose = vi.fn();
    let capturedSignal: AbortSignal | undefined;
    generateText.mockImplementation((_p: string, _m?: string, _t?: number, _temp?: number, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return new Promise(() => {}); // never resolves — cancellation is the only way out
    });
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('Escape cancels while loading', () => {
    const onClose = vi.fn();
    generateText.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={onClose} />);
    fireEvent.keyDown(container.firstChild as Element, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape collapses once a result is shown', async () => {
    const onClose = vi.fn();
    generateText.mockResolvedValue({ text: 'answer', servedModel: 'm' });
    const { container } = render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());
    fireEvent.keyDown(container.firstChild as Element, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Copy copies the rendered answer text, not the prompt', async () => {
    generateText.mockResolvedValue({ text: 'the explanation text', servedModel: 'm' });
    render(<ExplainPanel prompt="the original prompt" scopeLabel="this exchange" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(clipboardWriteText).toHaveBeenCalledWith('the explanation text');
  });

  it('Copy shows a brief "Copied" confirmation, then reverts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    generateText.mockResolvedValue({ text: 'the explanation text', servedModel: 'm' });
    render(<ExplainPanel prompt="p" scopeLabel="this exchange" onClose={vi.fn()} />);
    await vi.waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('"Open in Gemini" copies the prompt (not the answer) and opens Gemini — available even while loading', () => {
    generateText.mockReturnValue(new Promise(() => {}));
    render(<ExplainPanel prompt="the original prompt" scopeLabel="this exchange" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Gemini' }));
    expect(clipboardWriteText).toHaveBeenCalledWith('the original prompt');
    expect(openExternal).toHaveBeenCalledWith('https://gemini.google.com/app');
  });

  it('Regenerate re-fetches and replaces the shown answer', async () => {
    generateText.mockResolvedValueOnce({ text: 'first answer', servedModel: 'm1' });
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());
    expect(screen.getByTestId('markdown').textContent).toBe('first answer');

    generateText.mockResolvedValueOnce({ text: 'second answer', servedModel: 'm2' });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(screen.getByTestId('markdown').textContent).toBe('second answer'));
    expect(screen.getByText('via m2')).toBeInTheDocument();
  });

  it('Collapse calls onClose', async () => {
    const onClose = vi.fn();
    generateText.mockResolvedValue({ text: 'answer', servedModel: 'm' });
    render(<ExplainPanel prompt="explain this" scopeLabel="this exchange" onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('markdown')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the scope label in the panel header', () => {
    generateText.mockReturnValue(new Promise(() => {}));
    render(<ExplainPanel prompt="explain this" scopeLabel="this selection" onClose={vi.fn()} />);
    expect(screen.getByText(/this selection/)).toBeInTheDocument();
  });
});
