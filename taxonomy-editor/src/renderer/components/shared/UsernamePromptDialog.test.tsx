// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock localStorage before any store imports
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn((key: string) => { storage.delete(key); }),
  clear: vi.fn(() => { storage.clear(); }),
  length: 0,
  key: vi.fn(),
};
vi.stubGlobal('localStorage', localStorageMock);

import { UsernamePromptDialog, UsernameBadge } from './UsernamePromptDialog';
import { useUsernameStore } from '../../hooks/useUsernameStore';

describe('UsernamePromptDialog', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    useUsernameStore.setState({
      username: null,
      promptOpen: false,
      onConfirm: null,
    });
  });

  it('renders nothing when promptOpen is false', () => {
    const { container } = render(<UsernamePromptDialog />);
    expect(container.querySelector('.dialog-overlay')).toBeNull();
  });

  it('renders dialog when promptOpen is true', () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    expect(screen.getByRole('heading', { name: 'Set Username' })).toBeInTheDocument();
  });

  it('shows "Change Username" title when username already exists', () => {
    useUsernameStore.setState({ username: 'Alice', promptOpen: true });
    render(<UsernamePromptDialog />);
    expect(screen.getByText('Change Username')).toBeInTheDocument();
  });

  it('pre-fills input with existing username', () => {
    useUsernameStore.setState({ username: 'Alice', promptOpen: true });
    render(<UsernamePromptDialog />);
    const input = screen.getByPlaceholderText('Your name') as HTMLInputElement;
    expect(input.value).toBe('Alice');
  });

  it('shows validation error for empty submission', async () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Set Username' }));
    expect(screen.getByText('Username cannot be empty')).toBeInTheDocument();
  });

  it('shows validation error for whitespace-only submission', async () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    await userEvent.type(screen.getByPlaceholderText('Your name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Set Username' }));
    expect(screen.getByText('Username cannot be empty')).toBeInTheDocument();
  });

  it('saves username on valid submission', async () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    await userEvent.type(screen.getByPlaceholderText('Your name'), 'Bob');
    await userEvent.click(screen.getByRole('button', { name: 'Set Username' }));
    expect(useUsernameStore.getState().username).toBe('Bob');
    expect(useUsernameStore.getState().promptOpen).toBe(false);
  });

  it('closes prompt when Cancel is clicked', async () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUsernameStore.getState().promptOpen).toBe(false);
  });

  it('closes prompt when overlay is clicked', async () => {
    useUsernameStore.setState({ promptOpen: true });
    const { container } = render(<UsernamePromptDialog />);
    const overlay = container.querySelector('.dialog-overlay')!;
    await userEvent.click(overlay);
    expect(useUsernameStore.getState().promptOpen).toBe(false);
  });

  // t/4909: role/aria-modal/aria-labelledby + dialog-wide Esc (previously only on the input).
  it('has role="dialog" and aria-modal, and Esc closes the prompt with focus anywhere inside', () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    screen.getByRole('button', { name: 'Cancel' }).focus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useUsernameStore.getState().promptOpen).toBe(false);
  });

  it('clears validation error when user starts typing', async () => {
    useUsernameStore.setState({ promptOpen: true });
    render(<UsernamePromptDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Set Username' }));
    expect(screen.getByText('Username cannot be empty')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Your name'), 'A');
    expect(screen.queryByText('Username cannot be empty')).toBeNull();
  });
});

describe('UsernameBadge', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    useUsernameStore.setState({
      username: null,
      promptOpen: false,
      onConfirm: null,
    });
  });

  it('renders nothing when no username is set', () => {
    const { container } = render(<UsernameBadge />);
    expect(container.querySelector('.username-badge')).toBeNull();
  });

  it('renders username when set', () => {
    useUsernameStore.setState({ username: 'Alice' });
    render(<UsernameBadge />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('opens username prompt on click', async () => {
    useUsernameStore.setState({ username: 'Alice' });
    render(<UsernameBadge />);
    await userEvent.click(screen.getByText('Alice'));
    expect(useUsernameStore.getState().promptOpen).toBe(true);
  });
});
