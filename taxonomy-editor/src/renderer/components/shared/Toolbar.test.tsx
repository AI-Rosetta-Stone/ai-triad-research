// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression tests for t/2142: Zustand inline-object selector caused infinite
// render loop ("Maximum update depth exceeded"). Scalar selectors fix it;
// a successful render() call here proves the fix holds.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Store mocks ──────────────────────────────────────────────────────────────

const mockTaxonomyStore = {
  activeTab: 'accelerationist',
  setActiveTab: vi.fn(),
  toolbarPanel: null as string | null,
  setToolbarPanel: vi.fn(),
  selectedNodeId: null as string | null,
  selectedEdge: null,
  relatedNodeId: null,
};

vi.mock('../../hooks/useTaxonomyStore', () => {
  const hook = () => mockTaxonomyStore;
  hook.setState = vi.fn();
  return { useTaxonomyStore: hook };
});

const mockPrefsState = {
  viewMode: 'simple' as 'simple' | 'advanced',
  setViewMode: vi.fn(),
  hydrate: vi.fn(),
};

// Selector-aware mock — each scalar call returns the primitive directly,
// so Zustand's strict-equality check sees a stable value each render.
vi.mock('../../store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: typeof mockPrefsState) => unknown) =>
    selector(mockPrefsState),
}));

// ── Bridge / flight-recorder mocks ───────────────────────────────────────────

