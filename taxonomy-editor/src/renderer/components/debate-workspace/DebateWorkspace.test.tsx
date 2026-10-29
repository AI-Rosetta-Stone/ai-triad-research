// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { DebateWorkspace } from './DebateWorkspace';
import { usePreferencesStore } from '../../store/preferencesStore';
import { api } from '@bridge';

// ── Store mocks ───────────────────────────────────────────────

const mockStore: Record<string, any> = {
  activeDebate: null,
  debateLoading: false,
  debateError: null,
  debateGenerating: null,
  runClarification: vi.fn(),
  runOpeningStatements: vi.fn(),
  saveDebate: vi.fn(),
  compressOldTranscript: vi.fn(),
  diagnosticsEnabled: false,
  toggleDiagnostics: vi.fn(),
  selectedDiagEntry: null,
  selectDiagEntry: vi.fn(),
  diagPopoutOpen: false,
  setDiagPopoutOpen: vi.fn(),
  responseLength: 'detailed',
  setResponseLength: vi.fn(),
  factCheckSelection: vi.fn(),
  reExtractClaims: vi.fn(),
  driverIsRemote: false,
};

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: any) => selector(mockStore),
    {
      getState: () => mockStore,
      setState: (partial: Record<string, any>) => Object.assign(mockStore, partial),
    },
  ),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}));

const mockTaxStore: Record<string, any> = {
  runSemanticSearch: vi.fn(),
  setFindQuery: vi.fn(),
  setFindMode: vi.fn(),
  setToolbarPanel: vi.fn(),
  semanticResults: [],
  getLabelForId: vi.fn(() => 'label'),
  communityServerUrl: '',
};

// useTaxonomyStore is called both with and without a selector in this component.
// MODELS_BY_BACKEND is pulled in transitively via DetailPane → NodeDetail → …/PromptInspector (t/1776).
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector?: any) => selector ? selector(mockTaxStore) : mockTaxStore,
  MODELS_BY_BACKEND: {},
}));

const mockCommentStore: Record<string, any> = {
  commentsFile: null,
  loadComments: vi.fn(),
  unloadComments: vi.fn(),
  sidebarOpen: false,
  toggleSidebar: vi.fn(),
};

// useCommentStore is called without a selector in this component
vi.mock('../../hooks/useCommentStore', () => ({
  useCommentStore: (selector?: any) => selector ? selector(mockCommentStore) : mockCommentStore,
}));

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: (selector: any) => selector({ submitItem: vi.fn() }),
}));

vi.mock('../../hooks/useAuthStatus', () => ({
  useUserProfile: () => null,
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
}));

// ── Bridge / side-effect mocks ────────────────────────────────

vi.mock('@bridge', () => ({
  api: {
    onDiagnosticsPopoutClosed: vi.fn(() => vi.fn()),
    onDebatePopoutClosed: vi.fn(() => vi.fn()),
    onReExtractClaims: vi.fn(() => vi.fn()),
    clipboardWriteText: vi.fn(),
    openExternal: vi.fn(),
  },
}));

