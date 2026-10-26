// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2036 — NewChatDialog backend dropdown regression. Before the fix this dialog
// FILTERED tier-unavailable backends out of the list entirely (worse than SettingsDialog's
// disable). These assertions lock the 3-state de-conflation: every backend renders;
// no-key is selectable "(bring your own key)"; tier-forbidden is honestly "(sign in to use)";
// and a free-tier-pool backend stays plain (usable without a key).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi, mockCreateChat, mockRegistry } = vi.hoisted(() => ({
  mockApi: {
    hasApiKey: vi.fn().mockResolvedValue(false),
    getAvailableBackends: vi.fn().mockResolvedValue([]),
    openChatWindow: vi.fn(),
  },
  mockCreateChat: vi.fn().mockResolvedValue('chat-1'),
  mockRegistry: { povs: {} as Record<string, { id: string; label: string }[]> },
}));
vi.mock('@bridge', () => ({ api: mockApi }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@lib/schema/povTags', () => ({ loadPovTagRegistry: () => mockRegistry }));

vi.mock('../../hooks/useChatStore', () => ({
  useChatStore: () => ({ createChat: mockCreateChat, loadChat: vi.fn() }),
}));

const { useTaxonomyStoreMock, mockPovNodes } = vi.hoisted(() => {
  const nodes: Record<string, { id: string; pov_tags?: string[] }[]> = {
    accelerationist: [], safetyist: [], skeptic: [],
  };
  return {
    mockPovNodes: nodes,
    useTaxonomyStoreMock: Object.assign(
      () => ({ aiBackend: 'gemini' as const, geminiModel: 'gemini-flash' }),
      { getState: () => ({
        accelerationist: { nodes: nodes.accelerationist },
        safetyist: { nodes: nodes.safetyist },
        skeptic: { nodes: nodes.skeptic },
      }) },
    ),
  };
});
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: useTaxonomyStoreMock,
  AI_BACKENDS: [
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'moonshot', label: 'Moonshot' },
    { value: 'azure', label: 'Azure OpenAI' },
  ],
  MODELS_BY_BACKEND: {
    gemini: [{ value: 'gemini-flash', label: 'Flash' }],
    moonshot: [{ value: 'kimi-k2', label: 'Kimi K2' }],
    azure: [{ value: 'gpt-4o-azure', label: 'GPT-4o (Azure)' }],
  },
}));

let mockTier: { allowedBackends: string[] } | null = null;
let mockIsFree = false;
vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: mockTier }),
  isFreeTier: () => mockIsFree,
}));

import { NewChatDialog } from './NewChatDialog';

async function revealBackendSelect() {
  const user = userEvent.setup();
  render(<NewChatDialog onClose={vi.fn()} />);
  await user.click(screen.getByLabelText(/use a different model/i));
  // The backend select is the first combobox once the custom-model fields appear.
  return screen.getAllByRole('combobox')[0];
}

describe('NewChatDialog backend dropdown (t/2036)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTier = null;
    mockIsFree = false;
    mockApi.hasApiKey.mockResolvedValue(false);
    mockRegistry.povs = {};
    mockCreateChat.mockResolvedValue('chat-1');
  });

  it('renders all 3 states — no filtering-out; no-key selectable, tier-restricted honest', async () => {
    mockApi.getAvailableBackends.mockResolvedValue([
      { id: 'gemini', available: true },                            // #1
      { id: 'moonshot', available: false, reason: 'no_key' },       // #2
      { id: 'azure', available: false, reason: 'tier_restricted' }, // #3
    ]);
    const select = await revealBackendSelect();
    // #3 present (not filtered out) + honest + disabled
    const azure = await within(select).findByRole('option', { name: 'Azure OpenAI (sign in to use)' });
    expect(azure).toBeDisabled();
    // #2 selectable BYOK
    const moonshot = within(select).getByRole('option', { name: 'Moonshot (bring your own key)' });
    expect(moonshot).not.toBeDisabled();
    // #1 plain
    expect(within(select).getByRole('option', { name: 'Google Gemini' })).not.toBeDisabled();
  });

  it('free-tier-pool backend stays plain + selectable (usable without a key)', async () => {
    mockIsFree = true;
    mockTier = { allowedBackends: ['gemini'] };
    // Server reports gemini no_key (pool key isn't in keyStore), but it's free-tier usable.
    mockApi.getAvailableBackends.mockResolvedValue([{ id: 'gemini', available: false, reason: 'no_key' }]);
    const select = await revealBackendSelect();
    const gemini = within(select).getByRole('option', { name: 'Google Gemini' });
    expect(gemini).not.toBeDisabled();
    expect(gemini.textContent).toBe('Google Gemini'); // no "(bring your own key)" suffix
  });
});

