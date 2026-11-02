// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The location bar per docs/ux/navigation-location-bar.md (t/4640#40 items 2 and 3): the History
// group (← → ▾), destination tooltips, the Recent menu, and the crumbs each place produces.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationBarHost } from './LocationBarHost';
import { navHistory } from '../../navigation';
import { goToPath } from '../../navigation/restore';
import type { HistoryEntry } from '../../navigation/types';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { useOpEdStore } from '../../hooks/useOpEdStore';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { useBreakpoint } from '../../hooks/useBreakpoint';

// Auto-mocked: returns undefined (not 'phone') unless a test says otherwise.
vi.mock('../../hooks/useBreakpoint');
vi.mock('../../hooks/useTaxonomyStore');
vi.mock('../../hooks/useDebateStore');
vi.mock('../../hooks/useChatStore');
vi.mock('../../hooks/useOpEdStore');
vi.mock('../../hooks/useInquiryStore');
vi.mock('../../navigation');
vi.mock('../../navigation/restore');

const entry = (path: string, placeKey: string, label: string): HistoryEntry => ({ path, placeKey, label, timestamp: 0 });
const STACK = [
  entry('/', 'rosetta-stone', 'Rosetta Stone'),
  entry('/chat', 'chat:none', 'Chat'),
  entry('/debate', 'debate:none', 'Debate'),
];

/** Point the mocked history at `entries` with `index` current. */
function historyAt(entries: HistoryEntry[], index: number): void {
  const h = vi.mocked(navHistory);
  h.entries.mockReturnValue(entries);
  h.index.mockReturnValue(index);
  h.current.mockReturnValue(entries[index] ?? null);
  h.canGoBack.mockReturnValue(index > 0);
  h.canGoForward.mockReturnValue(index < entries.length - 1);
}

function stores(taxonomy: Record<string, unknown>, extra: { chat?: unknown; opEd?: unknown } = {}): void {
  vi.mocked(useTaxonomyStore).mockReturnValue({ activeTab: 'rosetta-stone', selectedNodeId: null, ...taxonomy } as never);
  vi.mocked(useDebateStore).mockReturnValue({ activeDebate: null } as never);
  vi.mocked(useChatStore).mockReturnValue((extra.chat ?? { activeChat: null }) as never);
  vi.mocked(useOpEdStore).mockReturnValue((extra.opEd ?? { selectedSetId: null, sets: [] }) as never);
  vi.mocked(useInquiryStore).mockReturnValue({ result: null, jobId: null } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(navHistory).subscribe.mockReturnValue(() => {});
  historyAt([STACK[0]], 0);
  stores({});
});