const mockMarkAsPopout = vi.fn(() => {
  mockStore.driverIsRemote = false;
});
vi.mock('../../hooks/useDebateStore/shared/guards', () => ({
  initDebatePopoutCloseHandler: vi.fn(() => vi.fn()),
  markAsPopout: (...args: any[]) => mockMarkAsPopout(...args),
  isDebatePopoutWindow: vi.fn(() => false),
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

vi.mock('../../lib/flightRecorderInit', () => ({
  triggerManualDump: vi.fn(),
}));

vi.mock('@lib/debate/coverageTracker', () => ({
  computeCoverageMap: vi.fn(() => null),
  computeStrengthWeightedCoverage: vi.fn(() => null),
}));

// ── External child-component mocks ────────────────────────────

vi.mock('../debate/DebateSourceViewer', () => ({
  DebateSourceViewer: () => <div data-testid="source-viewer" />,
}));
vi.mock('../analysis/NeutralEvaluationPanel', () => ({
  NeutralEvaluationPanel: () => <div data-testid="eval-panel" />,
}));
vi.mock('../analysis/ParameterHistoryPanel', () => ({
  ParameterHistoryPanel: () => <div data-testid="param-history" />,
}));
vi.mock('../chat/CommentCreationPopover', () => ({
  CommentCreationPopover: () => <div data-testid="comment-popover" />,
}));
vi.mock('../chat/CommentSidebar', () => ({
  CommentSidebar: () => <div data-testid="comment-sidebar" />,
}));
vi.mock('../shared/UsernamePromptDialog', () => ({
  UsernamePromptDialog: () => <div data-testid="username-dialog" />,
}));
vi.mock('../shared/CommunityShareBanner', () => ({
  CommunityShareBanner: () => <div data-testid="share-banner" />,
}));
vi.mock('../shared/EmptyState', () => ({
  EmptyState: ({ headline }: any) => <div data-testid="empty-state">{headline}</div>,
}));
vi.mock('../debate-diagnostics/chat', () => ({
  DiagnosticsChatSidebar: () => <div data-testid="diag-chat" />,
}));

// ── Debate type mocks ─────────────────────────────────────────

vi.mock('../../types/debate', () => ({
  POVER_INFO: {
    accelerationist: { label: 'Accelerationist', color: 'var(--color-acc)' },
    safetyist: { label: 'Safetyist', color: 'var(--color-saf)' },
    skeptic: { label: 'Skeptic', color: 'var(--color-skp)' },
  },
  DEBATE_AUDIENCES: [
    { id: 'policymaker', label: 'Policymaker' },
    { id: 'technical', label: 'Technical' },
  ],
}));

vi.mock('@lib/debate/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/debate/types')>();
  return { ...actual };
});

// ── Local workspace sub-component mocks ──────────────────────

vi.mock('./StatementCard', () => ({
  StatementCard: ({ entry }: any) => <div data-testid={`statement-${entry.id}`} />,
  ProbingCard: ({ entry }: any) => <div data-testid={`probing-${entry.id}`} />,
  FactCheckCard: ({ entry }: any) => <div data-testid={`factcheck-${entry.id}`} />,
  PhaseHairline: ({ label }: any) => <div data-testid={`hairline-${label}`} />,
  EntryDeleteControls: () => null,
  HighlightedText: ({ text }: any) => <span>{text}</span>,
}));
vi.mock('./DebateActionBar', () => ({
  PhaseProgressBar: () => <div data-testid="phase-progress" />,
  SessionPhaseStepper: () => <div data-testid="session-stepper" />,
  UnifiedPhaseIndicator: ({ adaptive }: any) => (
    <div data-testid="unified-phase-indicator" data-has-adaptive={adaptive ? 'yes' : 'no'} />
  ),
  ProgressIndicator: () => <div data-testid="progress-indicator" />,
  DebaterToggles: () => <div data-testid="debater-toggles" />,
  // Renders real toggle buttons (wired to the setters it's actually given) so tests
  // can drive showEvaluation/showParamHistory without reimplementing the Tools menu.
  DebateActions: ({ showEvaluation, setShowEvaluation, showParamHistory, setShowParamHistory }: any) => (
    <div data-testid="debate-actions">
      <button type="button" onClick={() => setShowEvaluation(!showEvaluation)}>Evaluation</button>
      <button type="button" onClick={() => setShowParamHistory(!showParamHistory)}>Calibration</button>
    </div>
  ),
}));
// Controllable feature-flag mock (default: all flags off — preserves existing flag-off tests).
const mockFlags: Record<string, boolean> = {};
vi.mock('../../hooks/useFeatureFlags', () => ({
  useFlag: (name: string) => mockFlags[name] ?? false,
}));
vi.mock('./ClarificationPanel', () => ({
  ClarificationActions: () => <div data-testid="clarification-actions" />,
  ClaimsEditor: () => <div data-testid="claims-editor" />,
  RefinedTopicEditor: () => <div data-testid="refined-topic-editor" />,
  TopicScoreComparison: () => <div data-testid="topic-score-comparison" />,
}));
vi.mock('./OpeningPanel', () => ({
  OpeningActions: () => <div data-testid="opening-actions" />,
}));
vi.mock('./TaxonomyRefs', () => ({
  CoverageBadge: () => <div data-testid="coverage-badge" />,
}));
const mockRequestExplainForSelection = vi.fn(() => false);
vi.mock('./explainRequestBus', () => ({
  requestExplainForSelection: (...args: unknown[]) => mockRequestExplainForSelection(...args),
}));
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>();
  return {
    ...actual,
    speakerLabel: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
    speakerColor: () => 'red',
    nodeIdToTab: () => ({ tab: 'beliefs', colorVar: 'var(--color-acc)' }),
    focusMainWindowNode: vi.fn(),
    countOccurrences: () => 0,
  };
});

