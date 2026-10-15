// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useShallow } from 'zustand/react/shallow';
import type { ReflectionEdit, ReflectionResult } from '../../hooks/useDebateStore';
import type { NewPovItemProposal } from '@lib/debate/types/session';
import { POVER_INFO } from '../../types/debate';
import type { SpeakerId } from '../../types/debate';
import { checkDolceCompliance, type ComplianceViolation } from '../../utils/dolceCompliance';
import { DescriptionToggle, resolveDescription, useDescriptionMode } from './DescriptionToggle';
import { TheoryLink } from './TheoryLink';
import { generatePlainPreview } from '../../utils/regeneratePlainDescription';
import { ProposalTagEditor, povTagOptionsFor } from './ProposalTagEditor';
import { ReflectionTagCheckBanner, tagCheckFlagged } from './ReflectionTagCheck';
import './ReflectionsPanel.css';

const PREFIX_TO_POV: Record<string, 'accelerationist' | 'safetyist' | 'skeptic'> = { acc: 'accelerationist', saf: 'safetyist', skp: 'skeptic' };

/** Scroll the debate transcript to the referenced evidence entry (e.g. "S13" or "Moderator Round 4"). */
function scrollToEvidence(entry: string) {
  // Try direct statement ID first (e.g. "S13")
  const el = document.getElementById(`stmt-${entry}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '2px solid var(--color-acc, #3b82f6)';
    setTimeout(() => { el.style.outline = ''; }, 2000);
    return;
  }
  // Try parsing "Speaker Round N" format → find the Nth statement by that speaker
  const match = entry.match(/^(.+?)\s+Round\s+(\d+)$/i);
  if (match) {
    const speaker = match[1].toLowerCase();
    const round = parseInt(match[2], 10);
    const cards = document.querySelectorAll<HTMLElement>('[data-entry-id]');
    let count = 0;
    for (const card of cards) {
      const speakerEl = card.querySelector('.debate-statement-speaker');
      if (speakerEl && speakerEl.textContent?.toLowerCase().includes(speaker)) {
        count++;
        if (count === round) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.style.outline = '2px solid var(--color-acc, #3b82f6)';
          setTimeout(() => { card.style.outline = ''; }, 2000);
          return;
        }
      }
    }
  }
}

const EDIT_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  revise: { label: 'Revise', color: '#3b82f6' },
  add: { label: 'Add New', color: '#22c55e' },
  qualify: { label: 'Qualify', color: '#f59e0b' },
  deprecate: { label: 'Deprecate', color: '#ef4444' },
};

/** t/3814: compare the generated proposal against the live taxonomy text, ignoring
 *  incidental whitespace differences that aren't a real edit. */
function normalizeForNoOpCompare(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

type DiffSeg = { text: string; type: 'same' | 'added' };
type RawDiffSeg = { text: string; type: 'same' | 'added' | 'removed' };

/** Walk the LCS dp table back-to-front, producing the raw same/added/removed run (in order). */
function backtrackWordDiff(oldTokens: string[], newTokens: string[], dp: number[][]): RawDiffSeg[] {
  const raw: RawDiffSeg[] = [];
  let i = oldTokens.length, j = newTokens.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      raw.push({ text: newTokens[j - 1], type: 'same' });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ text: newTokens[j - 1], type: 'added' });
      j--;
    } else {
      raw.push({ text: oldTokens[i - 1], type: 'removed' });
      i--;
    }
  }
  raw.reverse();
  return raw;
}

/** Drop removed segments and coalesce adjacent same/added runs into display segments. */
function mergeDiffSegments(raw: RawDiffSeg[]): DiffSeg[] {
  const merged: DiffSeg[] = [];
  for (const seg of raw) {
    if (seg.type === 'removed') continue;
    const last = merged.length > 0 ? merged[merged.length - 1] : null;
    if (last && last.type === seg.type) last.text += seg.text;
    else merged.push({ text: seg.text, type: seg.type });
  }
  return merged;
}

function diffWords(oldText: string, newText: string): DiffSeg[] {
  const oldTokens = oldText.split(/(\s+)/);
  const newTokens = newText.split(/(\s+)/);
  const m = oldTokens.length, n = newTokens.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldTokens[i - 1] === newTokens[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return mergeDiffSegments(backtrackWordDiff(oldTokens, newTokens, dp));
}

const CONFIDENCE_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  high: { label: 'High', color: '#22c55e', bg: '#22c55e22' },
  medium: { label: 'Med', color: '#f59e0b', bg: '#f59e0b22' },
  low: { label: 'Low', color: '#ef4444', bg: '#ef444422' },
};

// ── EditCard sub-components (t/1848) ──────────────────────────────
// EditCard was a single 83-complexity component. Its cohesive JSX blocks are
// extracted here as props-only sub-components (bodies moved verbatim; each owns
// its own render guard so EditCard's return is branch-free). See ADR-007 split
// pattern. Types below are derived from the stores so props stay exact.
type PovKey = 'accelerationist' | 'safetyist' | 'skeptic';
type EditTypeInfo = { label: string; color: string };
type AnNode = { id: string; text: string; speaker: string; attribution_text_genus?: string };
type EnrichStatus = { status: string; error?: string } | undefined;
type DebateStoreState = ReturnType<typeof useDebateStore.getState>;
type TaxStoreState = ReturnType<typeof useTaxonomyStore.getState>;
type DescMode = ReturnType<typeof useDescriptionMode>[0];
type SetDescMode = ReturnType<typeof useDescriptionMode>[1];

function EditCardHeader({ edit, typeInfo, trackedEnrichNodeId, navigateToNode }: {
  edit: ReflectionEdit;
  typeInfo: EditTypeInfo;
  trackedEnrichNodeId: string | null;
  navigateToNode: TaxStoreState['navigateToNode'];
}) {
  return (
      <div className="rp-row-header-8-6">
        <span
          className="rp-type-badge"
          /* eslint-disable-next-line local/no-inline-style -- background/color depend on typeInfo.color (per edit_type) */
          style={{ background: `${typeInfo.color}22`, color: typeInfo.color }}
        >
          {typeInfo.label}
        </span>
        <span className="rp-text-sm-muted">
          {edit.category}
        </span>
        {edit.node_id && edit.edit_type !== 'add' && (
          <code className="rp-2xs-muted">{edit.node_id}</code>
        )}
        {edit.confidence && CONFIDENCE_STYLES[edit.confidence] && (
          <span
            className="rp-confidence-badge"
            /* eslint-disable-next-line local/no-inline-style -- background/color/border depend on CONFIDENCE_STYLES[edit.confidence] */
            style={{
              background: CONFIDENCE_STYLES[edit.confidence].bg,
              color: CONFIDENCE_STYLES[edit.confidence].color,
              border: `1px solid ${CONFIDENCE_STYLES[edit.confidence].color}44`,
            }}
          >
            {CONFIDENCE_STYLES[edit.confidence].label}
          </span>
        )}
        {edit.status === 'approved' && (
          <span className="rp-applied-label">
            Applied
            {edit.edit_type === 'add' && trackedEnrichNodeId && (
              <code
                className="rp-node-chip-sm"
                title={`Navigate to ${trackedEnrichNodeId}`}
                onClick={() => {
                  const prefix = trackedEnrichNodeId.split('-')[0];
                  const tab = PREFIX_TO_POV[prefix];
                  if (tab) navigateToNode(tab, trackedEnrichNodeId);
                }}
              >{trackedEnrichNodeId}</code>
            )}
          </span>
        )}
        {edit.status === 'dismissed' && (
          <span className="rp-dismissed-label">Dismissed</span>
        )}
      </div>
  );
}

function EditCardLabelRow({ editing, edit, editedLabel, setEditedLabel, resolved, setEditing }: {
  editing: boolean;
  edit: ReflectionEdit;
  editedLabel: string;
  setEditedLabel: React.Dispatch<React.SetStateAction<string>>;
  resolved: boolean;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
      <div className="rp-label-row">
        {editing ? (
          <>
            {edit.current_label && (
              <span className="rp-strike-muted">{edit.current_label}{' → '}</span>
            )}
            <input
              type="text"
              value={editedLabel}
              onChange={e => setEditedLabel(e.target.value)}
              className="rp-label-input"
            />
          </>
        ) : edit.current_label && edit.current_label !== edit.proposed_label ? (
          <>
            <span className="rp-strike-muted">{edit.current_label}</span>
            {' → '}
            <span
              className="rp-editable-label"
              /* eslint-disable-next-line local/no-inline-style -- cursor/border-bottom toggle on whether the edit is still resolvable */
              style={{ cursor: resolved ? undefined : 'pointer', borderBottom: resolved ? undefined : '1px dashed var(--text-muted)' }}
              title={resolved ? undefined : 'Click to edit label'}
              onClick={resolved ? undefined : () => setEditing(true)}
            >{editedLabel}</span>
          </>
        ) : (
          <span
            className="rp-editable-label"
            /* eslint-disable-next-line local/no-inline-style -- cursor/border-bottom toggle on whether the edit is still resolvable */
            style={{ cursor: resolved ? undefined : 'pointer', borderBottom: resolved ? undefined : '1px dashed var(--text-muted)' }}
            title={resolved ? undefined : 'Click to edit label'}
            onClick={resolved ? undefined : () => setEditing(true)}
          >{editedLabel}</span>
        )}
      </div>
  );
}

function EditCardCurrentDesc({ edit, currentNode, descMode, setDescMode }: {
  edit: ReflectionEdit;
  currentNode: unknown;
  descMode: DescMode;
  setDescMode: SetDescMode;
}) {
  // t/3402: the equality check must gate diff-highlighting (in EditCardProposedBox), not this box's
  // visibility — a label-only revise has current_description === proposed_description, and hiding the
  // CURRENT box entirely left the user with no context for what they're approving.
  if (!(edit.current_description && edit.edit_type !== 'add')) return null;
  const resolved_desc = resolveDescription(
    currentNode ? { description: edit.current_description, plain_description: (currentNode as { plain_description?: string | null }).plain_description } : { description: edit.current_description },
    descMode,
  );
  return (
    <div className="rp-current-desc-box">
      <div className="rp-row-6-2">
        <span className="rp-label-current">CURRENT</span>
        <DescriptionToggle
          mode={descMode}
          onToggle={setDescMode}
          hasPlainDescription={!!(currentNode as { plain_description?: string | null } | null)?.plain_description}
        />
      </div>
      {resolved_desc.isGenerating && (
        <div className="rp-generating-note">
          Plain description generating…
        </div>
      )}
      {resolved_desc.text}
    </div>
  );
}

/** A revise/qualify edit whose description actually changed — the case EditCardProposedBox renders as a
 *  CURRENT→PROPOSED diff. Shared with EditCard's plain-preview effect so generation fires exactly when
 *  that branch is on screen (t/3873). */
function hasProposedDescDiff(edit: ReflectionEdit): edit is ReflectionEdit & { current_description: string } {
  return !!edit.current_description && edit.edit_type !== 'add' && edit.current_description !== edit.proposed_description;
}

/** Edits whose PROPOSED box renders a generated plain preview: new ('add') proposals and revise/qualify diffs. */
function wantsPlainPreview(edit: ReflectionEdit): boolean {
  return edit.edit_type === 'add' || hasProposedDescDiff(edit);
}

/** Review-mode PROPOSED content: plain preview (with loading/error/retry) in plain mode, else formal.
 *  Used for 'add' proposals and for revise/qualify diffs (t/3873); for any other edit EditCard never
 *  generates, so plain mode falls through to the formal text. */
function EditCardPlainContent({ edit, descMode, plainLoading, plainError, plainPreview, runPlainPreview }: {
  edit: ReflectionEdit;
  descMode: DescMode;
  plainLoading: boolean;
  plainError: boolean;
  plainPreview: string | null;
  runPlainPreview: () => Promise<void>;
}) {
  if (descMode !== 'plain') return <>{edit.proposed_description}</>;
  if (plainLoading) return <span className="rp-muted-italic">Generating plain description…</span>;
  if (plainError) {
    return (
      <>
        <div className="rp-plain-error-row">
          <span>{'⚠'} Couldn&apos;t generate a plain description. Showing formal:</span>
          <button
            className="btn btn-sm rp-retry-btn"
            onClick={() => { void runPlainPreview(); }}
          >Retry</button>
        </div>
        {edit.proposed_description}
      </>
    );
  }
  return <>{plainPreview ?? edit.proposed_description}</>;
}

function EditCardProposedBox({ edit, descMode, setDescMode, setEditing, resolved, plainLoading, plainError, plainPreview, runPlainPreview }: {
  edit: ReflectionEdit;
  descMode: DescMode;
  setDescMode: SetDescMode;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
  resolved: boolean;
  plainLoading: boolean;
  plainError: boolean;
  plainPreview: string | null;
  runPlainPreview: () => Promise<void>;
}) {
  return (
        <div
          className="rp-proposed-box"
          /* eslint-disable-next-line local/no-inline-style -- border-left only shown when there is a current-vs-proposed diff to highlight */
          style={{ borderLeft: edit.current_description && edit.edit_type !== 'add' ? '3px solid rgba(34,197,94,0.3)' : undefined }}
        >
          {hasProposedDescDiff(edit) ? (
            <>
              <div className="rp-row-6-2">
                <span className="rp-label-proposed">PROPOSED</span>
                {!resolved && (
                  <>
                    <DescriptionToggle
                      mode={descMode}
                      onToggle={setDescMode}
                      hasPlainDescription={!!plainPreview}
                    />
                    <button
                      className="btn btn-sm btn-ghost rp-edit-btn"
                      onClick={() => setEditing(true)}
                    >&#9998; Edit</button>
                  </>
                )}
              </div>
              {descMode === 'formal' ? diffWords(edit.current_description, edit.proposed_description).map((seg, i) =>
                seg.type === 'added'
                  ? <mark key={i} className="rp-diff-added">{seg.text}</mark>
                  : <span key={i}>{seg.text}</span>
              ) : (
                <EditCardPlainContent edit={edit} descMode={descMode} plainLoading={plainLoading} plainError={plainError} plainPreview={plainPreview} runPlainPreview={runPlainPreview} />
              )}
            </>
          ) : (
            <>
              {!resolved && edit.proposed_description && (
                <div className="rp-row-6-2">
                  {edit.edit_type === 'add' && (
                    <DescriptionToggle
                      mode={descMode}
                      onToggle={setDescMode}
                      hasPlainDescription={!!plainPreview}
                    />
                  )}
                  <span className="rp-flex-1" />
                  <button
                    className="btn btn-sm btn-ghost rp-edit-btn-sm"
                    onClick={() => setEditing(true)}
                  >&#9998; Edit</button>
                </div>
              )}
              <EditCardPlainContent edit={edit} descMode={descMode} plainLoading={plainLoading} plainError={plainError} plainPreview={plainPreview} runPlainPreview={runPlainPreview} />
            </>
          )}
        </div>
  );
}

function EditCardDescription({ edit, currentNode, descMode, setDescMode, editing, setEditing, editedDescription, setEditedDescription, isModified, resolved, plainLoading, plainError, plainPreview, runPlainPreview }: {
  edit: ReflectionEdit;
  currentNode: unknown;
  descMode: DescMode;
  setDescMode: SetDescMode;
  editing: boolean;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
  editedDescription: string;
  setEditedDescription: React.Dispatch<React.SetStateAction<string>>;
  isModified: boolean;
  resolved: boolean;
  plainLoading: boolean;
  plainError: boolean;
  plainPreview: string | null;
  runPlainPreview: () => Promise<void>;
}) {
  return (
    <>
      {/* Description diff */}
      <EditCardCurrentDesc edit={edit} currentNode={currentNode} descMode={descMode} setDescMode={setDescMode} />

      {editing ? (
        /* Edit mode — editable textarea with blue EDITED styling */
        <div className="rp-edit-box">
          <div className="rp-row-6-2">
            <span className="rp-label-edited">EDITED</span>
            {isModified && (
              <span className="rp-modified-badge">Modified</span>
            )}
          </div>
          <textarea
            value={editedDescription}
            onChange={e => setEditedDescription(e.target.value)}
            className="rp-edit-textarea"
          />
        </div>
      ) : (
        /* Review mode — diff-highlighted PROPOSED */
        <EditCardProposedBox
          edit={edit}
          descMode={descMode}
          setDescMode={setDescMode}
          setEditing={setEditing}
          resolved={resolved}
          plainLoading={plainLoading}
          plainError={plainError}
          plainPreview={plainPreview}
          runPlainPreview={runPlainPreview}
        />
      )}
    </>
  );
}

function EditCardCompliance({ complianceViolations, complianceErrors, complianceWarnings }: {
  complianceViolations: ComplianceViolation[];
  complianceErrors: ComplianceViolation[];
  complianceWarnings: ComplianceViolation[];
}) {
  return (
    <>
      {/* DOLCE compliance */}
      {complianceViolations.length > 0 && (
        <div
          className="rp-compliance-box"
          /* eslint-disable-next-line local/no-inline-style -- background/border-left color depend on whether any violations are errors */
          style={{
            background: complianceErrors.length > 0 ? 'rgba(239,68,68,0.06)' : 'rgba(245,158,11,0.06)',
            borderLeft: `3px solid ${complianceErrors.length > 0 ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.4)'}`,
          }}
        >
          <div
            className="rp-compliance-header"
            /* eslint-disable-next-line local/no-inline-style -- text color depends on whether any violations are errors */
            style={{ color: complianceErrors.length > 0 ? '#ef4444' : '#f59e0b' }}
          >
            DOLCE Compliance ({complianceErrors.length} error{complianceErrors.length !== 1 ? 's' : ''}, {complianceWarnings.length} warning{complianceWarnings.length !== 1 ? 's' : ''})
          </div>
          {complianceViolations.map((v, i) => (
            <div key={i} className="rp-violation-row">
              <span
                className="rp-violation-icon"
                /* eslint-disable-next-line local/no-inline-style -- icon color depends on this violation's severity */
                style={{ color: v.severity === 'error' ? '#ef4444' : '#f59e0b' }}
              >
                {v.severity === 'error' ? '✗' : '⚠'}
              </span>
              <span className="rp-muted-text">
                <strong>{v.rule}</strong>: {v.message}
              </span>
            </div>
          ))}
        </div>
      )}
      {complianceViolations.length === 0 && (
        <div className="rp-compliant-ok">
          {'✓'} DOLCE compliant
        </div>
      )}
    </>
  );
}

