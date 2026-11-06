// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect, type RefObject } from 'react';
import { useDebateStore } from '../../hooks/useDebateStore';
import type { RunLease } from '../../hooks/useDebateStore/shared/debateRunLease';
import { useShallow } from 'zustand/react/shallow';
import { POVER_INFO, DEBATE_AUDIENCES } from '../../types/debate';
import type { SpeakerId, DebateAudience } from '../../types/debate';
import { AI_POVERS } from '@lib/debate/types';
import { getCurrentPhase } from '@lib/debate/phaseTransitions';
import { speakerLabel } from './utils';
import type { AdaptivePhase } from './utils';
import { ADAPTIVE_PHASES, ADAPTIVE_PHASE_LABELS, ADAPTIVE_PHASE_COLORS } from './utils';
import { HarvestDialog } from '../shared/HarvestDialog';
import { ReflectionsPanel } from '../shared/ReflectionsPanel';
import { NewsReportModal } from '../shared/NewsReportModal';
import { useTierInfo } from '../../hooks/useTierInfo';
import { isElectronMode } from '@bridge';
import { useFlag } from '../../hooks/useFeatureFlags';
import { triggerManualDump } from '../../lib/flightRecorderInit';
import { bandColor, BUDGET_BANDS } from '../../lib/bandColor';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';
import './DebateActionBar.css';