// ── Test fixture ──────────────────────────────────────────────

function makeDebate(overrides: Partial<any> = {}): any {
  return {
    id: 'test-debate-1',
    title: 'Test Debate',
    topic: { original: 'AI regulation', final: 'Should AI be regulated?', refined: null },
    phase: 'debate',
    transcript: [],
    active_povers: ['accelerationist', 'safetyist', 'skeptic'],
    audience: 'policymaker',
    debate_model: 'gemini-2.5-flash',
    created_at: '2026-06-15T12:00:00Z',
    updated_at: '2026-06-15T12:30:00Z',
    context_summaries: [],
    source_type: 'topic',
    adaptive_staging: null,
    argument_network: null,
    document_analysis: null,
    neutral_evaluations: null,
    ...overrides,
  };
}

afterEach(() => { vi.clearAllMocks(); });

// ── Loading and empty states ──────────────────────────────────

describe('loading and empty states', () => {
  it('renders loading text when debateLoading is true', () => {
    mockStore.debateLoading = true;
    mockStore.activeDebate = null;
    render(<DebateWorkspace />);
    expect(screen.getByText('Loading debate...')).toBeInTheDocument();
  });

  it('does not render the workspace toolbar while loading', () => {
    mockStore.debateLoading = true;
    mockStore.activeDebate = null;
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-toolbar')).toBeNull();
  });

  it('renders no-debate message when activeDebate is null and not loading', () => {
    mockStore.debateLoading = false;
    mockStore.activeDebate = null;
    render(<DebateWorkspace />);
    expect(screen.getByText('No debate selected')).toBeInTheDocument();
  });

  it('does not render the workspace toolbar when no debate is selected', () => {
    mockStore.debateLoading = false;
    mockStore.activeDebate = null;
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-toolbar')).toBeNull();
  });
});

// ── Toolbar ───────────────────────────────────────────────────

describe('toolbar', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.diagnosticsEnabled = false;
    mockStore.activeDebate = makeDebate();
  });

  it('renders Diagnostics button', () => {
    render(<DebateWorkspace />);
    expect(screen.getByText('Diagnostics')).toBeInTheDocument();
  });

  it('shows diagnostics ON label when diagnosticsEnabled is true', () => {
    mockStore.diagnosticsEnabled = true;
    render(<DebateWorkspace />);
    expect(screen.getByText('Diagnostics ON')).toBeInTheDocument();
  });

  it('renders Comments button', () => {
    render(<DebateWorkspace />);
    expect(screen.getByText('Comments (0)')).toBeInTheDocument();
  });

  it('renders two-mode control with Text/Analysis mode group and text sub-options', () => {
    render(<DebateWorkspace />);
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Analysis')).toBeInTheDocument();
    expect(screen.getByText('Brief')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('Detailed')).toBeInTheDocument();
  });

  it('renders 2 mode segments + a value dropdown with the text-tier options (t/2274 §13)', () => {
    const { container } = render(<DebateWorkspace />);
    // Mode toggle = 2 neutral segments; value selector is now a <select>, not pills.
    expect(container.querySelectorAll('.debate-mode-seg').length).toBe(2);
    const select = container.querySelector('select.debate-value-dropdown') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(opts).toEqual(['Brief', 'Medium', 'Detailed']);
  });

  it('marks Text mode active and reflects the current value in the dropdown (t/2274 §13)', () => {
    mockStore.responseLength = 'brief';
    const { container } = render(<DebateWorkspace />);
    // Only the mode toggle carries an active segment now (no accent-filled value pill).
    const activeSegs = container.querySelectorAll('.debate-mode-seg-active');
    expect(activeSegs.length).toBe(1);
    expect(activeSegs[0].textContent).toBe('Text');
    const select = container.querySelector('select.debate-value-dropdown') as HTMLSelectElement;
    expect(select.value).toBe('brief');
  });

  it('does not render Export button when onExport prop is not provided', () => {
    render(<DebateWorkspace />);
    expect(screen.queryByTitle('Export debate')).toBeNull();
  });

  it('shows exportStatus text when exportStatus prop is provided', () => {
    render(<DebateWorkspace exportStatus="Exporting..." />);
    expect(screen.getByText('Exporting...')).toBeInTheDocument();
  });
});

