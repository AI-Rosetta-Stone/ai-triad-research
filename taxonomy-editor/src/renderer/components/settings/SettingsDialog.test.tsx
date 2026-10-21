import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    hasApiKey: vi.fn().mockResolvedValue(false),
    addApiKey: vi.fn().mockResolvedValue({ count: 1 }),
    getApiKeys: vi.fn().mockResolvedValue([]),
    removeApiKey: vi.fn().mockResolvedValue(undefined),
    deleteAllApiKeys: vi.fn().mockResolvedValue(undefined),
    refreshAIModels: vi.fn().mockResolvedValue({ gemini: { ok: true, count: 3 }, claude: { ok: true, count: 2 }, groq: { ok: true, count: 1 }, openai: { ok: true, count: 1 }, deepseek: { ok: true, count: 1 }, ollama: { ok: true, count: 0 }, totalModels: 8 }),
    openExternal: vi.fn(),
    getAvailableBackends: vi.fn().mockResolvedValue([
      { id: 'gemini', available: true },
      { id: 'claude', available: true },
      { id: 'groq', available: true },
    ]),
  },
}));

let mockIsElectron = true;
vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: () => mockIsElectron }));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

let mockDescMode: 'formal' | 'plain' = 'plain';
const mockSetDescMode = vi.fn();
vi.mock('../shared/DescriptionToggle', () => ({
  useDescriptionMode: () => [mockDescMode, mockSetDescMode] as const,
}));

const mockSetColorScheme = vi.fn();
const mockSetAIBackend = vi.fn();
const mockSetGeminiModel = vi.fn();
const mockSetPaneSpacing = vi.fn();

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: () => ({
    colorScheme: 'harvard' as const,
    setColorScheme: mockSetColorScheme,
    paneSpacing: 'normal' as const,
    setPaneSpacing: mockSetPaneSpacing,
    aiBackend: 'gemini' as const,
    setAIBackend: mockSetAIBackend,
    geminiModel: 'gemini-3.5-flash-lite-preview' as const,
    setGeminiModel: mockSetGeminiModel,
  }),
  AI_BACKENDS: [
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'claude', label: 'Anthropic Claude' },
    { value: 'groq', label: 'Groq' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'azure', label: 'Azure OpenAI' },
    { value: 'moonshot', label: 'Moonshot' },
  ],
  MODELS_BY_BACKEND: {
    gemini: [
      { value: 'gemini-3.5-flash-lite-preview', label: '3.1 Flash Lite Preview' },
      { value: 'gemini-3-flash-preview', label: '3 Flash Preview' },
    ],
    claude: [{ value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
    groq: [{ value: 'llama-3.3-70b-versatile', label: 'LLaMA 3.3 70B' }],
    openai: [{ value: 'gpt-4o', label: 'GPT-4o' }],
    deepseek: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }],
    ollama: [{ value: 'llama3', label: 'LLaMA 3' }],
    azure: [{ value: 'gpt-4o-azure', label: 'GPT-4o (Azure)' }],
    moonshot: [{ value: 'kimi-k2', label: 'Kimi K2' }],
  },
  initAIModels: vi.fn().mockResolvedValue(undefined),
}));