describe('Back / Forward (§ Back / Forward)', () => {
  it('with no history: plain "Back"/"Forward", disabled and aria-disabled', () => {
    render(<LocationBarHost />);
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toBeDisabled();
    expect(back).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('names the destination in aria-label and title, with the shortcut in the title only', () => {
    historyAt(STACK, 1);
    render(<LocationBarHost />);
    const back = screen.getByRole('button', { name: 'Back to Rosetta Stone' });
    expect(back).toBeEnabled();
    expect(back).toHaveAttribute('title', 'Back to Rosetta Stone (Alt+←)');
    expect(back).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');
    expect(screen.getByRole('button', { name: 'Forward to Debate' })).toBeEnabled();
  });

  it('truncates a long destination label at 60 characters', () => {
    const long = 'x'.repeat(80);
    historyAt([entry('/chat/c', 'chat:c', long), STACK[2]], 1);
    render(<LocationBarHost />);
    expect(screen.getByRole('button', { name: `Back to ${'x'.repeat(59)}…` })).toBeInTheDocument();
  });

  it('clicking Back calls navHistory.back()', async () => {
    historyAt(STACK, 2);
    render(<LocationBarHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Back to Chat' }));
    expect(navHistory.back).toHaveBeenCalledTimes(1);
  });

  it('sits in a "History" group with the Recent button', () => {
    render(<LocationBarHost />);
    const group = screen.getByRole('group', { name: 'History' });
    expect(within(group).getByRole('button', { name: 'Recent locations' })).toBeInTheDocument();
  });
});

describe('Recent locations (§ ▾ Recent locations menu)', () => {
  it('is disabled when no other entry exists', () => {
    render(<LocationBarHost />);
    expect(screen.getByRole('button', { name: 'Recent locations' })).toBeDisabled();
  });

  it('lists the stack newest first, marks the current entry, and focuses it on open', async () => {
    historyAt(STACK, 1);
    render(<LocationBarHost />);
    const button = screen.getByRole('button', { name: 'Recent locations' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map(i => i.querySelector('.nav-locbar-menu-label')?.textContent)).toEqual(['Debate', 'Chat', 'Rosetta Stone']);
    expect(items[1]).toHaveAttribute('aria-current', 'page');
    expect(items[1]).toHaveAccessibleName('Chat, you are here');
    expect(items[1]).toHaveFocus();
  });

  it('caps the list at 15 entries', async () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(`/chat/${i}`, `chat:${i}`, `Chat ${i}`));
    historyAt(many, 19);
    render(<LocationBarHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Recent locations' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(15);
  });

  it('activating an entry is one go(delta) to it; the current entry just closes the menu', async () => {
    historyAt(STACK, 1);
    render(<LocationBarHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Recent locations' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Debate' }));
    expect(navHistory.go).toHaveBeenCalledWith(1);

    await userEvent.click(screen.getByRole('button', { name: 'Recent locations' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rosetta Stone' }));
    expect(navHistory.go).toHaveBeenCalledWith(-1);

    await userEvent.click(screen.getByRole('button', { name: 'Recent locations' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Chat, you are here' }));
    expect(navHistory.go).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keyboard: ↓/End move focus; Esc closes and returns focus to ▾', async () => {
    historyAt(STACK, 2);
    render(<LocationBarHost />);
    const button = screen.getByRole('button', { name: 'Recent locations' });
    await userEvent.click(button);
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(items[2]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });
});

describe('crumbs per place (§ Breadcrumb table)', () => {
  const crumbTexts = () =>
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem').map(li => li.textContent);

  it('the landing page is just "Rosetta Stone"', () => {
    render(<LocationBarHost />);
    expect(crumbTexts()).toEqual(['Rosetta Stone']);
  });

  it('a tool has no "Rosetta Stone" prefix', () => {
    stores({ activeTab: 'debate' });
    render(<LocationBarHost />);
    expect(crumbTexts()).toEqual(['Debate']);
  });

  it('a taxonomy node shows Taxonomy › ● Camp › node label — never the node id', () => {
    stores({
      activeTab: 'accelerationist',
      selectedNodeId: 'acc-desires-010',
      accelerationist: { nodes: [{ id: 'acc-desires-010', label: 'Unlock abundance through compute' }] },
    });
    render(<LocationBarHost />);
    expect(crumbTexts()).toEqual(['Taxonomy', 'Accelerationist', 'Unlock abundance through compute']);
    expect(screen.queryByText(/acc-desires-010/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Accelerationist' })).toHaveAttribute('href', '/taxonomy/acc');
  });

  it('while the node label is still loading, shows Taxonomy › Camp only — no id', () => {
    stores({ activeTab: 'accelerationist', selectedNodeId: 'acc-desires-010', accelerationist: null });
    render(<LocationBarHost />);
    expect(crumbTexts()).toEqual(['Taxonomy', 'Accelerationist']);
  });

  it('an op-ed set shows Op-Ed Studies › topic › ● Camp, the camp read from ?pov=', () => {
    stores({ activeTab: 'opeds' }, { opEd: { selectedSetId: 's1', sets: [{ set_id: 's1', topic: 'Compute caps' }] } });
    historyAt([entry('/opeds/s1?pov=saf', 'opeds:s1', 'Compute caps')], 0);
    render(<LocationBarHost />);
    expect(crumbTexts()).toEqual(['Op-Ed Studies', 'Compute caps', 'Safetyist']);
  });

  it('clicking an up-link goes to its collection via goToPath (a push)', async () => {
    stores({ activeTab: 'chat' }, { chat: { activeChat: { id: 'c1', topic: 'Compute caps' } } });
    render(<LocationBarHost />);
    await userEvent.click(screen.getByRole('link', { name: 'Chat' }));
    expect(goToPath).toHaveBeenCalledWith('/chat');
  });
});

describe('phone up (§ Phone "up")', () => {
  beforeEach(() => {
    vi.mocked(useBreakpoint).mockReturnValue('phone');
  });

  it('a deep-linked item at phone width: ← is enabled as "Up to Chat" and goes to the collection', async () => {
    stores({ activeTab: 'chat' }, { chat: { activeChat: { id: 'c1', topic: 'Compute caps' } } });
    historyAt([entry('/chat/c1', 'chat:c1', 'Compute caps')], 0);
    render(<LocationBarHost />);

    const up = screen.getByRole('button', { name: 'Up to Chat' });
    expect(up).toBeEnabled();
    expect(up).toHaveAttribute('title', 'Up to Chat');
    expect(up).not.toHaveAttribute('aria-keyshortcuts');
    await userEvent.click(up);
    expect(goToPath).toHaveBeenCalledWith('/chat');
    expect(navHistory.back).not.toHaveBeenCalled();
  });

  it('with history to go back to, ← stays plain Back even at phone width', async () => {
    stores({ activeTab: 'chat' }, { chat: { activeChat: { id: 'c1', topic: 'Compute caps' } } });
    historyAt([STACK[1], entry('/chat/c1', 'chat:c1', 'Compute caps')], 1);
    render(<LocationBarHost />);

    await userEvent.click(screen.getByRole('button', { name: 'Back to Chat' }));
    expect(navHistory.back).toHaveBeenCalledTimes(1);
    expect(goToPath).not.toHaveBeenCalled();
  });

  it('on a collection (no linked ancestor) with no history, ← is a disabled plain Back', () => {
    stores({ activeTab: 'debate' });
    render(<LocationBarHost />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });
});

describe('web build (§ Contents by build)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shows ← and ▾ but no → (the browser owns Forward)', async () => {
    vi.stubEnv('VITE_TARGET', 'web');
    vi.resetModules();
    const { LocationBarHost: WebHost } = await import('./LocationBarHost');
    const { navHistory: webHistory } = await import('../../navigation');
    // resetModules gave the host fresh (auto-mocked) store modules; give them state again.
    vi.mocked((await import('../../hooks/useTaxonomyStore')).useTaxonomyStore).mockReturnValue({ activeTab: 'rosetta-stone', selectedNodeId: null } as never);
    vi.mocked((await import('../../hooks/useDebateStore')).useDebateStore).mockReturnValue({ activeDebate: null } as never);
    vi.mocked((await import('../../hooks/useChatStore')).useChatStore).mockReturnValue({ activeChat: null } as never);
    vi.mocked((await import('../../hooks/useOpEdStore')).useOpEdStore).mockReturnValue({ selectedSetId: null, sets: [] } as never);
    vi.mocked((await import('../../hooks/useInquiryStore')).useInquiryStore).mockReturnValue({ result: null, jobId: null } as never);
    vi.mocked(webHistory).subscribe.mockReturnValue(() => {});
    vi.mocked(webHistory).entries.mockReturnValue(STACK);
    vi.mocked(webHistory).index.mockReturnValue(1);
    vi.mocked(webHistory).canGoBack.mockReturnValue(true);
    render(<WebHost />);
    expect(screen.getByRole('button', { name: 'Back to Rosetta Stone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Recent locations' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Forward/ })).toBeNull();
  });
});