// ── Evaluation panel scroll-trap fix (t/3843) ─────────────────
// The eval/param-history panels must render INSIDE .debate-scroll-content, not
// as siblings after it — that's the actual defect (flex scroll-trap), so a test
// that only checks "renders somewhere" would pass even if a future refactor
// moved them back out.

describe('evaluation + parameter-history panels (t/3843)', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.activeDebate = makeDebate({ phase: 'debate', neutral_evaluations: [{ checkpoint: 'final' }] });
  });

  it('renders the evaluation panel inside .debate-scroll-content once toggled on via the Evaluation action', () => {
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('[data-testid="eval-panel"]')).toBeNull();

    fireEvent.click(screen.getByText('Evaluation'));

    const scrollContent = container.querySelector('.debate-scroll-content') as HTMLElement;
    expect(within(scrollContent).getByTestId('eval-panel')).toBeInTheDocument();
    // Not merely present in the document — specifically a descendant of the scroll column,
    // which is the structural fix this ticket exists to verify.
    expect(container.querySelector(':scope > [data-testid="eval-panel"]')).toBeNull();
  });

  it('renders the parameter-history panel inside .debate-scroll-content once toggled on', () => {
    const { container } = render(<DebateWorkspace />);

    fireEvent.click(screen.getByText('Calibration'));

    const scrollContent = container.querySelector('.debate-scroll-content') as HTMLElement;
    expect(within(scrollContent).getByTestId('param-history')).toBeInTheDocument();
  });
});

// ── Phase routing ─────────────────────────────────────────────