/** Evidence-check banner (t/3512): the debate record for the edited node, and why the edit was
 *  flagged when no cited claim references it. */
function EditCardEvidenceCheck({ edit }: { edit: ReflectionEdit }) {
  if (edit.evidence_supported !== false) return null;
  const e = edit.engagement;
  const record = e
    ? (e.citations === 0 && e.claim_count === 0 && !e.injected
        ? 'This debate never offered or cited this node.'
        : `This debate: cited ${e.citations}x, ${e.claim_count} claim(s) referenced it${e.injected ? ', offered to the debater' : ''}.`)
    : '';
  return (
    <div className="rp-evidence-unsupported" role="note">
      <span className="rp-evidence-unsupported-badge">Unsupported by debate evidence</span>
      <div>{edit.evidence_note}</div>
      {record && <div className="rp-evidence-unsupported-record">{record}</div>}
    </div>
  );
}

function EditCardEvidence({ edit, expandedEvidence, setExpandedEvidence, anNodes }: {
  edit: ReflectionEdit;
  expandedEvidence: Set<string>;
  setExpandedEvidence: React.Dispatch<React.SetStateAction<Set<string>>>;
  anNodes: AnNode[];
}) {
  if (!edit.evidence_entries || edit.evidence_entries.length === 0) return null;
  return (
        <div className="rp-evidence-label">
          <div>Evidence: {edit.evidence_entries.map((e, i) => (
            <button
              key={i}
              className="btn btn-sm btn-ghost rp-evidence-btn"
              /* eslint-disable-next-line local/no-inline-style -- background/color/text-decoration depend on whether this entry is expanded */
              style={{
                '--rp-evidence-bg': expandedEvidence.has(e) ? 'var(--color-acc, #3b82f6)' : 'var(--bg-secondary)',
                '--rp-evidence-color': expandedEvidence.has(e) ? '#fff' : 'var(--color-acc, #3b82f6)',
                '--rp-evidence-decoration': expandedEvidence.has(e) ? 'none' : 'underline',
              } as React.CSSProperties}
              title={expandedEvidence.has(e) ? `Hide ${e} text` : `Show ${e} text (Shift+click to scroll)`}
              onClick={(ev) => {
                if (ev.shiftKey) { scrollToEvidence(e); return; }
                setExpandedEvidence(prev => {
                  const next = new Set(prev);
                  if (next.has(e)) next.delete(e); else next.add(e);
                  return next;
                });
              }}
            >{e}</button>
          ))}</div>
          {edit.evidence_entries.filter(e => expandedEvidence.has(e)).map(e => {
            const node = anNodes.find(n => n.id === e);
            if (!node) return null;
            return (
              <div key={e} className="rp-evidence-card">
                <span className="rp-evidence-id">{e}</span>
                <span className="rp-evidence-speaker">({node.speaker})</span>
                {node.text}
                {node.attribution_text_genus && <div className="claim-attribution-text"><span className="claim-attribution-label">Attribution:</span>{node.attribution_text_genus}</div>}
              </div>
            );
          })}
        </div>
  );
}