vi.mock('@bridge', () => ({
  isElectronMode: () => true,
  api: {
    adminReviewStats: vi.fn().mockResolvedValue({ total: 0 }),
    adminReviewConfigured: vi.fn().mockResolvedValue(false),
    openChatWindow: vi.fn(),
    openExternal: vi.fn(),
    clipboardWriteText: vi.fn(),
  },
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

// ── Auth / feature-flag / tier mocks ─────────────────────────────────────────

vi.mock('../../hooks/useAuthStatus', () => ({
  useAuthStatus: () => ({ anonymous: false, user: { name: 'Test' }, loading: false }),
  useUserProfile: () => null,
}));

// Configurable flags (t/2641): both useFlag and the whole-record store read the same
// source, so a test can reveal Op-Eds via EITHER build flag and prove the primary button
// honors the gate (it was hardcoded on env-electron-opeds → hidden on web).
const { mockFlags } = vi.hoisted(() => ({ mockFlags: { value: {} as Record<string, boolean> } }));
vi.mock('../../hooks/useFeatureFlags', () => ({
  useFlag: (name: string) => mockFlags.value[name] ?? false,
  // Toolbar threads the whole flag record via useNavVisibilityContext (t/2641).
  useFeatureFlagStore: (selector: (s: { flags: Record<string, boolean> }) => unknown) =>
    selector({ flags: mockFlags.value }),
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
}));

// ── Heavy child stubs ─────────────────────────────────────────────────────────

vi.mock('../settings/HelpDialog', () => ({ HelpDialog: () => null }));
vi.mock('../settings/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('./FeedbackPopover', () => ({ FeedbackPopover: () => null }));

// ── Component under test ──────────────────────────────────────────────────────

import { Toolbar } from './Toolbar';

describe('Toolbar — Zustand scalar selector regression (t/2142)', () => {
  beforeEach(() => {
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.setViewMode.mockClear();
  });

  it('renders without infinite loop in simple mode', () => {
    // Pre-fix (db9a67ba): inline object selector created new ref every render
    // → Zustand re-subscribed → re-render → "Maximum update depth exceeded"
    expect(() => render(<Toolbar />)).not.toThrow();
  });

  it('renders without infinite loop in advanced mode', () => {
    mockPrefsState.viewMode = 'advanced';
    expect(() => render(<Toolbar />)).not.toThrow();
  });

  it('shows view-mode toggle button in simple mode', () => {
    render(<Toolbar />);
    expect(
      screen.getByRole('button', { name: /switch to advanced view/i }),
    ).toBeInTheDocument();
  });

  it('shows view-mode toggle button in advanced mode', () => {
    mockPrefsState.viewMode = 'advanced';
    render(<Toolbar />);
    expect(
      screen.getByRole('button', { name: /switch to simple view/i }),
    ).toBeInTheDocument();
  });

  it('calls setViewMode with advanced when toggled from simple', async () => {
    render(<Toolbar />);
    await userEvent.click(
      screen.getByRole('button', { name: /switch to advanced view/i }),
    );
    expect(mockPrefsState.setViewMode).toHaveBeenCalledWith('advanced');
  });

  it('calls setViewMode with simple when toggled from advanced', async () => {
    mockPrefsState.viewMode = 'advanced';
    render(<Toolbar />);
    await userEvent.click(
      screen.getByRole('button', { name: /switch to simple view/i }),
    );
    expect(mockPrefsState.setViewMode).toHaveBeenCalledWith('simple');
  });
});

describe('Toolbar — primary Op-Eds button honors both build flags (t/2641)', () => {
  beforeEach(() => { mockFlags.value = {}; mockPrefsState.viewMode = 'simple'; });

  it('hides the Op-Eds button when neither build flag is set', () => {
    render(<Toolbar />);
    expect(screen.queryByRole('button', { name: 'Op-Ed Studies' })).toBeNull();
  });

  // The web-reveal case the hardcoded env-electron-opeds gate missed: env-web-opeds ON,
  // env-electron-opeds absent → the primary Op-Eds button MUST appear (the Toolbar is
  // what renders on desktop-width web).
  it('shows the Op-Eds button when only env-web-opeds is on (web reveal)', () => {
    mockFlags.value = { 'env-web-opeds': true };
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Op-Ed Studies' })).toBeInTheDocument();
  });

  it('shows the Op-Eds button when only env-electron-opeds is on (desktop, unchanged)', () => {
    mockFlags.value = { 'env-electron-opeds': true };
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Op-Ed Studies' })).toBeInTheDocument();
  });
});

// t/3616: same bug class as t/2641 — this Toolbar hardcodes primary buttons rather than mapping
// visibleItems, so a new gate-free primary NAV_ITEMS entry (inquiry, t/3583) silently never
// rendered here even though HamburgerMenu (data-driven) showed it correctly.
describe('Toolbar — primary Ask a Question button (t/3583, t/3616)', () => {
  beforeEach(() => { mockFlags.value = {}; mockPrefsState.viewMode = 'simple'; });

  it('shows the Ask a Question button unconditionally (no gate, unlike Op-Eds)', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Ask a Question' })).toBeInTheDocument();
  });
});

describe('Toolbar — primary nav order (t/4535, PI request p/351#29)', () => {
  beforeEach(() => { mockFlags.value = { 'env-electron-opeds': true }; mockPrefsState.viewMode = 'simple'; });

  it('renders Rosetta Stone, Chat, Op-Ed Studies, Ask a Question, Debate, Taxonomy in that DOM order (no Search button on this rail, t/2813)', () => {
    render(<Toolbar />);
    const labels = ['Rosetta Stone', 'Chat', 'Op-Ed Studies', 'Ask a Question', 'Debate', 'Taxonomy'];
    const buttons = labels.map(name => screen.getByRole('button', { name }));
    // Document order === tab order for plain (no explicit tabIndex) buttons, so this also
    // proves the AC's "keyboard tab order follows the visual order".
    for (let i = 1; i < buttons.length; i++) {
      expect(buttons[i - 1].compareDocumentPosition(buttons[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('keeps Rosetta Stone-Chat-Op-Eds-Ask a Question-Taxonomy order when Op-Eds is gated off (Debate absent from the DOM entirely is not the point here — order among what IS shown)', () => {
    mockFlags.value = {};
    render(<Toolbar />);
    const labels = ['Rosetta Stone', 'Chat', 'Ask a Question', 'Debate', 'Taxonomy'];
    const buttons = labels.map(name => screen.getByRole('button', { name }));
    expect(screen.queryByRole('button', { name: 'Op-Ed Studies' })).toBeNull(); // still gated (AC)
    for (let i = 1; i < buttons.length; i++) {
      expect(buttons[i - 1].compareDocumentPosition(buttons[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('Toolbar — Rosetta Stone topmost rail button (t/4543, PI decision t/4541#1)', () => {
  beforeEach(() => {
    mockFlags.value = {};
    mockPrefsState.viewMode = 'simple';
    mockTaxonomyStore.activeTab = 'accelerationist';
  });

  it('shows the Rosetta Stone button unconditionally (no gate)', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Rosetta Stone' })).toBeInTheDocument();
  });

  it('marks it active when activeTab is rosetta-stone', () => {
    mockTaxonomyStore.activeTab = 'rosetta-stone';
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Rosetta Stone' })).toHaveClass('toolbar-nav-active');
  });

  it('calls setActiveTab with rosetta-stone when clicked', async () => {
    mockTaxonomyStore.activeTab = 'chat';
    render(<Toolbar />);
    await userEvent.click(screen.getByRole('button', { name: 'Rosetta Stone' }));
    expect(mockTaxonomyStore.setActiveTab).toHaveBeenCalledWith('rosetta-stone');
  });
});