describe('phase routing', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.debateGenerating = null;
    // t/2867: the header TheoryLink now gates on viewMode; advanced view renders it.
    usePreferencesStore.setState({ viewMode: 'advanced' });
  });

  it('shows "Topic Refinement" phase title for clarification phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'clarification' });
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-hdr-phase')?.textContent).toBe('Topic Refinement');
  });

  it('shows "Opening Statements" phase title for opening phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'opening' });
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-hdr-phase')?.textContent).toBe('Opening Statements');
  });

  it('shows "Debate" phase title for debate phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'debate' });
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-hdr-phase')?.textContent).toBe('Debate');
  });

  it('shows "Debate Closed" phase title for closed phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'closed' });
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-hdr-phase')?.textContent).toBe('Debate Closed');
  });

  it('shows "Setting up..." phase title for setup phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'setup' });
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-hdr-phase')?.textContent).toBe('Setting up...');
  });

  it('renders the debate-system-overview TheoryLink in the header (t/2347 mount e)', () => {
    mockStore.activeDebate = makeDebate();
    render(<DebateWorkspace />);
    expect(screen.getByLabelText('Help: debate system overview')).toBeInTheDocument();
  });

  it('renders ClarificationActions in clarification phase when no substantive transcript entries', () => {
    mockStore.activeDebate = makeDebate({ phase: 'clarification', transcript: [] });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('clarification-actions')).toBeInTheDocument();
  });

  it('does not render ClarificationActions when transcript already has opening entries', () => {
    mockStore.activeDebate = makeDebate({
      phase: 'clarification',
      transcript: [{ id: 'e1', type: 'opening', content: 'Hello', speaker: 'accelerationist' }],
    });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('clarification-actions')).toBeNull();
  });

  it('renders OpeningActions in opening phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'opening' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('opening-actions')).toBeInTheDocument();
  });

  it('renders DebateActions in debate phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'debate' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('debate-actions')).toBeInTheDocument();
  });

  it('renders DebateActions in closed phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'closed' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('debate-actions')).toBeInTheDocument();
  });

  it('renders DebaterToggles in debate phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'debate' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('debater-toggles')).toBeInTheDocument();
  });

  it('renders DebaterToggles in opening phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'opening' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('debater-toggles')).toBeInTheDocument();
  });

  it('does not render DebaterToggles in clarification phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'clarification' });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('debater-toggles')).toBeNull();
  });

  it('does not render ClarificationActions or OpeningActions in debate phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'debate' });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('clarification-actions')).toBeNull();
    expect(screen.queryByTestId('opening-actions')).toBeNull();
  });

  it('renders SessionPhaseStepper during debate phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'debate' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('session-stepper')).toBeInTheDocument();
  });

  it('hides SessionPhaseStepper when debate is closed (t/1027)', () => {
    mockStore.activeDebate = makeDebate({ phase: 'closed' });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('session-stepper')).toBeNull();
  });

  it('hides PhaseProgressBar when debate is closed (t/1027)', () => {
    mockStore.activeDebate = makeDebate({
      phase: 'closed',
      adaptive_staging: { enabled: true, current_phase: 'concluding', phase_progress: 1, rounds_in_phase: 4, approaching_transition: false },
    });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('phase-progress')).toBeNull();
  });

  it('renders PhaseProgressBar during active debate with adaptive staging', () => {
    mockStore.activeDebate = makeDebate({
      phase: 'debate',
      adaptive_staging: { enabled: true, current_phase: 'confrontation', phase_progress: 0.5, rounds_in_phase: 3, approaching_transition: false },
    });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('phase-progress')).toBeInTheDocument();
  });

  describe('DEBATE_CHAT_REDESIGN on — unified phase indicator (t/2238)', () => {
    beforeEach(() => { mockFlags.DEBATE_CHAT_REDESIGN = true; });
    afterEach(() => { delete mockFlags.DEBATE_CHAT_REDESIGN; });

    it('replaces the stacked stepper + progress bar with a single unified indicator', () => {
      mockStore.activeDebate = makeDebate({
        phase: 'debate',
        adaptive_staging: { enabled: true, current_phase: 'confrontation', phase_progress: 0.5, rounds_in_phase: 3, approaching_transition: false },
      });
      render(<DebateWorkspace />);
      expect(screen.getByTestId('unified-phase-indicator')).toBeInTheDocument();
      expect(screen.queryByTestId('session-stepper')).toBeNull();
      expect(screen.queryByTestId('phase-progress')).toBeNull();
    });

    it('nests adaptive staging into the unified indicator during the debate phase', () => {
      mockStore.activeDebate = makeDebate({
        phase: 'debate',
        adaptive_staging: { enabled: true, current_phase: 'argumentation', phase_progress: 0.6, rounds_in_phase: 2, approaching_transition: true },
      });
      render(<DebateWorkspace />);
      expect(screen.getByTestId('unified-phase-indicator')).toHaveAttribute('data-has-adaptive', 'yes');
    });

    it('omits the adaptive sub-track when staging is disabled', () => {
      mockStore.activeDebate = makeDebate({ phase: 'debate' });
      render(<DebateWorkspace />);
      expect(screen.getByTestId('unified-phase-indicator')).toHaveAttribute('data-has-adaptive', 'no');
    });

    it('hides the unified indicator when the debate is closed (t/1027 parity)', () => {
      mockStore.activeDebate = makeDebate({
        phase: 'closed',
        adaptive_staging: { enabled: true, current_phase: 'concluding', phase_progress: 1, rounds_in_phase: 4, approaching_transition: false },
      });
      render(<DebateWorkspace />);
      expect(screen.queryByTestId('unified-phase-indicator')).toBeNull();
    });
  });

  it('renders ClaimsEditor in edit-claims phase', () => {
    mockStore.activeDebate = makeDebate({ phase: 'edit-claims' });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('claims-editor')).toBeInTheDocument();
  });
});

// ── Transcript rendering ──────────────────────────────────────