function EditCardRegenerateToggle({ showRegenerateToggle, regeneratePhrases, setRegeneratePhrases }: {
  showRegenerateToggle: boolean;
  regeneratePhrases: boolean;
  setRegeneratePhrases: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  if (!showRegenerateToggle) return null;
  return (
        <label className="rp-regenerate-label">
          <input
            type="checkbox"
            checked={regeneratePhrases}
            onChange={e => setRegeneratePhrases(e.target.checked)}
            className="rp-no-margin"
          />
          Regenerate phrases & embeddings
        </label>
  );
}

/** The per-edit overrides the reviewer has armed by seeing a gate's refusal (t/3512 evidence, t/4214 R-6 tag). */
type ArmedOverrides = { evidence: boolean; crossTag: boolean };

function applyOptions(regeneratePhrases: boolean, armed: ArmedOverrides) {
  return {
    regeneratePhrases,
    ...(armed.evidence ? { allowUnsupportedEvidence: true } : {}),
    ...(armed.crossTag ? { allowCrossTag: true } : {}),
  };
}

/** The override a refusal arms, or null when the apply succeeded or its gate's override was already armed. */
function overrideToArm(result: { ok: boolean; refusedBy?: string }, unsupportedEvidence: boolean, armed: ArmedOverrides): keyof ArmedOverrides | null {
  if (result.ok) return null;
  const refusedBy = result.refusedBy ?? (unsupportedEvidence ? 'evidence' : undefined);
  if (refusedBy === 'evidence') return armed.evidence ? null : 'evidence';
  if (refusedBy === 'cross_tag') return armed.crossTag ? null : 'crossTag';
  return null;
}

function applyButtonLabel(armed: ArmedOverrides): string {
  if (armed.crossTag) return 'Apply anyway (cross-wing)';
  return armed.evidence ? 'Apply anyway (no evidence)' : 'Approve & Apply';
}

/** Approve All applies only edits no gate flagged (t/3512, t/4214 R-6): overriding a check is a per-edit,
 *  deliberate act, never a side effect of a bulk approve. A stale stamp is still refused by the store. */
function bulkApplicable(e: ReflectionEdit): boolean {
  if (e.status !== 'pending' || e.evidence_supported === false) return false;
  return !(e.tag_check && tagCheckFlagged(e.tag_check));
}

/** What Approve All did (CL #3314 review): a skipped edit is never silent. */
function bulkSummaryText(applied: number, skipped: number): string {
  return skipped > 0
    ? `Applied ${applied}. Skipped ${skipped} flagged by a check; review them one by one.`
    : `Applied ${applied}.`;
}

function EditCardActions({ resolved, editing, isModified, isNoOpEdit, applying, editType, setApplying, setApplyError, setTrackedEnrichNodeId, applyReflectionEdit, editedLabel, editedDescription, regeneratePhrases, pover, editIndex, handleReset, handleCancel, dismissReflectionEdit, unsupportedEvidence }: {
  resolved: boolean;
  editing: boolean;
  isModified: boolean;
  /** t/3814: generator proposed the current description back unchanged. */
  isNoOpEdit: boolean;
  applying: boolean;
  editType: string;
  setApplying: React.Dispatch<React.SetStateAction<boolean>>;
  setApplyError: React.Dispatch<React.SetStateAction<string | null>>;
  setTrackedEnrichNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  applyReflectionEdit: DebateStoreState['applyReflectionEdit'];
  editedLabel: string;
  editedDescription: string;
  regeneratePhrases: boolean;
  pover: string;
  editIndex: number;
  handleReset: () => void;
  handleCancel: () => void;
  dismissReflectionEdit: DebateStoreState['dismissReflectionEdit'];
  /** The evidence check flagged this edit (t/3512) — apply requires an explicit override. */
  unsupportedEvidence: boolean;
}) {
  // Each apply-time gate (evidence t/3512, tag t/4214 R-6) refuses first; the refusal is shown and arms that gate's
  // explicit override, so the human, not the model, confirms applying a flagged edit. Armed overrides accumulate.
  const [armed, setArmed] = useState<ArmedOverrides>({ evidence: false, crossTag: false });
  if (resolved) return null;
  const isEmpty = editing && (
    (editType === 'add' && !editedLabel.trim()) || !editedDescription.trim()
  );
  // t/3814: visible rather than silently suppressed — a disappearing card is the same
  // invisibility that let 32 of these accumulate unnoticed (t/3813). Editing is still
  // reachable via the pencil icon in the proposed-description box, so a genuine edit
  // isn't blocked — only the no-op default path is.
  if (!editing && isNoOpEdit) {
    return (
      <div className="rp-actions-row">
        <span className="rp-no-op-notice">No change proposed — the suggestion matches the current description.</span>
        <button
          className="btn rp-btn-sm"
          onClick={() => dismissReflectionEdit(pover, editIndex)}
        >
          Dismiss
        </button>
      </div>
    );
  }
  return (
        <div className="rp-actions-row">
          <button
            className="btn btn-primary rp-btn-approve"
            disabled={isEmpty || applying}
            onClick={async () => {
              setApplying(true);
              setApplyError(null);
              try {
                const overrides = editing && isModified ? { label: editedLabel, description: editedDescription } : undefined;
                const result = await applyReflectionEdit(pover, editIndex, overrides, applyOptions(regeneratePhrases, armed));
                const toArm = overrideToArm(result, unsupportedEvidence, armed);
                if (toArm) {
                  setArmed(a => ({ ...a, [toArm]: true }));
                  setApplyError(result.error ?? (toArm === 'evidence' ? 'Unsupported by debate evidence' : 'Flagged by the tag check'));
                  return;
                }
                if (!result.ok) {
                  setApplyError(result.error ?? 'Save failed — check SaveBar for details');
                } else if (result.enrichNodeId) {
                  setTrackedEnrichNodeId(result.enrichNodeId);
                }
              } catch (err) {
                getGlobalRecorder()?.record({ type: 'system.error', component: 'reflections-panel', level: 'error', message: 'reflection edit apply failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
                setApplyError(String(err));
              } finally {
                setApplying(false);
              }
            }}
          >
            {applying ? 'Saving…' : applyButtonLabel(armed)}
          </button>
          {editing && isModified && (
            <button
              className="btn rp-btn-sm"
              onClick={handleReset}
            >
              Reset
            </button>
          )}
          {editing && (
            <button
              className="btn rp-btn-sm"
              onClick={handleCancel}
            >
              Cancel
            </button>
          )}
          <button
            className="btn rp-btn-sm"
            onClick={() => dismissReflectionEdit(pover, editIndex)}
          >
            Dismiss
          </button>
        </div>
  );
}

function EditCardEnrichmentStatus({ enrichStatus, edit, trackedEnrichNodeId, navigateToNode, enrichNodeId, clearEnrichmentStatus, retryEnrichment, pover }: {
  enrichStatus: EnrichStatus;
  edit: ReflectionEdit;
  trackedEnrichNodeId: string | null;
  navigateToNode: TaxStoreState['navigateToNode'];
  enrichNodeId: string | null;
  clearEnrichmentStatus: DebateStoreState['clearEnrichmentStatus'];
  retryEnrichment: DebateStoreState['retryEnrichment'];
  pover: string;
}) {
  return (
    <>
      {/* Enrichment status indicator */}
      {enrichStatus?.status === 'pending' && (
        <div className="rp-enrich-pending">
          <span className="rp-pulse-icon">{'⧗'}</span>
          Enriching node — generating attributes & phrases…
        </div>
      )}
      {enrichStatus?.status === 'success' && (
        <div className="rp-enrich-success">
          <span className="rp-row-6">
            {'✓'} Phrases regenerated successfully
            {edit.edit_type === 'add' && trackedEnrichNodeId && (
              <code
                className="rp-node-chip-lg"
                title={`Navigate to ${trackedEnrichNodeId}`}
                onClick={() => {
                  const prefix = trackedEnrichNodeId.split('-')[0];
                  const tab = PREFIX_TO_POV[prefix];
                  if (tab) navigateToNode(tab, trackedEnrichNodeId);
                }}
              >{trackedEnrichNodeId}</code>
            )}
          </span>
          <button
            className="btn btn-sm btn-ghost rp-clear-btn"
            onClick={() => enrichNodeId && clearEnrichmentStatus(enrichNodeId)}
          >{'✕'}</button>
        </div>
      )}
      {enrichStatus?.status === 'error' && (
        <div className="rp-enrich-error">
          <div className="rp-row-between">
            <span>{'✗'} Enrichment failed: {enrichStatus.error}</span>
            <button
              className="btn btn-sm rp-retry-btn-inline"
              onClick={() => {
                if (!enrichNodeId) return;
                const povKey = pover as 'accelerationist' | 'safetyist' | 'skeptic';
                void retryEnrichment(enrichNodeId, povKey);
              }}
            >Retry</button>
          </div>
        </div>
      )}
    </>
  );
}

function EditCardApplyError({ applyError, isIntegrityError, fixing, setFixing, retryReflectionEditAfterFix, setApplyError, pover, editIndex }: {
  applyError: string | null;
  isIntegrityError: boolean;
  fixing: boolean;
  setFixing: React.Dispatch<React.SetStateAction<boolean>>;
  retryReflectionEditAfterFix: DebateStoreState['retryReflectionEditAfterFix'];
  setApplyError: React.Dispatch<React.SetStateAction<string | null>>;
  pover: string;
  editIndex: number;
}) {
  if (!applyError) return null;
  return (
        <div className="rp-apply-error">
          <div>{applyError}</div>
          {isIntegrityError && (
            <div className="rp-fixit-row">
              <button
                className="btn btn-sm rp-fixit-btn"
                disabled={fixing}
                title="Remove the dangling references blocking this save, then retry"
                onClick={async () => {
                  setFixing(true);
                  try {
                    const result = await retryReflectionEditAfterFix(pover, editIndex);
                    if (result.ok) setApplyError(null);
                    else setApplyError(result.error ?? 'Fix failed — check SaveBar for details');
                  } catch (err) {
                    getGlobalRecorder()?.record({ type: 'system.error', component: 'reflections-panel', level: 'error', message: 'fix-it retry failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
                    setApplyError(String(err));
                  } finally {
                    setFixing(false);
                  }
                }}
              >
                {fixing ? 'Fixing…' : 'Fix it'}
              </button>
              <span className="rp-2xs-muted">
                Removes edges that point to nonexistent nodes, then saves.
              </span>
            </div>
          )}
        </div>
  );
}

function EditCard({ edit, pover, editIndex }: {
  edit: ReflectionEdit;
  pover: string;
  editIndex: number;
}) {
  const { applyReflectionEdit, retryReflectionEditAfterFix, dismissReflectionEdit, retryEnrichment, clearEnrichmentStatus, anNodes, enrichmentStatus } = useDebateStore(
    useShallow(s => ({
      applyReflectionEdit: s.applyReflectionEdit,
      retryReflectionEditAfterFix: s.retryReflectionEditAfterFix,
      dismissReflectionEdit: s.dismissReflectionEdit,
      retryEnrichment: s.retryEnrichment,
      clearEnrichmentStatus: s.clearEnrichmentStatus,
      anNodes: (s.activeDebate as unknown as Record<string, unknown> | null)?.argument_network
        ? ((s.activeDebate as unknown as Record<string, unknown>).argument_network as { nodes: { id: string; text: string; speaker: string; attribution_text_genus?: string }[] }).nodes
        : [],
      enrichmentStatus: s.enrichmentStatus,
    }))
  );
  const [trackedEnrichNodeId, setTrackedEnrichNodeId] = useState<string | null>(null);
  const enrichNodeId = trackedEnrichNodeId ?? (edit.edit_type !== 'add' ? edit.node_id : null);
  const enrichStatus = enrichNodeId ? enrichmentStatus[enrichNodeId] : undefined;
  const typeInfo = EDIT_TYPE_LABELS[edit.edit_type] || EDIT_TYPE_LABELS.revise;
  const resolved = edit.status !== 'pending';

  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [editedLabel, setEditedLabel] = useState(edit.proposed_label);
  const [editedDescription, setEditedDescription] = useState(edit.proposed_description);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // AC2 (t/1563): honor the app-wide description-mode preference (defaults to plain,
  // remembers the user's choice) instead of hard-coding 'formal'.
  const [descMode, setDescMode] = useDescriptionMode();
  const currentNode = useTaxonomyStore(useShallow(s => {
    if (!edit.node_id || edit.edit_type === 'add') return null;
    const prefix = edit.node_id.split('-')[0];
    const pov = PREFIX_TO_POV[prefix];
    if (!pov) return null;
    const file = s[pov];
    return file?.nodes?.find((n: { id: string }) => n.id === edit.node_id) ?? null;
  }));
  const [fixing, setFixing] = useState(false);
  // Integrity failures (e.g. dangling CONVERGES_WITH edges) are auto-fixable via "Fix it".
  const isIntegrityError = !!applyError && applyError.startsWith('Integrity check failed');
  const [regeneratePhrases, setRegeneratePhrases] = useState(false);
  const showRegenerateToggle = !resolved && (edit.edit_type === 'revise' || edit.edit_type === 'qualify');
  const [plainPreview, setPlainPreview] = useState<string | null>(null);
  const [plainLoading, setPlainLoading] = useState(false);
  const [plainError, setPlainError] = useState(false);
  const navigateToNode = useTaxonomyStore(s => s.navigateToNode);

  // AC1/AC3 (t/1563): generate the plain (vernacular) preview for a NEW ('add')
  // proposal on demand. Used both by the on-render effect and the Retry button.
  // generatePlainPreview() returns null on AI/vernacular-model failure — surface
  // that as plainError rather than silently falling back to the formal text.
  const plainSource = editing ? editedDescription : edit.proposed_description;
  const runPlainPreview = useCallback(async () => {
    setPlainLoading(true);
    setPlainError(false);
    try {
      const preview = await generatePlainPreview(plainSource);
      if (preview == null) setPlainError(true);
      else setPlainPreview(preview);
    } catch (err) {
      setPlainError(true);
      getGlobalRecorder()?.record({ type: 'system.error', component: 'reflections-panel', level: 'warn', message: 'Plain preview generation failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    } finally {
      setPlainLoading(false);
    }
  }, [plainSource]);

  // AC1 (t/1563): trigger generation when a proposal is *displayed* in plain
  // mode — not only on an explicit toggle click. Skips if already generated, in
  // flight, or previously failed (Retry clears plainError to re-arm this).
  // t/3873: also revise/qualify edits with a real description diff — the same
  // predicate EditCardProposedBox uses to pick its diff branch.
  const needsPlainPreview = wantsPlainPreview(edit);
  useEffect(() => {
    if (needsPlainPreview && descMode === 'plain' && !resolved
        && !plainPreview && !plainLoading && !plainError) {
      void runPlainPreview();
    }
  }, [needsPlainPreview, descMode, resolved, plainPreview, plainLoading, plainError, runPlainPreview]);

  const isModified = editedLabel !== edit.proposed_label
                  || editedDescription !== edit.proposed_description;

  // t/3814: the generator can propose the current description back unchanged (QUALIFY gives it
  // no way to decline — t/3813). Defense-in-depth backstop: don't render that as an actionable
  // approval regardless of what t/3813 does upstream.
  //
  // Gated on BOTH fields, not description alone: a legitimate label-only revise has
  // current_description === proposed_description by design (t/3402's comment on
  // EditCardCurrentDesc) — the label change there is a real edit and must stay approvable.
  const isNoOpEdit = edit.edit_type !== 'add'
    && edit.current_description != null
    && normalizeForNoOpCompare(edit.current_description) === normalizeForNoOpCompare(edit.proposed_description)
    && (edit.current_label == null || normalizeForNoOpCompare(edit.current_label) === normalizeForNoOpCompare(edit.proposed_label));

  const complianceViolations = useMemo(
    () => checkDolceCompliance(editing ? editedDescription : edit.proposed_description, edit.node_id || ''),
    [editing, editedDescription, edit.proposed_description, edit.node_id],
  );
  const complianceErrors = complianceViolations.filter(v => v.severity === 'error');
  const complianceWarnings = complianceViolations.filter(v => v.severity === 'warning');

  const handleReset = () => {
    setEditedLabel(edit.proposed_label);
    setEditedDescription(edit.proposed_description);
    setRegeneratePhrases(false);
  };

  const handleCancel = () => {
    handleReset();
    setEditing(false);
  };

  return (
    <div
      className="rp-card"
      /* eslint-disable-next-line local/no-inline-style -- border/bg/opacity depend on resolved + typeInfo.color, passed as CSS custom properties */
      style={{ '--rp-border': resolved ? 'var(--border-color)' : typeInfo.color, '--rp-bg': resolved ? 'var(--bg-secondary)' : 'var(--bg-primary)', '--rp-opacity': resolved ? 0.6 : 1 } as React.CSSProperties}
    >
      <EditCardHeader edit={edit} typeInfo={typeInfo} trackedEnrichNodeId={trackedEnrichNodeId} navigateToNode={navigateToNode} />

      <EditCardLabelRow editing={editing} edit={edit} editedLabel={editedLabel} setEditedLabel={setEditedLabel} resolved={resolved} setEditing={setEditing} />

      <EditCardDescription
        edit={edit}
        currentNode={currentNode}
        descMode={descMode}
        setDescMode={setDescMode}
        editing={editing}
        setEditing={setEditing}
        editedDescription={editedDescription}
        setEditedDescription={setEditedDescription}
        isModified={isModified}
        resolved={resolved}
        plainLoading={plainLoading}
        plainError={plainError}
        plainPreview={plainPreview}
        runPlainPreview={runPlainPreview}
      />

      <EditCardCompliance complianceViolations={complianceViolations} complianceErrors={complianceErrors} complianceWarnings={complianceWarnings} />

      {/* Rationale */}
      <div className="rp-rationale">
        {edit.rationale}
      </div>

      <EditCardEvidence edit={edit} expandedEvidence={expandedEvidence} setExpandedEvidence={setExpandedEvidence} anNodes={anNodes} />

      <EditCardEvidenceCheck edit={edit} />

      <ReflectionTagCheckBanner check={edit.tag_check} />

      <EditCardRegenerateToggle showRegenerateToggle={showRegenerateToggle} regeneratePhrases={regeneratePhrases} setRegeneratePhrases={setRegeneratePhrases} />

      <EditCardActions
        resolved={resolved}
        editing={editing}
        isModified={isModified}
        isNoOpEdit={isNoOpEdit}
        applying={applying}
        editType={edit.edit_type}
        setApplying={setApplying}
        setApplyError={setApplyError}
        setTrackedEnrichNodeId={setTrackedEnrichNodeId}
        applyReflectionEdit={applyReflectionEdit}
        editedLabel={editedLabel}
        editedDescription={editedDescription}
        regeneratePhrases={regeneratePhrases}
        pover={pover}
        editIndex={editIndex}
        handleReset={handleReset}
        handleCancel={handleCancel}
        dismissReflectionEdit={dismissReflectionEdit}
        unsupportedEvidence={edit.evidence_supported === false}
      />

      <EditCardEnrichmentStatus
        enrichStatus={enrichStatus}
        edit={edit}
        trackedEnrichNodeId={trackedEnrichNodeId}
        navigateToNode={navigateToNode}
        enrichNodeId={enrichNodeId}
        clearEnrichmentStatus={clearEnrichmentStatus}
        retryEnrichment={retryEnrichment}
        pover={pover}
      />

      <EditCardApplyError
        applyError={applyError}
        isIntegrityError={isIntegrityError}
        fixing={fixing}
        setFixing={setFixing}
        retryReflectionEditAfterFix={retryReflectionEditAfterFix}
        setApplyError={setApplyError}
        pover={pover}
        editIndex={editIndex}
      />
    </div>
  );
}

function PoverReflection({ result }: { result: ReflectionResult }) {
  const info = POVER_INFO[result.pover as Exclude<SpeakerId, 'user'>];
  const color = info?.color || '#888';
  const pending = result.edits.filter(e => e.status === 'pending').length;
  const approved = result.edits.filter(e => e.status === 'approved').length;
  const proposals = result.new_item_proposals ?? [];

  return (
    <div className="rp-pover-section">
      <div
        className="rp-pover-header"
        /* eslint-disable-next-line local/no-inline-style -- border-bottom color is this POV's accent color */
        style={{ borderBottom: `2px solid ${color}` }}
      >
        {/* eslint-disable-next-line local/no-inline-style -- label color is this POV's accent color */}
        <span className="rp-pover-label" style={{ color }}>{result.label}</span>
        <span className="rp-text-sm-muted">
          {result.edits.length} edit{result.edits.length !== 1 ? 's' : ''}
          {approved > 0 && ` (${approved} applied)`}
          {pending > 0 && pending !== result.edits.length && ` (${pending} pending)`}
          {proposals.length > 0 && ` · ${proposals.length} new item${proposals.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {result.reflection_summary && (
        <div
          className="rp-summary-box"
          /* eslint-disable-next-line local/no-inline-style -- background/border-left color is this POV's accent color */
          style={{ background: `${color}10`, borderLeft: `3px solid ${color}` }}
        >
          {result.reflection_summary}
        </div>
      )}

      {result.edits.length === 0 && proposals.length === 0 && (
        <div className="rp-no-edits">
          No taxonomy edits proposed.
        </div>
      )}

      {result.edits.map((edit, i) => (
        <EditCard key={i} edit={edit} pover={result.pover} editIndex={i} />
      ))}

      {proposals.map((p, i) => (
        <ProposalCard key={`prop-${i}`} proposal={p} pover={result.pover} proposalIndex={i} />
      ))}
    </div>
  );
}

// ── Propose-new item card (t/1773) ──────────────────────
// Renders a `NewPovItemProposal`: the new node's fields + its proposed edges, with
// Approve/Dismiss. Exclusive vs edit_existing (this is the sole new-node path; add is
// retired). Applying it creates the node AND persists its edges atomically (ruling B).

const NEW_ITEM_COLOR = '#22c55e';

/**
 * t/4214 R-6b: the reviewer picks the new node's wing tags, starting from the seat's own tag (R-4). `applyArgs` is
 * empty for a POV with no tags, so its apply call is unchanged.
 */
function useProposalTags(pover: string, pov: string) {
  const seatTag = useDebateStore(s => s.activeDebate?.seat_tags?.[pover as SpeakerId]?.pov_tag);
  const tagOptions = useMemo(() => povTagOptionsFor(pov), [pov]);
  const [povTags, setPovTags] = useState<string[]>(() => (seatTag ? [seatTag] : []));
  const applyArgs: [] | [{ povTags: string[] }] = tagOptions.length > 0 ? [{ povTags }] : [];
  return { tagOptions, povTags, setPovTags, applyArgs };
}

function ProposalCard({ proposal, pover, proposalIndex }: {
  proposal: NewPovItemProposal;
  pover: string;
  proposalIndex: number;
}) {
  const { applyReflectionProposal, dismissReflectionProposal, status } = useDebateStore(
    useShallow(s => ({
      applyReflectionProposal: s.applyReflectionProposal,
      dismissReflectionProposal: s.dismissReflectionProposal,
      status: s.newItemProposalStatus[`${pover}#${proposalIndex}`],
    }))
  );
  const navigateToNode = useTaxonomyStore(s => s.navigateToNode);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [createdNodeId, setCreatedNodeId] = useState<string | null>(null);
  const resolved = status === 'approved' || status === 'dismissed';
  const info = POVER_INFO[proposal.pov as Exclude<SpeakerId, 'user'>];
  const { tagOptions, povTags, setPovTags, applyArgs } = useProposalTags(pover, proposal.pov);

  return (
    <div
      className="rp-card"
      /* eslint-disable-next-line local/no-inline-style -- border/bg/opacity depend on resolved (NEW_ITEM_COLOR is a fixed module constant) */
      style={{ '--rp-border': resolved ? 'var(--border-color)' : NEW_ITEM_COLOR, '--rp-bg': resolved ? 'var(--bg-secondary)' : 'var(--bg-primary)', '--rp-opacity': resolved ? 0.6 : 1 } as React.CSSProperties}
    >
      <div className="rp-row-header-8-6">
        <span className="rp-new-item-badge">New Item</span>
        <span className="rp-text-sm-muted">{proposal.category}</span>
        {/* eslint-disable-next-line local/no-inline-style -- color depends on info?.color for this proposal's POV */}
        <span className="rp-pov-chip" style={{ color: info?.color || 'var(--text-muted)' }}>
          {info?.label || proposal.pov}
        </span>
        {status === 'approved' && (
          <span className="rp-applied-label">
            Applied
            {createdNodeId && (
              <code
                className="rp-node-chip-sm"
                title={`Navigate to ${createdNodeId}`}
                onClick={() => {
                  const tab = PREFIX_TO_POV[createdNodeId.split('-')[0]];
                  if (tab) navigateToNode(tab, createdNodeId);
                }}
              >{createdNodeId}</code>
            )}
          </span>
        )}
        {status === 'dismissed' && (
          <span className="rp-dismissed-label">Dismissed</span>
        )}
      </div>

      {/* Label */}
      <div className="rp-proposal-label">{proposal.label}</div>

      {/* Description */}
      <div className="rp-proposal-desc-box">{proposal.description}</div>

      {/* Proposed edges — the new node is always connected (anti-orphan, t/1725) */}
      <div className="rp-mb-6">
        <div className="rp-edges-count-label">
          Proposed edges ({proposal.proposed_edges.length})
        </div>
        {proposal.proposed_edges.map((e, i) => (
          <div key={i} className="rp-edge-row">
            <div className="rp-edge-mono-row">
              {e.new_node_role === 'source' ? (
                <>
                  <span className="rp-bold">[new item]</span>
                  <span className="rp-accent-text">—{e.edge_type}→</span>
                  <code>{e.target_node_id}</code>
                </>
              ) : (
                <>
                  <code>{e.target_node_id}</code>
                  <span className="rp-accent-text">—{e.edge_type}→</span>
                  <span className="rp-bold">[new item]</span>
                </>
              )}
            </div>
            {e.rationale && (
              <div className="rp-edge-rationale">{e.rationale}</div>
            )}
          </div>
        ))}
      </div>

      {/* Rationale */}
      <div className="rp-rationale-mb6">
        {proposal.rationale}
      </div>

      {/* Wing tags (t/4214 R-6b) and actions */}
      {!resolved && (<>
        <ProposalTagEditor options={tagOptions} value={povTags} onChange={setPovTags} disabled={applying} />
        <div className="rp-actions-row">
          <button
            className="btn btn-primary rp-btn-approve"
            disabled={applying}
            onClick={async () => {
              setApplying(true);
              setApplyError(null);
              try {
                const result = await applyReflectionProposal(pover, proposalIndex, ...applyArgs);
                if (!result.ok) setApplyError(result.error ?? 'Save failed — check SaveBar for details');
                else if (result.createdNodeId) setCreatedNodeId(result.createdNodeId);
              } catch (err) {
                getGlobalRecorder()?.record({ type: 'system.error', component: 'reflections-panel', level: 'error', message: 'reflection proposal apply failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
                setApplyError(String(err));
              } finally {
                setApplying(false);
              }
            }}
          >{applying ? 'Saving…' : 'Approve & Apply'}</button>
          <button
            className="btn rp-btn-sm"
            onClick={() => dismissReflectionProposal(pover, proposalIndex)}
          >Dismiss</button>
        </div>
      </>)}
      {applyError && (
        <div className="rp-apply-error">
          {applyError}
        </div>
      )}
    </div>
  );
}

export function ReflectionsPanel({ onClose }: { onClose: () => void }) {
  const { reflections, newItemProposalStatus, debateGenerating, requestReflections, applyReflectionEdit, dismissReflectionEdit, applyReflectionProposal, dismissReflectionProposal } = useDebateStore(
    useShallow(s => ({ reflections: s.reflections, newItemProposalStatus: s.newItemProposalStatus, debateGenerating: s.debateGenerating, requestReflections: s.requestReflections, applyReflectionEdit: s.applyReflectionEdit, dismissReflectionEdit: s.dismissReflectionEdit, applyReflectionProposal: s.applyReflectionProposal, dismissReflectionProposal: s.dismissReflectionProposal }))
  );
  const isGenerating = debateGenerating != null;

  // Pending/applied counts span both edit_existing edits and propose_new proposals (t/1773).
  const proposalIsPending = (pover: string, i: number) => !newItemProposalStatus[`${pover}#${i}`];
  const totalPending = reflections.reduce((sum, r) =>
    sum + r.edits.filter(e => e.status === 'pending').length
        + (r.new_item_proposals ?? []).filter((_, i) => proposalIsPending(r.pover, i)).length, 0);
  const totalApproved = reflections.reduce((sum, r) =>
    sum + r.edits.filter(e => e.status === 'approved').length
        + (r.new_item_proposals ?? []).filter((_, i) => newItemProposalStatus[`${r.pover}#${i}`] === 'approved').length, 0);

  const [bulkSummary, setBulkSummary] = useState<string | null>(null);
  const approveAll = async () => {
    let applied = 0;
    let skipped = 0;
    for (const r of reflections) {
      for (let i = 0; i < r.edits.length; i++) {
        if (r.edits[i].status !== 'pending') continue;
        if (!bulkApplicable(r.edits[i])) { skipped++; continue; }
        if ((await applyReflectionEdit(r.pover, i)).ok) applied++;
      }
      const proposals = r.new_item_proposals ?? [];
      for (let i = 0; i < proposals.length; i++) {
        if (proposalIsPending(r.pover, i) && (await applyReflectionProposal(r.pover, i)).ok) applied++;
      }
    }
    setBulkSummary(bulkSummaryText(applied, skipped));
  };

  const dismissAll = () => {
    for (const r of reflections) {
      r.edits.forEach((e, i) => {
        if (e.status === 'pending') dismissReflectionEdit(r.pover, i);
      });
      (r.new_item_proposals ?? []).forEach((_, i) => {
        if (proposalIsPending(r.pover, i)) dismissReflectionProposal(r.pover, i);
      });
    }
  };

  // Drag state
  const [pos, setPos] = useState({ x: 0, y: 0 }); // offset from center
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from header area, not buttons
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  }, [pos.x, pos.y]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
        y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
      });
    };
    const onMouseUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="reflections-panel rp-overlay">
      <div
        className="rp-modal-box"
        /* eslint-disable-next-line local/no-inline-style -- transform tracks the user-dragged panel position */
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      >
        {/* Header — drag handle */}
        <div
          onMouseDown={onMouseDown}
          className="rp-modal-header"
          /* eslint-disable-next-line local/no-inline-style -- cursor toggles between grab/grabbing while dragging */
          style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
        >
          <h3 className="rp-modal-title">Post-Debate Reflections</h3>
          <TheoryLink
            docPath="docs/debate-reflections.md"
            label="Post-Debate Reflections — how it works"
            tooltip="Open the Reflections theory-of-operations doc"
            size={15}
          />
          {reflections.length > 0 && totalPending > 0 && (
            <>
              <button className="btn btn-primary rp-btn-sm" onClick={approveAll}>
                Approve All ({totalPending})
              </button>
              <button className="btn rp-btn-sm" onClick={dismissAll}>
                Dismiss All
              </button>
            </>
          )}
          {totalApproved > 0 && (
            <span className="rp-total-applied">{totalApproved} applied</span>
          )}
          {bulkSummary && <span className="rp-bulk-summary" role="status">{bulkSummary}</span>}
          <button
            onClick={onClose}
            className="rp-close-btn"
          >&times;</button>
        </div>

        {/* Content */}
        <div className="rp-content-area">
          {reflections.length === 0 && !isGenerating && (
            <div className="rp-empty-state">
              <p className="rp-empty-text">
                Ask each debater to reflect on the conversation and propose specific edits to their Beliefs, Desires, and Intentions taxonomy.
              </p>
              <button
                className="btn btn-primary rp-start-btn"
                onClick={() => requestReflections()}
              >
                Start Post-Debate Reflections
              </button>
            </div>
          )}

          {isGenerating && reflections.length === 0 && (
            <div className="rp-empty-state rp-waiting-text">
              Waiting for reflections...
            </div>
          )}

          {reflections.length > 1 && (
            <div className="rp-order-note">
              Reflection order: {reflections.map((r, i) => r.label).join(' → ')}. Each camp sees prior camps&apos; proposals to avoid duplicating the same concept.
            </div>
          )}
          {reflections.map((r, ri) => (
            <PoverReflection key={r.pover} result={r} />
          ))}
        </div>
      </div>
    </div>
  );
}