describe('NewChatDialog POV tag wiring (t/3959)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTier = null;
    mockIsFree = false;
    mockApi.hasApiKey.mockResolvedValue(false);
    mockCreateChat.mockResolvedValue('chat-1');
    mockPovNodes.accelerationist = [];
    mockPovNodes.safetyist = [];
  });

  it('passes undefined tag to createChat when no POV tag is selected', async () => {
    mockRegistry.povs = {};
    const user = userEvent.setup();
    render(<NewChatDialog onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/explore/i), 'topic');
    await user.click(screen.getByRole('button', { name: /start chat/i }));
    expect(mockCreateChat).toHaveBeenCalledWith('brainstorm', 'accelerationist', 'topic', undefined, undefined);
  });

  it('disables Start for Scope below the minimum, and for Prioritize at zero tagged nodes (TL t/3957#7, t/3959#5)', async () => {
    mockRegistry.povs = { accelerationist: [{ id: 'critical', label: 'Critical' }] };
    mockPovNodes.accelerationist = []; // zero nodes carry the tag
    const user = userEvent.setup();
    render(<NewChatDialog onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/explore/i), 'topic');
    await user.selectOptions(screen.getByLabelText('accelerationist tag'), 'critical');

    // Scope: below the 5-node minimum.
    expect(screen.getByRole('button', { name: /start chat/i })).toBeDisabled();

    // Prioritize: still blocked, because zero nodes carry the tag (no floor above zero otherwise).
    await user.click(screen.getByLabelText('Prioritize'));
    expect(screen.getByRole('button', { name: /start chat/i })).toBeDisabled();
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('passes the selected tag to createChat once Prioritize has at least one tagged node', async () => {
    mockRegistry.povs = { accelerationist: [{ id: 'critical', label: 'Critical' }] };
    mockPovNodes.accelerationist = [{ id: 'a1', pov_tags: ['critical'] }];
    const user = userEvent.setup();
    render(<NewChatDialog onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/explore/i), 'topic');
    await user.selectOptions(screen.getByLabelText('accelerationist tag'), 'critical');
    await user.click(screen.getByLabelText('Prioritize'));
    expect(screen.getByRole('button', { name: /start chat/i })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: /start chat/i }));
    expect(mockCreateChat).toHaveBeenCalledWith(
      'brainstorm', 'accelerationist', 'topic', undefined,
      { pov_tag: 'critical', tag_mode: 'prioritize' },
    );
  });

  it('resets the tag when the POV changes', async () => {
    mockRegistry.povs = {
      accelerationist: [{ id: 'critical', label: 'Critical' }],
      safetyist: [{ id: 'cautious', label: 'Cautious' }],
    };
    const user = userEvent.setup();
    render(<NewChatDialog onClose={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText('accelerationist tag'), 'critical');
    await user.click(screen.getByText('Safetyist'));
    expect(screen.getByLabelText('safetyist tag')).toHaveValue('');
  });
});

describe('NewChatDialog starter-chip prefill (t/4536)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTier = null;
    mockIsFree = false;
    mockApi.hasApiKey.mockResolvedValue(false);
    mockRegistry.povs = {};
    mockCreateChat.mockResolvedValue('chat-1');
  });

  it('seeds mode and topic from initialMode/initialTopic, and focuses the first POVer choice', () => {
    render(<NewChatDialog onClose={vi.fn()} initialMode="decide" initialTopic="Work through a policy decision" />);
    expect(screen.getByDisplayValue('Work through a policy decision')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start chat/i })).not.toBeDisabled();
    expect(document.activeElement).toHaveAttribute('name', 'chatPover');
  });

  it('starts with an empty topic and no forced focus when opened unprefilled', () => {
    render(<NewChatDialog onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/explore/i)).toHaveValue('');
  });

  it('creates the chat with the prefilled mode once a topic is given', async () => {
    const user = userEvent.setup();
    render(<NewChatDialog onClose={vi.fn()} initialMode="inform" initialTopic="Strongest evidence for the Accelerationist case" />);
    await user.click(screen.getByRole('button', { name: /start chat/i }));
    expect(mockCreateChat).toHaveBeenCalledWith(
      'inform', 'accelerationist', 'Strongest evidence for the Accelerationist case', undefined, undefined,
    );
  });
});