describe('transcript rendering', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.debateGenerating = null;
  });

  it('renders StatementCard for statement-type entries', () => {
    mockStore.activeDebate = makeDebate({
      transcript: [
        { id: 'e1', type: 'statement', content: 'Hello world', speaker: 'accelerationist' },
      ],
    });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('statement-e1')).toBeInTheDocument();
  });

  it('renders ProbingCard for probing-type entries', () => {
    mockStore.activeDebate = makeDebate({
      transcript: [
        { id: 'e2', type: 'probing', content: 'Probing question', speaker: 'moderator' },
      ],
    });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('probing-e2')).toBeInTheDocument();
  });

  it('renders FactCheckCard for fact-check-type entries', () => {
    mockStore.activeDebate = makeDebate({
      transcript: [
        { id: 'e3', type: 'fact-check', content: 'Fact check result', speaker: 'moderator' },
      ],
    });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('factcheck-e3')).toBeInTheDocument();
  });

  it('skips clarification-type entries — renders no card for them', () => {
    mockStore.activeDebate = makeDebate({
      phase: 'debate',
      transcript: [
        { id: 'e4', type: 'clarification', content: 'Clarification content', speaker: 'moderator' },
      ],
    });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('statement-e4')).toBeNull();
    expect(screen.queryByTestId('probing-e4')).toBeNull();
    expect(screen.queryByTestId('factcheck-e4')).toBeNull();
  });

  it('renders multiple mixed entry types', () => {
    mockStore.activeDebate = makeDebate({
      transcript: [
        { id: 'e1', type: 'statement', content: 'Statement', speaker: 'accelerationist' },
        { id: 'e2', type: 'probing', content: 'Probing', speaker: 'moderator' },
        { id: 'e3', type: 'fact-check', content: 'Fact', speaker: 'moderator' },
        { id: 'e4', type: 'clarification', content: 'Clarification', speaker: 'moderator' },
      ],
    });
    render(<DebateWorkspace />);
    expect(screen.getByTestId('statement-e1')).toBeInTheDocument();
    expect(screen.getByTestId('probing-e2')).toBeInTheDocument();
    expect(screen.getByTestId('factcheck-e3')).toBeInTheDocument();
    expect(screen.queryByTestId('statement-e4')).toBeNull();
  });

  it('shows generating indicator with speaker label and "thinking..." when debateGenerating is set', () => {
    mockStore.activeDebate = makeDebate();
    mockStore.debateGenerating = 'accelerationist';
    render(<DebateWorkspace />);
    // Scope to the generating indicator: the header's DEBATERS strip (t/2293) also
    // renders POV names, so an unscoped getByText('Accelerationist') is ambiguous.
    // speakerLabel mock: 'accelerationist' → 'Accelerationist'
    const indicator = screen.getByText('thinking...').closest('.debate-generating') as HTMLElement;
    expect(within(indicator).getByText('Accelerationist')).toBeInTheDocument();
  });

  it('does not show generating indicator when debateGenerating is null', () => {
    mockStore.activeDebate = makeDebate();
    mockStore.debateGenerating = null;
    render(<DebateWorkspace />);
    expect(screen.queryByText('thinking...')).toBeNull();
  });

  it('shows empty transcript message when transcript is empty and not generating', () => {
    mockStore.activeDebate = makeDebate({ transcript: [] });
    mockStore.debateGenerating = null;
    render(<DebateWorkspace />);
    expect(screen.getByText(/The debate is ready to begin/)).toBeInTheDocument();
  });

  it('does not show empty transcript message when generating is set', () => {
    mockStore.activeDebate = makeDebate({ transcript: [] });
    mockStore.debateGenerating = 'safetyist';
    render(<DebateWorkspace />);
    expect(screen.queryByText(/The debate is ready to begin/)).toBeNull();
  });
});

// ── Export ────────────────────────────────────────────────────

describe('export', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.activeDebate = makeDebate();
  });

  it('renders Export button when onExport prop is provided', () => {
    render(<DebateWorkspace onExport={vi.fn()} />);
    expect(screen.getByTitle('Export debate')).toBeInTheDocument();
  });

  it('does not render Export button when onExport is not provided', () => {
    render(<DebateWorkspace />);
    expect(screen.queryByTitle('Export debate')).toBeNull();
  });

  it('shows format menu with all five options on Export click', () => {
    render(<DebateWorkspace onExport={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Export debate'));
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('Plain Text')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('Package (ZIP)')).toBeInTheDocument();
  });

  it('calls onExport with "json" when JSON format is selected', () => {
    const onExport = vi.fn();
    render(<DebateWorkspace onExport={onExport} />);
    fireEvent.click(screen.getByTitle('Export debate'));
    fireEvent.click(screen.getByText('JSON'));
    expect(onExport).toHaveBeenCalledWith('json');
  });

  it('calls onExport with "markdown" when Markdown format is selected', () => {
    const onExport = vi.fn();
    render(<DebateWorkspace onExport={onExport} />);
    fireEvent.click(screen.getByTitle('Export debate'));
    fireEvent.click(screen.getByText('Markdown'));
    expect(onExport).toHaveBeenCalledWith('markdown');
  });

  it('calls onExport with "pdf" when PDF format is selected', () => {
    const onExport = vi.fn();
    render(<DebateWorkspace onExport={onExport} />);
    fireEvent.click(screen.getByTitle('Export debate'));
    fireEvent.click(screen.getByText('PDF'));
    expect(onExport).toHaveBeenCalledWith('pdf');
  });

  it('closes the format menu after a format is selected', () => {
    const onExport = vi.fn();
    const { container } = render(<DebateWorkspace onExport={onExport} />);
    fireEvent.click(screen.getByTitle('Export debate'));
    expect(container.querySelector('.export-format-menu')).toBeTruthy();
    fireEvent.click(screen.getByText('Markdown'));
    expect(container.querySelector('.export-format-menu')).toBeNull();
  });
});