export function ProgressIndicator() {
  const { debateActivity, debateProgress } = useDebateStore(
    useShallow(s => ({ debateActivity: s.debateActivity, debateProgress: s.debateProgress }))
  );
  const [countdown, setCountdown] = useState(0);

  // Reset countdown whenever a new retry with a fresh backoff window starts.
  useEffect(() => {
    setCountdown(debateProgress?.backoffSeconds ?? 0);
  }, [debateProgress?.attempt, debateProgress?.backoffSeconds]);

  // Tick while backing off; clear interval automatically when countdown hits 0.
  const isBackingOff = countdown > 0;
  useEffect(() => {
    if (!isBackingOff) return;
    const id = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [isBackingOff]);

  if (!debateActivity) return null;

  const showRetry = debateProgress && (debateProgress.attempt > 1 || debateProgress.phase === 'retry');

  return (
    <div className="debate-progress-indicator">
      <span className="debate-progress-activity">{debateActivity}</span>
      {showRetry && (
        <span className="debate-progress-retry">
          Retry {debateProgress.attempt}/{debateProgress.maxRetries}
          {debateProgress.backoffSeconds
            ? (countdown > 0 ? ` (waiting ${countdown}s)` : ' (retrying now…)')
            : ''}
        </span>
      )}
      {debateProgress?.limitMessage && (
        <span className="debate-progress-limit">{debateProgress.limitMessage}</span>
      )}
    </div>
  );
}

function formatResetTime(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return 'resets soon';
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

export function TokenBudgetIndicator() {
  const { usage } = useTierInfo();
  if (!usage) return null;
  const { tokensToday, resetsAt } = usage.usage;
  const { tokensPerDay } = usage.limits;
  if (!tokensPerDay || tokensPerDay <= 0) return null;
  const pct = tokensToday / tokensPerDay;
  if (pct < 0.01) return null;
  const remaining = Math.max(0, tokensPerDay - tokensToday);
  const remainingK = remaining >= 1000 ? `${Math.round(remaining / 1000)}k` : String(remaining);
  const level = bandColor(pct, BUDGET_BANDS);
  const isUrgent = level === 'urgent';
  const isWarning = level === 'warning';
  const resetLabel = resetsAt ? formatResetTime(resetsAt) : '';
  const levelClass = level ? ` ${level}` : '';
  return (
    <div className={`token-budget-indicator${levelClass}`}>
      {isUrgent ? (
        <span className="token-budget-banner">Almost out of today&#39;s AI budget — this debate may be interrupted. {resetLabel && <span className="token-budget-reset">({resetLabel})</span>}</span>
      ) : isWarning ? (
        <span className="token-budget-banner">You&#39;ve used {Math.round(pct * 100)}% of today&#39;s AI budget. {resetLabel && <span className="token-budget-reset">({resetLabel})</span>}</span>
      ) : null}
      <div className="token-budget-bar"
        title={`${tokensToday.toLocaleString()} / ${tokensPerDay.toLocaleString()} tokens used today${resetLabel ? ` — ${resetLabel}` : ''}`}>
        <div className="token-budget-fill" style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </div>
      <span className="token-budget-label">{remainingK} left</span>
    </div>
  );
}

export function PhaseProgressBar({ currentPhase, phaseProgress, roundsInPhase, approachingTransition, rationale }: {
  currentPhase: AdaptivePhase;
  phaseProgress: number;
  roundsInPhase: number;
  approachingTransition: boolean;
  rationale?: string;
}) {
  const currentIdx = ADAPTIVE_PHASES.indexOf(currentPhase);

  return (
    <div className="adaptive-phase-bar" title={rationale || `${ADAPTIVE_PHASE_LABELS[currentPhase]} phase, round ${roundsInPhase}`}>
      <div className="adaptive-phase-segments">
        {ADAPTIVE_PHASES.map((phase, idx) => {
          const isActive = idx === currentIdx;
          const isCompleted = idx < currentIdx;
          const color = ADAPTIVE_PHASE_COLORS[phase];
          const fillPct = isCompleted ? 100 : isActive ? Math.min(100, phaseProgress * 100) : 0;

          return (
            <div
              key={phase}
              className={`adaptive-phase-segment${isActive ? ' active' : ''}${isCompleted ? ' completed' : ''}`}
              title={`${ADAPTIVE_PHASE_LABELS[phase]}${isActive ? ` — ${Math.round(phaseProgress * 100)}% (round ${roundsInPhase})` : ''}`}
            >
              <div
                className="adaptive-phase-fill"
                style={{ width: `${fillPct}%`, background: color }}
              />
              <span className="adaptive-phase-label">
                {ADAPTIVE_PHASE_LABELS[phase]}
              </span>
            </div>
          );
        })}
      </div>
      {approachingTransition && (
        <span className="adaptive-phase-transition-hint">
          Approaching transition
        </span>
      )}
      {rationale && (
        <span className="adaptive-phase-rationale" title={rationale}>
          {rationale.length > 80 ? rationale.slice(0, 77) + '...' : rationale}
        </span>
      )}
    </div>
  );
}

const SESSION_STEPS = [
  { key: 'clarification', label: 'Refine' },
  { key: 'opening', label: 'Opening' },
  { key: 'debate', label: 'Debate' },
  { key: 'closed', label: 'Complete' },
] as const;

export function SessionPhaseStepper({ phase, roundCount }: { phase: string; roundCount: number }) {
  const stepIdx = SESSION_STEPS.findIndex(s => s.key === phase);
  const activeIdx = stepIdx >= 0 ? stepIdx : (phase === 'setup' || phase === 'edit-claims' ? 0 : -1);

  return (
    <div className="session-stepper">
      {SESSION_STEPS.map((step, idx) => {
        const completed = idx < activeIdx || phase === 'closed';
        const active = idx === activeIdx && phase !== 'closed';
        return (
          <div key={step.key} className={`session-step${completed ? ' completed' : ''}${active ? ' active' : ''}`}>
            <div className="session-step-dot">{completed ? '✓' : idx + 1}</div>
            <span className="session-step-label">
              {step.label}
              {active && step.key === 'debate' && roundCount > 0 ? ` (${roundCount})` : ''}
            </span>
            {idx < SESSION_STEPS.length - 1 && <div className={`session-step-line${completed ? ' completed' : ''}`} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Adaptive sub-phase track, nested under the "Debate" session step in the
 * unified indicator (t/2238). Same data as {@link PhaseProgressBar} but rendered
 * as a compact secondary row so both dimensions read as one widget.
 */
function UnifiedAdaptiveSubTrack({ currentPhase, phaseProgress, roundsInPhase, approachingTransition, rationale }: {
  currentPhase: AdaptivePhase;
  phaseProgress: number;
  roundsInPhase: number;
  approachingTransition: boolean;
  rationale?: string;
}) {
  const currentIdx = ADAPTIVE_PHASES.indexOf(currentPhase);

  return (
    <div className="unified-phase-subtrack" title={rationale || `${ADAPTIVE_PHASE_LABELS[currentPhase]} stage, round ${roundsInPhase}`}>
      <span className="unified-phase-subcaption">Stage</span>
      <div className="unified-phase-subsegments">
        {ADAPTIVE_PHASES.map((phase, idx) => {
          const isActive = idx === currentIdx;
          const isCompleted = idx < currentIdx;
          const fillPct = isCompleted ? 100 : isActive ? Math.min(100, phaseProgress * 100) : 0;

          return (
            <div
              key={phase}
              className={`unified-phase-subseg${isActive ? ' active' : ''}${isCompleted ? ' completed' : ''}`}
              title={`${ADAPTIVE_PHASE_LABELS[phase]}${isActive ? ` — ${Math.round(phaseProgress * 100)}% (round ${roundsInPhase})` : ''}`}
            >
              <div className="unified-phase-subfill" style={{ width: `${fillPct}%`, background: ADAPTIVE_PHASE_COLORS[phase] }} />
              <span className="unified-phase-sublabel">{ADAPTIVE_PHASE_LABELS[phase]}</span>
            </div>
          );
        })}
      </div>
      {approachingTransition && (
        <span className="unified-phase-subhint">Approaching transition</span>
      )}
      {rationale && (
        <span className="unified-phase-subrationale" title={rationale}>
          {rationale.length > 80 ? rationale.slice(0, 77) + '...' : rationale}
        </span>
      )}
    </div>
  );
}

/**
 * Single coordinated phase indicator (t/2238, DEBATE_CHAT_REDESIGN). Reconciles
 * the two previously-stacked scales — session phase (Refine → Opening → Debate →
 * Complete) and adaptive sub-phase (Confrontation → Argumentation → Concluding) —
 * by nesting the adaptive stages *inside* the active "Debate" step, so a
 * researcher reads one widget instead of two unrelated progress bars. The
 * flag-off path still renders {@link SessionPhaseStepper} + {@link PhaseProgressBar}.
 */
export function UnifiedPhaseIndicator({ phase, roundCount, adaptive }: {
  phase: string;
  roundCount: number;
  adaptive?: {
    currentPhase: AdaptivePhase;
    phaseProgress: number;
    roundsInPhase: number;
    approachingTransition: boolean;
    rationale?: string;
  };
}) {
  const stepIdx = SESSION_STEPS.findIndex(s => s.key === phase);
  const activeIdx = stepIdx >= 0 ? stepIdx : (phase === 'setup' || phase === 'edit-claims' ? 0 : -1);
  const showSubTrack = !!adaptive && phase === 'debate';

  return (
    <div className="unified-phase-indicator">
      <div className="unified-phase-steps">
        {SESSION_STEPS.map((step, idx) => {
          const completed = idx < activeIdx || phase === 'closed';
          const active = idx === activeIdx && phase !== 'closed';
          const hasSubTrack = active && step.key === 'debate' && showSubTrack;
          return (
            <div
              key={step.key}
              className={`unified-phase-step${completed ? ' completed' : ''}${active ? ' active' : ''}${hasSubTrack ? ' has-subtrack' : ''}`}
            >
              <div className="unified-phase-dot">{completed ? '✓' : idx + 1}</div>
              <span className="unified-phase-label">
                {step.label}
                {active && step.key === 'debate' && roundCount > 0 ? ` (${roundCount})` : ''}
              </span>
              {idx < SESSION_STEPS.length - 1 && <div className={`unified-phase-line${completed ? ' completed' : ''}`} />}
            </div>
          );
        })}
      </div>
      {showSubTrack && adaptive && <UnifiedAdaptiveSubTrack {...adaptive} />}
    </div>
  );
}

export function DebaterToggles() {
  const { activeDebate, togglePover, debateGenerating, communityReadOnly } = useDebateStore(
    useShallow(s => ({ activeDebate: s.activeDebate, togglePover: s.togglePover, debateGenerating: s.debateGenerating, communityReadOnly: s.communityReadOnly }))
  );
  // t/4905: choosing who debates the next rounds is a continue control; not for someone else's debate.
  if (!activeDebate || communityReadOnly) return null;

  const allPovers = AI_POVERS;
  const isActive = (p: SpeakerId) => activeDebate.active_povers.includes(p);
  const disabled = !!debateGenerating;

  return (
    <div className="debate-debater-toggles">
      <span className="debate-debater-toggles-label">Debaters:</span>
      {allPovers.map(p => {
        const info = POVER_INFO[p];
        const active = isActive(p);
        const turnCount = activeDebate.transcript.filter(e => e.speaker === p && (e.type === 'statement' || e.type === 'opening')).length;
        return (
          <button
            key={p}
            className={`debate-debater-pill ${active ? 'debate-debater-pill-active' : 'debate-debater-pill-inactive'}`}
            style={active ? { borderColor: info.color, color: info.color } : undefined}
            onClick={() => togglePover(p)}
            disabled={disabled}
            aria-pressed={active}
            title={active
              ? `Remove ${info.label} from the next rounds. Their turns so far stay in the transcript.`
              : `Add ${info.label} back to the next rounds.`}
          >
            {info.label}{turnCount > 0 ? ` (${turnCount})` : ''}
            {!active && <span className="debate-debater-pill-status"> · sitting out</span>}
          </button>
        );
      })}
    </div>
  );
}

const AI_MENTION_OPTIONS: { id: string; label: string; color: string }[] = [
  { id: 'accelerationist', label: POVER_INFO.accelerationist.label, color: POVER_INFO.accelerationist.color },
  { id: 'safetyist', label: POVER_INFO.safetyist.label, color: POVER_INFO.safetyist.color },
  { id: 'skeptic', label: POVER_INFO.skeptic.label, color: POVER_INFO.skeptic.color },
];

function isPhaseTerminated(d: any): boolean {
  return d?.adaptive_staging?.phase_state?.current_phase === 'terminated';
}

function deriveAdaptiveState(activeDebate: any): {
  isAdaptive: boolean;
  isStepMode: boolean;
  currentAdaptivePhase: AdaptivePhase | undefined;
} {
  return {
    isAdaptive: activeDebate?.adaptive_staging?.enabled ?? false,
    isStepMode: activeDebate?.adaptive_staging?.step_mode ?? false,
    currentAdaptivePhase: activeDebate ? (getCurrentPhase(activeDebate) as AdaptivePhase | undefined) : undefined,
  };
}

// Adaptive (non-step) cross-respond: run the debate engine to completion with a
// safety cap, then synthesize once enough statements exist. Runs under the caller's run
// lease (t/3917) and stops as soon as the lease is lost.
async function runAdaptiveCrossRespond(
  activeDebate: any,
  crossRespond: () => Promise<void>,
  requestSynthesis: () => Promise<void>,
  lease: RunLease,
): Promise<void> {
  const alreadyTerminated = isPhaseTerminated(activeDebate) || activeDebate.phase === 'closed';
  if (alreadyTerminated) {
    await crossRespond();
    return;
  }
  const maxSafetyRounds = 50;
  let consecutiveNoStatement = 0;
  for (let i = 0; i < maxSafetyRounds; i++) {
    const d = useDebateStore.getState().activeDebate;
    if (!d || !lease.isValid()) break;
    if (isPhaseTerminated(d)) break;
    const preLen = d.transcript.length;
    await crossRespond();
    const post = useDebateStore.getState().activeDebate;
    if (!post) break;
    const hasStatement = post.transcript.slice(preLen).some((e: any) => e.type === 'statement');
    if (hasStatement) {
      consecutiveNoStatement = 0;
    } else {
      consecutiveNoStatement++;
      if (consecutiveNoStatement >= 3) break;
    }
  }
  const final = useDebateStore.getState().activeDebate;
  const finalStatements = final?.transcript.filter((e: any) => e.type === 'statement').length ?? 0;
  if (finalStatements >= 3) {
    await requestSynthesis();
  }
}

function DebateErrorBanner({
  debateError,
  dailyLimitPaused,
  disableAnalysis,
  onRetry,
  onDismiss,
}: {
  debateError: string;
  dailyLimitPaused: boolean;
  disableAnalysis: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const openSettings = useSettingsDialog(s => s.open);
  return (
    <div className={dailyLimitPaused ? 'debate-daily-limit' : 'debate-error'}>
      <span className={dailyLimitPaused ? 'debate-daily-limit-text' : 'debate-error-text'}>{debateError}</span>
      {dailyLimitPaused ? (
        // "Continue now" path for the daily cap is registering a BYOK key (t/3190).
        <button className="debate-daily-limit-action" onClick={() => openSettings('apiKeys')}>Add API key</button>
      ) : (
        <button className="debate-error-retry" onClick={onRetry} disabled={disableAnalysis}>Retry</button>
      )}
      <button className={dailyLimitPaused ? 'debate-daily-limit-dismiss' : 'debate-error-dismiss'} onClick={onDismiss} title="Dismiss" aria-label="Dismiss">&times;</button>
    </div>
  );
}

function DebateInputBar({
  inputRef,
  input,
  disableAnalysis,
  mentionOpen,
  mentionOptions,
  mentionIndex,
  onInputChange,
  onKeyDown,
  onBlurClose,
  onInsertMention,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  input: string;
  disableAnalysis: boolean;
  mentionOpen: boolean;
  mentionOptions: { id: string; label: string; color: string }[];
  mentionIndex: number;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onBlurClose: () => void;
  onInsertMention: (label: string) => void;
}) {
  // Send moved to the composer controls row (t/2283); this is input + @mention only.
  return (
    <div className="debate-input-wrapper">
      <input
        ref={inputRef}
        className="debate-input"
        type="text"
        placeholder="Ask the debater… (@Safetyist to target)"
        value={input}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
        onBlur={onBlurClose}
        disabled={disableAnalysis}
      />
      {mentionOpen && mentionOptions.length > 0 && (
        <div className="debate-mention-dropdown">
          {mentionOptions.map((opt, i) => (
            <div
              key={opt.id}
              className={`debate-mention-item${i === mentionIndex ? ' selected' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onInsertMention(opt.label); }}
            >
              <span style={{ color: opt.color, fontWeight: 600 }}>{opt.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type MenuEntry =
  | { kind: 'divider'; key: string }
  | { kind: 'item'; key: string; label: string; onSelect: () => void; disabled?: boolean; checked?: boolean; title?: string };

/** Shared open-on-keyboard handler for a menu trigger button (Down / Enter / Space). */
function menuTriggerKeys(setOpen: (v: boolean) => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };
}

/**
 * Custom popup menu (t/2283) — shared by the Tools menu and the Continue split
 * button. Actions carry per-item disabled/toggle/divider state, so a native
 * <select> won't do. a11y: role="menu"; arrow-nav skips disabled items; Enter/Space
 * activate; Esc closes and returns focus to the trigger; click-outside closes.
 */
function ActionMenu({ items, onClose, triggerRef, className }: {
  items: MenuEntry[];
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  className?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabledIdx = items
    .map((it, i) => (it.kind === 'item' && !it.disabled ? i : -1))
    .filter(i => i >= 0);

  // Focus the first enabled item when the menu opens (mount === open). Intentionally
  // runs once on mount — enabledIdx is derived fresh each render but we only want the
  // initial focus, not a re-focus on every keystroke.
  const firstEnabled = enabledIdx[0];
  useEffect(() => {
    if (firstEnabled != null) itemRefs.current[firstEnabled]?.focus();
  }, [firstEnabled]);

  // Click-outside closes (ignoring the trigger, whose own onClick toggles).
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [onClose, triggerRef]);

  const focusAt = (pos: number) => {
    const n = enabledIdx.length;
    if (n === 0) return;
    itemRefs.current[enabledIdx[((pos % n) + n) % n]]?.focus();
  };
  const currentPos = () => enabledIdx.findIndex(i => itemRefs.current[i] === document.activeElement);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); triggerRef.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(currentPos() + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(currentPos() - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(enabledIdx.length - 1); }
    else if (e.key === 'Tab') { onClose(); }
  };

  const activate = (it: Extract<MenuEntry, { kind: 'item' }>) => {
    if (it.disabled) return;
    it.onSelect();
    onClose();
    triggerRef.current?.focus();
  };

  return (
    <div ref={menuRef} className={`debate-tools-menu${className ? ` ${className}` : ''}`} role="menu" onKeyDown={onKeyDown}>
      {items.map((it, i) =>
        it.kind === 'divider' ? (
          <div key={it.key} className="debate-tools-menu-divider" role="separator" />
        ) : (
          <button
            key={it.key}
            ref={el => { itemRefs.current[i] = el; }}
            type="button"
            role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={it.checked !== undefined ? it.checked : undefined}
            aria-disabled={it.disabled || undefined}
            tabIndex={-1}
            className={`debate-tools-menu-item${it.disabled ? ' disabled' : ''}${it.checked ? ' checked' : ''}`}
            title={it.title}
            onClick={() => activate(it)}
          >
            {it.checked !== undefined && (
              <span className="debate-tools-menu-check" aria-hidden="true">{it.checked ? '✓' : ''}</span>
            )}
            <span className="debate-tools-menu-label">{it.label}</span>
          </button>
        )
      )}
    </div>
  );
}

/**
 * Continue split button (t/2283 §5.1) — primary cross-respond/step action plus a
 * caret opening a small menu that keeps the active turns (non-adaptive) or
 * Auto/Step mode (adaptive) visible on the button. Primary color is
 * `var(--focus-ring)` LOCALLY (TL-approved, t/2283 Q3) — NOT the app-wide
 * `.btn-primary` token.
 */
function ContinueButton({
  isAdaptive,
  isStepMode,
  disableAnalysis,
  crossRespondTurns,
  onCrossRespond,
  onToggleStepMode,
  setCrossRespondTurns,
}: {
  isAdaptive: boolean;
  isStepMode: boolean;
  disableAnalysis: boolean;
  crossRespondTurns: number;
  onCrossRespond: () => void | Promise<void>;
  onToggleStepMode: () => void | Promise<void>;
  setCrossRespondTurns: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const caretRef = useRef<HTMLButtonElement>(null);

  const label = isAdaptive ? (isStepMode ? 'Step' : 'Continue') : `Cross-Respond ×${crossRespondTurns}`;
  const primaryTitle = isAdaptive
    ? (isStepMode ? 'Run one debate round' : 'Let the debate engine select the next speaker and run to completion')
    : `Run ${crossRespondTurns} cross-respond round${crossRespondTurns > 1 ? 's' : ''}`;

  const items: MenuEntry[] = isAdaptive
    ? [
        { kind: 'item', key: 'auto', label: 'Auto', title: 'Switch to auto mode (run all stages)', checked: !isStepMode, onSelect: () => { if (isStepMode) void onToggleStepMode(); } },
        { kind: 'item', key: 'step', label: 'Step', title: 'Switch to step mode (1 round at a time, manual phase control)', checked: isStepMode, onSelect: () => { if (!isStepMode) void onToggleStepMode(); } },
      ]
    : [1, 2, 3, 6, 9, 12, 15, 18, 21].map(n => ({
        kind: 'item' as const,
        key: `turns-${n}`,
        label: `${n} round${n > 1 ? 's' : ''}`,
        checked: n === crossRespondTurns,
        onSelect: () => setCrossRespondTurns(n),
      }));

  return (
    <div className="debate-continue-split">
      <button
        type="button"
        className="debate-continue-primary"
        onClick={() => void onCrossRespond()}
        disabled={disableAnalysis}
        title={primaryTitle}
      >
        {label}
      </button>
      <button
        ref={caretRef}
        type="button"
        className="debate-continue-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change continue mode"
        onClick={() => setOpen(o => !o)}
        onKeyDown={menuTriggerKeys(setOpen)}
        disabled={disableAnalysis}
      >
        ▾
      </button>
      {open && (
        <ActionMenu
          items={items}
          onClose={() => setOpen(false)}
          triggerRef={caretRef}
          className="debate-tools-menu-up debate-continue-menu"
        />
      )}
    </div>
  );
}

function StepPhaseSelector({
  currentAdaptivePhase,
  disableAnalysis,
  onSetPhase,
}: {
  currentAdaptivePhase: AdaptivePhase | undefined;
  disableAnalysis: boolean;
  onSetPhase: (phase: AdaptivePhase) => void | Promise<void>;
}) {
  return (
    <div className="debate-step-phase-selector">
      <span className="debate-step-phase-label">Stage:</span>
      {ADAPTIVE_PHASES.map(phase => (
        <button
          key={phase}
          className={`debate-step-phase-pill${currentAdaptivePhase === phase ? ' active' : ''}`}
          style={currentAdaptivePhase === phase ? { borderColor: ADAPTIVE_PHASE_COLORS[phase], color: ADAPTIVE_PHASE_COLORS[phase] } : undefined}
          onClick={() => void onSetPhase(phase)}
          disabled={disableAnalysis || currentAdaptivePhase === phase}
          title={`Set debate stage to ${ADAPTIVE_PHASE_LABELS[phase]}`}
        >
          {ADAPTIVE_PHASE_LABELS[phase]}
        </button>
      ))}
    </div>
  );
}

/**
 * Tools menu (t/2283 §3) — all secondary actions relocated into one `Tools ▾`
 * popup, in mockup order, each preserving its handler / enabled rule / tooltip
 * verbatim (relocation + grouping only, no behavior change). Admin-only items
 * (Harvest, Calibration, Export flight recorder) are hidden when !showAdminControls.
 */
function ToolsMenu({
  disableAnalysis,
  isClosed,
  showAdminControls,
  hasSynthesis,
  hasEvaluations,
  showEvaluation,
  setShowEvaluation,
  showParamHistory,
  setShowParamHistory,
  setShowHarvest,
  setShowReflections,
  setShowNewsReport,
  requestSynthesis,
  requestProbingQuestions,
  requestReflections,
  canRerunInsights,
  onRerunInsights,
}: {
  disableAnalysis: boolean;
  isClosed: boolean;
  showAdminControls: boolean;
  hasSynthesis: boolean;
  hasEvaluations: boolean;
  showEvaluation: boolean;
  setShowEvaluation: (v: boolean) => void;
  showParamHistory: boolean;
  setShowParamHistory: (v: boolean) => void;
  setShowHarvest: (v: boolean) => void;
  setShowReflections: (v: boolean) => void;
  setShowNewsReport: (v: boolean) => void;
  requestSynthesis: () => void | Promise<void>;
  requestProbingQuestions: () => void | Promise<void>;
  requestReflections: () => void | Promise<void>;
  canRerunInsights: boolean;
  onRerunInsights: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const items: MenuEntry[] = [];
  if (showAdminControls) {
    items.push({ kind: 'item', key: 'harvest', label: 'Harvest', title: 'Harvest debate findings into the taxonomy', disabled: disableAnalysis || !hasSynthesis, onSelect: () => setShowHarvest(true) });
  }
  items.push({ kind: 'item', key: 'reflections', label: 'Reflections', title: 'Each debater reflects on the debate and proposes taxonomy edits', disabled: disableAnalysis, onSelect: () => { setShowReflections(true); void requestReflections(); } });
  items.push({ kind: 'item', key: 'news', label: 'News report', title: hasSynthesis ? 'Generate a news-style article from this debate' : 'Synthesis required before generating news report', disabled: disableAnalysis || !hasSynthesis, onSelect: () => setShowNewsReport(true) });
  items.push({ kind: 'item', key: 'evaluation', label: 'Evaluation', title: 'Show/hide independent evaluation of claims and cruxes', disabled: !hasEvaluations, checked: showEvaluation, onSelect: () => setShowEvaluation(!showEvaluation) });
  if (showAdminControls) {
    items.push({ kind: 'item', key: 'calibration', label: 'Calibration', title: 'View calibration parameter history and current values', checked: showParamHistory, onSelect: () => setShowParamHistory(!showParamHistory) });
  }
  items.push({ kind: 'divider', key: 'div-1' });
  items.push({ kind: 'item', key: 'synthesize', label: 'Synthesize', title: hasSynthesis ? 'Synthesis already generated' : 'Generate a synthesis of agreements, disagreements, and open questions', disabled: disableAnalysis || hasSynthesis, onSelect: () => void requestSynthesis() });
  items.push({ kind: 'item', key: 'probe', label: 'Probe', title: 'Get AI-suggested probing questions to deepen the debate', disabled: disableAnalysis || isClosed, onSelect: () => void requestProbingQuestions() });
  // Relocated from the floating inline button below the transcript (t/2308). Shown only
  // under its original eligibility: closed, non-exploration debate with no exploration summary.
  if (canRerunInsights) {
    items.push({ kind: 'item', key: 'rerun-insights', label: 'Rerun with Insights', title: 'Extract insights from this debate and use them to seed a new, better debate', disabled: disableAnalysis, onSelect: () => void onRerunInsights() });
  }
  if (showAdminControls) {
    items.push({ kind: 'divider', key: 'div-2' });
    items.push({ kind: 'item', key: 'dump', label: 'Export flight recorder', title: 'Export flight recorder (Ctrl+Alt+D)', onSelect: () => { void triggerManualDump(); } });
  }

  return (
    <div className="debate-tools">
      <button
        ref={triggerRef}
        type="button"
        className="debate-tools-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={menuTriggerKeys(setOpen)}
      >
        Tools <span className="debate-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ActionMenu items={items} onClose={() => setOpen(false)} triggerRef={triggerRef} className="debate-tools-menu-up" />
      )}
    </div>
  );
}

/** `For [audience ▾]` — static label + the existing audience <select> (t/2283 §4). */
function AudienceSelect({ audience, setAudience, disabled }: {
  audience: DebateAudience;
  setAudience: (a: DebateAudience) => void;
  disabled: boolean;
}) {
  return (
    <span className="debate-audience">
      <span className="debate-audience-label">For</span>
      <select
        className="debate-audience-select"
        aria-label="Audience"
        value={audience}
        onChange={(e) => setAudience(e.target.value as DebateAudience)}
        disabled={disabled}
        title="Target audience for debate responses"
      >
        {DEBATE_AUDIENCES.map(a => (
          <option key={a.id} value={a.id}>{a.label}</option>
        ))}
      </select>
    </span>
  );
}

function DebateModals({
  showHarvest,
  showReflections,
  showNewsReport,
  onCloseHarvest,
  onCloseReflections,
  onCloseNewsReport,
}: {
  showHarvest: boolean;
  showReflections: boolean;
  showNewsReport: boolean;
  onCloseHarvest: () => void;
  onCloseReflections: () => void;
  onCloseNewsReport: () => void;
}) {
  return (
    <>
      {showHarvest && <HarvestDialog onClose={onCloseHarvest} />}
      {showReflections && <ReflectionsPanel onClose={onCloseReflections} />}
      {showNewsReport && <NewsReportModal onClose={onCloseNewsReport} />}
    </>
  );
}

export function DebateActions({ showParamHistory, setShowParamHistory, showEvaluation, setShowEvaluation }: { showParamHistory: boolean; setShowParamHistory: (v: boolean) => void; showEvaluation: boolean; setShowEvaluation: (v: boolean) => void }) {
  const { activeDebate, debateGenerating, debateError, debateRetryAction, dailyLimitPaused, askQuestion, crossRespond, runUnderDebateLease, requestSynthesis, requestProbingQuestions, requestReflections, toggleStepMode, setDebatePhase, setError, audience, setAudience, explorationSummary, extractAndSeedFromDebate } = useDebateStore(
    useShallow(s => ({ activeDebate: s.activeDebate, debateGenerating: s.debateGenerating, debateError: s.debateError, debateRetryAction: s.debateRetryAction, dailyLimitPaused: s.dailyLimitPaused, askQuestion: s.askQuestion, crossRespond: s.crossRespond, runUnderDebateLease: s.runUnderDebateLease, requestSynthesis: s.requestSynthesis, requestProbingQuestions: s.requestProbingQuestions, requestReflections: s.requestReflections, toggleStepMode: s.toggleStepMode, setDebatePhase: s.setDebatePhase, setError: s.setError, audience: s.audience, setAudience: s.setAudience, explorationSummary: s.explorationSummary, extractAndSeedFromDebate: s.extractAndSeedFromDebate }))
  );
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [showHarvest, setShowHarvest] = useState(false);
  const [showReflections, setShowReflections] = useState(false);
  const [showNewsReport, setShowNewsReport] = useState(false);
  const [crossRespondTurns, setCrossRespondTurns] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);
  // useFlag is a React hook — call it unconditionally, above any early return.
  // isElectronMode() is a plain function and can stay in the `||`; only the hook must be unconditional.
  // A conditional hook here crashed the popup with "Rendered fewer hooks than expected" (t/2298).
  const adminFlag = useFlag('permission-admin-features');
  const showAdminControls = isElectronMode() || adminFlag;
  const { isAdaptive, isStepMode, currentAdaptivePhase } = deriveAdaptiveState(activeDebate);

  if (!activeDebate) return null;

  const isGenerating = !!debateGenerating;
  const isClosed = activeDebate.phase === 'closed';
  const disableAnalysis = isGenerating || sending;
  const isSocratic = (activeDebate.active_povers ?? []).filter(p => p !== 'user').length < 2;
  const hasSynthesis = activeDebate.transcript.some(e => e.type === 'concluding');
  const hasEvaluations = !!activeDebate.neutral_evaluations?.length;
  // Same eligibility the removed inline RerunInsightsSlot used (t/2308).
  const canRerunInsights = isClosed && activeDebate.protocol_id !== 'exploration' && !explorationSummary;

  const mentionOptions = AI_MENTION_OPTIONS.filter(o => activeDebate.active_povers.includes(o.id as SpeakerId));

  const insertMention = (label: string) => {
    const atIdx = input.lastIndexOf('@');
    const before = atIdx >= 0 ? input.slice(0, atIdx) : input;
    setInput(`${before}@${label} `);
    setMentionOpen(false);
    setMentionIndex(0);
    inputRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    const atIdx = val.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || val[atIdx - 1] === ' ')) {
      const afterAt = val.slice(atIdx + 1).toLowerCase();
      if (!afterAt.includes(' ')) {
        setMentionOpen(true);
        setMentionIndex(0);
        return;
      }
    }
    setMentionOpen(false);
  };

  const handleSend = async () => {
    if (!input.trim() || disableAnalysis) return;
    const text = input;
    setInput('');
    setMentionOpen(false);
    setSending(true);
    await askQuestion(text);
    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(i => Math.min(i + 1, mentionOptions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionOptions[mentionIndex].label);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleCrossRespond = async () => {
    if (disableAnalysis) return;
    setSending(true);
    try {
      // The whole click is one run under the debate's lease (t/3917): no other loop or
      // window can interleave turns between this batch's rounds. If another run owns the
      // debate, the store refuses with a visible error and logs both callers.
      await runUnderDebateLease('DebateActionBar.crossRespond', async (lease) => {
        const turn = () => crossRespond({ lease, caller: 'DebateActionBar' });
        if (isAdaptive && isStepMode) {
          await turn();
        } else if (isAdaptive) {
          await runAdaptiveCrossRespond(activeDebate, turn, requestSynthesis, lease);
        } else {
          for (let i = 0; i < crossRespondTurns; i++) {
            await turn();
            if (!useDebateStore.getState().activeDebate || !lease.isValid()) break;
          }
        }
      });
    } finally {
      setSending(false);
    }
  };

  const handleRetry = () => {
    const action = debateRetryAction;
    setError(null);
    if (action === 'synthesis') void requestSynthesis();
    else if (action === 'probing') void requestProbingQuestions();
    else if (action === 'reflections') void requestReflections();
    else void handleCrossRespond();
  };

  return (
    <div className="debate-action-bar">
      {debateError && (
        <DebateErrorBanner
          debateError={debateError}
          dailyLimitPaused={dailyLimitPaused}
          disableAnalysis={disableAnalysis}
          onRetry={handleRetry}
          onDismiss={() => setError(null)}
        />
      )}
      <TokenBudgetIndicator />
      {/* Step-phase selector stays a thin row ABOVE the composer in step mode (t/2283 §5.2). */}
      {isStepMode && (
        <StepPhaseSelector
          currentAdaptivePhase={currentAdaptivePhase}
          disableAnalysis={disableAnalysis}
          onSetPhase={setDebatePhase}
        />
      )}
      <div className="debate-composer">
        <DebateInputBar
          inputRef={inputRef}
          input={input}
          disableAnalysis={disableAnalysis}
          mentionOpen={mentionOpen}
          mentionOptions={mentionOptions}
          mentionIndex={mentionIndex}
          onInputChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlurClose={() => setTimeout(() => setMentionOpen(false), 150)}
          onInsertMention={insertMention}
        />
        <div className="debate-composer-controls">
          <div className="debate-composer-left">
            <ToolsMenu
              disableAnalysis={disableAnalysis}
              isClosed={isClosed}
              showAdminControls={showAdminControls}
              hasSynthesis={hasSynthesis}
              hasEvaluations={hasEvaluations}
              showEvaluation={showEvaluation}
              setShowEvaluation={setShowEvaluation}
              showParamHistory={showParamHistory}
              setShowParamHistory={setShowParamHistory}
              setShowHarvest={setShowHarvest}
              setShowReflections={setShowReflections}
              setShowNewsReport={setShowNewsReport}
              requestSynthesis={requestSynthesis}
              requestProbingQuestions={requestProbingQuestions}
              requestReflections={requestReflections}
              canRerunInsights={canRerunInsights}
              onRerunInsights={() => extractAndSeedFromDebate(activeDebate.id)}
            />
            <AudienceSelect audience={audience} setAudience={setAudience} disabled={disableAnalysis || isClosed} />
          </div>
          {!isClosed && (
            <div className="debate-composer-right">
              <button
                type="button"
                className="debate-composer-send"
                onClick={() => void handleSend()}
                disabled={!input.trim() || disableAnalysis}
              >
                Send
              </button>
              {!isSocratic && (
                <ContinueButton
                  isAdaptive={isAdaptive}
                  isStepMode={isStepMode}
                  disableAnalysis={disableAnalysis}
                  crossRespondTurns={crossRespondTurns}
                  onCrossRespond={handleCrossRespond}
                  onToggleStepMode={toggleStepMode}
                  setCrossRespondTurns={setCrossRespondTurns}
                />
              )}
            </div>
          )}
        </div>
      </div>
      {isGenerating && (
        <div className="debate-action-hint">
          {speakerLabel(debateGenerating)} is responding...
        </div>
      )}
      <DebateModals
        showHarvest={showHarvest}
        showReflections={showReflections}
        showNewsReport={showNewsReport}
        onCloseHarvest={() => setShowHarvest(false)}
        onCloseReflections={() => setShowReflections(false)}
        onCloseNewsReport={() => setShowNewsReport(false)}
      />
    </div>
  );
}