import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDescMode = 'plain';
    mockIsElectron = true;
    useSettingsDialog.setState({ isOpen: false, requestedSection: null });
  });

  it('renders with heading and all setting sections', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('AI Backend')).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Pane 2 Item Spacing')).toBeInTheDocument();
    expect(screen.getByText('Description Display')).toBeInTheDocument();
  });

  it('renders backend options in the AI Backend select', () => {
    render(<SettingsDialog onClose={onClose} />);
    const backendSelect = screen.getAllByRole('combobox')[0];
    const options = Array.from(backendSelect.querySelectorAll('option'));
    expect(options.map(o => o.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Google Gemini'),
        expect.stringContaining('Anthropic Claude'),
      ]),
    );
  });

  it('renders theme options', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByText('Light')).toBeInTheDocument();
    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Harvard')).toBeInTheDocument();
  });

  it('calls onClose when Close button is clicked', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when clicking the overlay', async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsDialog onClose={onClose} />);
    const overlay = container.querySelector('.dialog-overlay')!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('changes theme when a new option is selected', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    const themeSelect = screen.getAllByRole('combobox').find(s =>
      Array.from(s.querySelectorAll('option')).some(o => o.textContent === 'Dark'),
    )!;
    await user.selectOptions(themeSelect, 'dark');
    expect(mockSetColorScheme).toHaveBeenCalledWith('dark');
  });

  it('renders description mode radio buttons with correct selection', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    const plainRadio = screen.getByRole('radio', { name: 'Plain' });
    const formalRadio = screen.getByRole('radio', { name: 'Formal' });
    expect(plainRadio).toBeChecked();
    expect(formalRadio).not.toBeChecked();
  });

  it('saves API key and shows success message', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: 'API Keys' }));
    const keyInput = screen.getByPlaceholderText('AIza...');
    await user.type(keyInput, 'AIzaSyTestKey');
    await user.click(screen.getByText('Save'));
    expect(mockApi.addApiKey).toHaveBeenCalledWith('AIzaSyTestKey', 'gemini');
    expect(await screen.findByText(/key saved/i)).toBeInTheDocument();
  });

  it('de-conflates the 3 backend states — has-key plain, no-key selectable BYOK, tier-restricted honest (t/2036)', async () => {
    mockApi.getAvailableBackends.mockResolvedValueOnce([
      { id: 'gemini', available: true },                            // #1 has key + tier-ok
      { id: 'moonshot', available: false, reason: 'no_key' },       // #2 BYOK-permitted, no key
      { id: 'azure', available: false, reason: 'tier_restricted' }, // #3 tier forbids BYOK
    ]);
    render(<SettingsDialog onClose={onClose} />);
    const backendSelect = screen.getAllByRole('combobox')[0];
    // #3 — restricted + honest label, and (the bug) NOT disabled-away as "(not on your tier)"
    const azure = await within(backendSelect).findByRole('option', { name: 'Azure OpenAI (sign in to use)' });
    expect(azure).toBeDisabled();
    // #2 — the key regression: a keyless BYOK-permitted backend stays SELECTABLE
    const moonshot = within(backendSelect).getByRole('option', { name: 'Moonshot (bring your own key)' });
    expect(moonshot).not.toBeDisabled();
    // #1 — plain, no suffix
    const gemini = within(backendSelect).getByRole('option', { name: 'Google Gemini' });
    expect(gemini).not.toBeDisabled();
  });

  const cleanBackends = {
    gemini: { ok: true, count: 3 }, claude: { ok: true, count: 2 }, groq: { ok: true, count: 1 },
    openai: { ok: true, count: 1 }, deepseek: { ok: true, count: 1 }, ollama: { ok: true, count: 0 },
  };

  it('surfaces a refused write as a warning, not a green save (t/2041)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8,
      written: false, configWarning: 'claude default "x" has no fallbackChain',
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));
    expect(await screen.findByText(/refused the write/i)).toBeInTheDocument();
    expect(screen.getByText(/no fallbackChain/)).toBeInTheDocument();
    expect(screen.getByText(/ai-models\.json unchanged/i)).toBeInTheDocument();
    expect(screen.queryByText(/saved to ai-models\.json/i)).not.toBeInTheDocument();
  });

  it('shows a non-fatal repair note on a written success (t/2041)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8,
      written: true, configWarning: 'pruned 1 dangling fallback target',
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));
    expect(await screen.findByText(/Repaired before saving/i)).toBeInTheDocument();
    expect(screen.getByText(/saved to ai-models\.json/i)).toBeInTheDocument();
    expect(screen.queryByText(/refused the write/i)).not.toBeInTheDocument();
  });

  it('shows normal success with no warning on a clean refresh (t/2041)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));
    expect(await screen.findByText(/saved to ai-models\.json/i)).toBeInTheDocument();
    expect(screen.queryByText(/refused the write/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Repaired before saving/i)).not.toBeInTheDocument();
  });

  // ── t/4163: refresh proposal review + accept ──────────────────────────────

  const proposal = {
    catalogFingerprint: 'sha256:fingerprint-1',
    hash: 'sha256:hash-1',
    changes: [
      { slot: 'defaults.gemini', from: 'gemini-2.5-flash', to: 'gemini-3.0-flash', family: 'gemini-flash', reason: 'vendor-absent' as const },
    ],
  };

  it('proposal-required: shows the proposed change and Accept sends the exact proposal, typed name and reason (t/4163)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: { reason: 'proposal-required', proposal },
      pinnedCandidates: [{ slots: ['defaults.claude'], pinned: 'claude-4-0', newerInFamily: 'claude-4-5' }],
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText('proposal-required')).toBeInTheDocument();
    expect(screen.getByText('defaults.gemini')).toBeInTheDocument();
    expect(screen.getByText('gemini-2.5-flash')).toBeInTheDocument();
    expect(screen.getByText('gemini-3.0-flash')).toBeInTheDocument();
    // pinnedCandidates are informational regardless of reason
    expect(screen.getByText(/claude-4-0/)).toBeInTheDocument();
    expect(screen.getByText(/claude-4-5/)).toBeInTheDocument();

    mockApi.refreshAIModels.mockResolvedValueOnce({ ...cleanBackends, totalModels: 8, written: true });
    await user.type(screen.getByPlaceholderText('Your name'), 'Jeffrey Snover');
    await user.type(screen.getByPlaceholderText('Why this change is correct'), 'Vendor retired the old id');
    await user.click(screen.getByText('Accept proposal'));

    expect(mockApi.refreshAIModels).toHaveBeenLastCalledWith({
      accept: { proposal, approvedBy: 'Jeffrey Snover', reason: 'Vendor retired the old id' },
    });
    expect(await screen.findByText(/saved to ai-models\.json/i)).toBeInTheDocument();
  });

  it('Accept refuses an empty reason client-side, without calling the API (t/4163)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: { reason: 'proposal-required', proposal },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));
    await screen.findByText('proposal-required');

    await user.type(screen.getByPlaceholderText('Your name'), 'Jeffrey Snover');
    // No reason typed.
    const callsBefore = mockApi.refreshAIModels.mock.calls.length;
    await user.click(screen.getByText('Accept proposal'));

    expect(screen.getByText(/name and a reason are required/i)).toBeInTheDocument();
    expect(mockApi.refreshAIModels.mock.calls.length).toBe(callsBefore);
  });

  it('proposal-changed: shows the diff and the recomputed proposal for re-review (t/4163)', async () => {
    const user = userEvent.setup();
    const recomputed = { ...proposal, hash: 'sha256:hash-2', changes: [{ ...proposal.changes[0], to: 'gemini-3.0-flash-lite' }] };
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: {
        reason: 'proposal-changed', accepted: proposal, recomputed,
        diff: { added: [], removed: [], changed: [{ slot: 'defaults.gemini', accepted: proposal.changes[0], recomputed: recomputed.changes[0] }] },
      },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText('proposal-changed')).toBeInTheDocument();
    expect(screen.getByText(/New proposal for re-review/)).toBeInTheDocument();
    expect(screen.getByText('gemini-3.0-flash-lite')).toBeInTheDocument();
    // Accept is offered against the recomputed proposal, not the stale accepted one.
    expect(screen.getByText('Accept proposal')).toBeInTheDocument();
  });

  it('needs-human: explains the unresolved slot and offers no Accept (t/4163)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: {
        reason: 'needs-human',
        proposal: { ...proposal, changes: [{ slot: 'defaults.claude', from: 'claude-3-0', to: null, reason: 'vendor-absent' as const }] },
        unresolved: ['defaults.claude'],
      },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText('needs-human')).toBeInTheDocument();
    expect(screen.getByText(/manual choice/i)).toBeInTheDocument();
    expect(screen.queryByText('Accept proposal')).not.toBeInTheDocument();
  });

  it('suspected-partial-catalog: explains the per-backend counts and offers no Accept or proposal table (t/4163)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: { reason: 'suspected-partial-catalog', backends: [{ backend: 'gemini', registered: 10, vendorListed: 2, wouldDrop: 8 }] },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText('suspected-partial-catalog')).toBeInTheDocument();
    expect(screen.getByText(/lists 2 of 10 registered/)).toBeInTheDocument();
    expect(screen.queryByText('Accept proposal')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('invalid: explains the dangling refs and offers no Accept (t/4163)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: { reason: 'invalid', dangling: ['defaults.gemini'], chainless: [] },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText('invalid')).toBeInTheDocument();
    expect(screen.getByText(/dangling refs: defaults\.gemini/)).toBeInTheDocument();
    expect(screen.queryByText('Accept proposal')).not.toBeInTheDocument();
  });

  it('on web (not Electron), Accept is disabled with an explanation even for proposal-required (t/4163)', async () => {
    mockIsElectron = false;
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false,
      refusal: { reason: 'proposal-required', proposal },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText('proposal-required')).toBeInTheDocument();
    expect(screen.getByText(/isn't available in the web app/i)).toBeInTheDocument();
    expect(screen.queryByText('Accept proposal')).not.toBeInTheDocument();
  });

  // ── t/4163#3/#4: a plain refresh is coerced to a dry run for everyone ─────

  it('coerced + no proposal: a clean dry run says nothing needs accepting, not "refused" (t/4163#3)', async () => {
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 8, written: false, coerced: true,
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText(/no changes needed/i)).toBeInTheDocument();
    expect(screen.queryByText(/refused the write/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Accept proposal')).not.toBeInTheDocument();
  });

  it('coerced + additive-only proposal: offers accept for the found models, sending the exact proposal (t/4163#4)', async () => {
    const user = userEvent.setup();
    const additiveProposal = { catalogFingerprint: 'sha256:fp', hash: 'sha256:additive', changes: [] };
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 9, written: false, coerced: true,
      proposal: additiveProposal,
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText(/9 new models found; accept to add them/i)).toBeInTheDocument();

    mockApi.refreshAIModels.mockResolvedValueOnce({ ...cleanBackends, totalModels: 9, written: true });
    await user.type(screen.getByPlaceholderText('Your name'), 'Jeffrey Snover');
    await user.type(screen.getByPlaceholderText('Why this change is correct'), 'New models look good');
    await user.click(screen.getByText('Accept proposal'));

    expect(mockApi.refreshAIModels).toHaveBeenLastCalledWith({
      accept: { proposal: additiveProposal, approvedBy: 'Jeffrey Snover', reason: 'New models look good' },
    });
  });

  it('coerced + additive-only proposal on web: Accept stays disabled like any other coerced result (t/4163#4)', async () => {
    mockIsElectron = false;
    const user = userEvent.setup();
    mockApi.refreshAIModels.mockResolvedValueOnce({
      ...cleanBackends, totalModels: 9, written: false, coerced: true,
      proposal: { catalogFingerprint: 'sha256:fp', hash: 'sha256:additive', changes: [] },
    });
    render(<SettingsDialog onClose={onClose} />);
    await user.click(screen.getByText('Refresh Models'));

    expect(await screen.findByText(/9 new models found; accept to add them/i)).toBeInTheDocument();
    expect(screen.getByText(/isn't available in the web app/i)).toBeInTheDocument();
    expect(screen.queryByText('Accept proposal')).not.toBeInTheDocument();
  });
});