// ── Find bar ──────────────────────────────────────────────────

describe('find bar', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.activeDebate = makeDebate();
  });

  it('does not show find bar on initial render', () => {
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-find-bar')).toBeNull();
  });

  it('opens find bar on Ctrl+F', () => {
    const { container } = render(<DebateWorkspace />);
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    expect(container.querySelector('.debate-find-bar')).toBeTruthy();
  });

  it('opens find bar on Meta+F (macOS)', () => {
    const { container } = render(<DebateWorkspace />);
    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    expect(container.querySelector('.debate-find-bar')).toBeTruthy();
  });

  it('does not open find bar on plain F key', () => {
    const { container } = render(<DebateWorkspace />);
    fireEvent.keyDown(document, { key: 'f' });
    expect(container.querySelector('.debate-find-bar')).toBeNull();
  });

  it('closes find bar on Escape key pressed inside the input', () => {
    const { container } = render(<DebateWorkspace />);
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const input = container.querySelector('.debate-find-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('.debate-find-bar')).toBeNull();
  });

  it('closes find bar by clicking the close button', () => {
    const { container } = render(<DebateWorkspace />);
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const closeBtn = container.querySelector('.debate-find-close') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(container.querySelector('.debate-find-bar')).toBeNull();
  });

  it('renders find input with placeholder text', () => {
    render(<DebateWorkspace />);
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const input = screen.getByPlaceholderText('Find in debate…');
    expect(input).toBeInTheDocument();
  });
});

// ── Selection context menu (t/3382 — touch long-press support) ─

describe('selection context menu', () => {
  const realGetSelection = window.getSelection;

  function mockSelection(text: string) {
    window.getSelection = vi.fn(() => ({
      toString: () => text,
      anchorNode: null,
      rangeCount: 0,
    })) as unknown as typeof window.getSelection;
  }

  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.activeDebate = makeDebate();
  });

  afterEach(() => {
    window.getSelection = realGetSelection;
    vi.useRealTimers();
  });

  it('shows the menu on desktop right-click when text is selected', () => {
    mockSelection('hello world');
    const { container } = render(<DebateWorkspace />);
    fireEvent.contextMenu(container.querySelector('.debate-scroll-content')!);
    expect(container.querySelector('.debate-context-menu')).toBeTruthy();
  });

  it('does not show the menu on right-click without a selection', () => {
    mockSelection('');
    const { container } = render(<DebateWorkspace />);
    fireEvent.contextMenu(container.querySelector('.debate-scroll-content')!);
    expect(container.querySelector('.debate-context-menu')).toBeNull();
  });

  it('shows the menu after touchend when a selection survives the release (t/3382)', () => {
    vi.useFakeTimers();
    mockSelection('selected phrase');
    const { container } = render(<DebateWorkspace />);
    fireEvent.touchEnd(container.querySelector('.debate-scroll-content')!, {
      changedTouches: [{ clientX: 50, clientY: 80 }],
    });
    act(() => { vi.advanceTimersByTime(60); });
    expect(container.querySelector('.debate-context-menu')).toBeTruthy();
  });

  it('does not show the menu after touchend with no selection (native scroll/tap)', () => {
    vi.useFakeTimers();
    mockSelection('');
    const { container } = render(<DebateWorkspace />);
    fireEvent.touchEnd(container.querySelector('.debate-scroll-content')!, {
      changedTouches: [{ clientX: 50, clientY: 80 }],
    });
    act(() => { vi.advanceTimersByTime(60); });
    expect(container.querySelector('.debate-context-menu')).toBeNull();
  });

  // t/4514: right-click "Explain…" routes through the same inline in-app panel the card's
  // "Explain" button uses, via explainRequestBus — not clipboard+browser directly.
  describe('"Explain…"', () => {
    afterEach(() => { mockRequestExplainForSelection.mockClear(); (api.clipboardWriteText as any).mockClear(); (api.openExternal as any).mockClear(); });

    it('when an inline panel is registered for the entry, routes through the bus and does not fall back to Gemini', () => {
      mockRequestExplainForSelection.mockReturnValue(true);
      mockSelection('hello world');
      const { container } = render(<DebateWorkspace />);
      fireEvent.contextMenu(container.querySelector('.debate-scroll-content')!);
      fireEvent.click(screen.getByText('Explain…'));

      expect(mockRequestExplainForSelection).toHaveBeenCalledWith('', 'hello world');
      expect(api.clipboardWriteText).not.toHaveBeenCalled();
      expect(api.openExternal).not.toHaveBeenCalled();
      expect(container.querySelector('.debate-context-menu')).toBeNull(); // menu closes either way
    });

    it('falls back to the Gemini escape hatch when no inline panel is registered for the entry', async () => {
      mockRequestExplainForSelection.mockReturnValue(false);
      mockSelection('hello world');
      const { container } = render(<DebateWorkspace />);
      fireEvent.contextMenu(container.querySelector('.debate-scroll-content')!);
      fireEvent.click(screen.getByText('Explain…'));

      expect(mockRequestExplainForSelection).toHaveBeenCalledWith('', 'hello world');
      expect(api.clipboardWriteText).toHaveBeenCalledWith('EXPLAIN: hello world');
      // t/4645: routed through copyPromptForGemini — opens only after the copy resolves.
      await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('https://gemini.google.com/app'));
    });

    it('does not open Gemini when the clipboard write fails in the fallback path', async () => {
      mockRequestExplainForSelection.mockReturnValue(false);
      (api.clipboardWriteText as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
      mockSelection('hello world');
      const { container } = render(<DebateWorkspace />);
      fireEvent.contextMenu(container.querySelector('.debate-scroll-content')!);
      fireEvent.click(screen.getByText('Explain…'));

      expect(api.clipboardWriteText).toHaveBeenCalledWith('EXPLAIN: hello world');
      await waitFor(() => expect(api.clipboardWriteText).toHaveBeenCalledTimes(1));
      expect(api.openExternal).not.toHaveBeenCalled();
    });
  });
});

// ── Remote driver overlay (t/1077) ──────────────────────────

describe('remote driver overlay', () => {
  beforeEach(() => {
    mockStore.debateLoading = false;
    mockStore.debateGenerating = null;
    mockStore.driverIsRemote = false;
    mockStore.activeDebate = makeDebate({ phase: 'debate' });
  });

  it('does not show remote overlay when driverIsRemote is false', () => {
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-remote-overlay')).toBeNull();
  });

  it('shows remote overlay when driverIsRemote is true', () => {
    mockStore.driverIsRemote = true;
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-remote-overlay')).toBeTruthy();
    expect(screen.getByText(/Debate running in popout window/)).toBeInTheDocument();
  });

  it('hides DebateActions when driverIsRemote is true', () => {
    mockStore.driverIsRemote = true;
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('debate-actions')).toBeNull();
  });

  it('hides ClarificationActions when driverIsRemote is true during clarification phase', () => {
    mockStore.driverIsRemote = true;
    mockStore.activeDebate = makeDebate({ phase: 'clarification', transcript: [] });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('clarification-actions')).toBeNull();
  });

  it('hides OpeningActions when driverIsRemote is true during opening phase', () => {
    mockStore.driverIsRemote = true;
    mockStore.activeDebate = makeDebate({ phase: 'opening' });
    render(<DebateWorkspace />);
    expect(screen.queryByTestId('opening-actions')).toBeNull();
  });

  it('shows DebateActions again when driverIsRemote becomes false', () => {
    mockStore.driverIsRemote = false;
    render(<DebateWorkspace />);
    expect(screen.getByTestId('debate-actions')).toBeInTheDocument();
    expect(screen.queryByText(/Debate running in popout window/)).toBeNull();
  });

  it('markAsPopout resets driverIsRemote to false (t/1274)', () => {
    mockStore.driverIsRemote = true;
    mockMarkAsPopout();
    expect(mockStore.driverIsRemote).toBe(false);
  });

  it('does not show remote overlay after markAsPopout even if driverIsRemote was set (t/1274)', () => {
    mockStore.driverIsRemote = true;
    mockMarkAsPopout();
    const { container } = render(<DebateWorkspace />);
    expect(container.querySelector('.debate-remote-overlay')).toBeNull();
    expect(screen.getByTestId('debate-actions')).toBeInTheDocument();
  });
});
