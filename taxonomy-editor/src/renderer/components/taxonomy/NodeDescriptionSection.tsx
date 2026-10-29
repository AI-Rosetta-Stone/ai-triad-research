// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// DescriptionSection — the node description block, now rendered above the tabs for both
// Simple and Advanced (t/4574, docs/ux/node-detail-redesign.md §2.4). Simple shows unboxed
// serif plain text with no toolbar. Advanced shows a right-aligned Formal|Plain toolbar plus
// Edit/Regenerate, and renders Formal as a lead sentence + ENCOMPASSES/EXCLUDES rows, falling
// back to full paragraphs when the genus-differentia markers don't parse (never drops text).

import { useEffect, useState } from 'react';
import type { Pov, PovNode } from '../../types/taxonomy';
import type { MentionSegment } from '../shared/mentionText';
import type { EntityRef } from '@lib/entities/types';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { buildSearchRegex } from '../../utils/searchRegex';
import { DescriptionToggle } from '../shared/DescriptionToggle';
import { HighlightedTextarea } from '../shared/HighlightedField';
import { triggerPovNodeRegeneration } from '../../utils/regeneratePlainDescription';

/** Entity-mention render segments for the read-only `description` field + their click handler (t/1908). */
export interface DescriptionMention {
  segments: readonly MentionSegment[];
  onSelectRef: (ref: EntityRef) => void;
}

export interface DescriptionSectionProps {
  pov: Pov;
  node: PovNode;
  readOnly?: boolean;
  err: (field: string) => string | undefined;
  /** Panel-local Simple/Advanced mode (t/4574) — replaces the former global viewMode read. */
  nodeDetailMode: 'simple' | 'advanced';
  descMode: 'formal' | 'plain';
  setDescMode: (mode: 'formal' | 'plain') => void;
  update: (updates: Partial<PovNode>) => void;
  updatePovNode: (pov: Pov, id: string, updates: Partial<PovNode>) => void;
  /** Mention segments for the formal `description` HighlightedTextarea (t/1908); undefined = no links. */
  descriptionMention?: DescriptionMention;
  /** t/2811: mention segments for the plain_description read-only highlight path; undefined = no links. */
  plainDescriptionMention?: DescriptionMention;
  /** t/4641: when true, don't render the Advanced toolbar (parent renders it separately). */
  hideToolbar?: boolean;
  /** t/4641: description edit mode state, lifted from NodeDetail for shared toolbar rendering. */
  isEditing?: boolean;
  setIsEditing?: (value: boolean) => void;
}

interface FormalParts {
  lead: string;
  encompasses?: string;
  excludes?: string;
}

/** Parses the genus-differentia `description` into a lead sentence plus ENCOMPASSES/EXCLUDES
 *  clauses (docs/ux/node-detail-redesign.md §2.4). Returns null when neither marker is present,
 *  or the lead would be empty, so the caller can fall back to rendering the full text verbatim —
 *  never dropping content. */
export function parseFormalDescription(desc: string | undefined): FormalParts | null {
  if (!desc) return null;
  if (!/encompasses:/i.test(desc) && !/excludes:/i.test(desc)) return null;
  const lead = desc.split(/encompasses:/i)[0].trim();
  if (!lead) return null;
  const encMatch = desc.match(/Encompasses:\s*(.+?)(?:\n|Excludes:|$)/is);
  const excMatch = desc.match(/Excludes:\s*(.+?)$/is);
  const encompasses = encMatch?.[1]?.trim();
  const excludes = excMatch?.[1]?.trim();
  if (!encompasses && !excludes) return null;
  return { lead, encompasses, excludes };
}

/** Resolves the read-only text + mention segments for whichever field is actually shown
 *  (plain_description when populated, else the raw description), per t/2811. */
function readOnlySource(node: PovNode, plainDescriptionMention?: DescriptionMention, descriptionMention?: DescriptionMention) {
  const usesPlain = !!node.plain_description;
  return {
    value: node.plain_description ?? node.description,
    mention: usesPlain ? plainDescriptionMention : descriptionMention,
  };
}

function SimpleDescriptionBody({ node, readOnly, descriptionMention, plainDescriptionMention }: Pick<DescriptionSectionProps, 'node' | 'readOnly' | 'descriptionMention' | 'plainDescriptionMention'>) {
  if (!readOnly) return <p className="nd-description-prose">{node.plain_description ?? node.description ?? ''}</p>;
  const { value, mention } = readOnlySource(node, plainDescriptionMention, descriptionMention);
  return <HighlightedTextarea value={value} readOnly mentionSegments={mention?.segments} onSelectRef={mention?.onSelectRef} />;
}

function FormalDescriptionBody({ formal, description }: { formal: FormalParts | null; description?: string }) {
  if (formal) {
    return (
      <div className="nd-description-formal">
        <p className="nd-description-lead">{formal.lead}</p>
        {formal.encompasses && (
          <div className="nd-formal-row">
            <span className="nd-formal-label nd-formal-label-encompasses">Encompasses</span>
            <span className="nd-formal-value">{formal.encompasses}</span>
          </div>
        )}
        {formal.excludes && (
          <div className="nd-formal-row">
            <span className="nd-formal-label nd-formal-label-excludes">Excludes</span>
            <span className="nd-formal-value">{formal.excludes}</span>
          </div>
        )}
      </div>
    );
  }
  // Never drop text: an unparseable description renders in full, as paragraphs.
  return (
    <div className="nd-description-formal-fallback">
      {(description ?? '').split(/\n+/).filter(Boolean).map((para, i) => <p key={i}>{para}</p>)}
    </div>
  );
}

function PlainDescriptionBody({ node, readOnly, descriptionMention, plainDescriptionMention }: Pick<DescriptionSectionProps, 'node' | 'readOnly' | 'descriptionMention' | 'plainDescriptionMention'>) {
  if (node.plain_description === null) {
    return <div className="plain-description-box plain-description-generating">Regenerating…</div>;
  }
  if (!readOnly) {
    return <div className="nd-description-prose-box">{node.plain_description ?? node.description}</div>;
  }
  const { value, mention } = readOnlySource(node, plainDescriptionMention, descriptionMention);
  return (
    <div className="nd-description-prose-box">
      <HighlightedTextarea value={value} readOnly mentionSegments={mention?.segments} onSelectRef={mention?.onSelectRef} />
    </div>
  );
}

interface AdvancedToolbarProps {
  descMode: 'formal' | 'plain';
  setDescMode: (mode: 'formal' | 'plain') => void;
  hasPlainDescription: boolean;
  showEdit: boolean;
  isEditing: boolean;
  onToggleEdit: () => void;
  showRegenerate: boolean;
  regenerateDisabled: boolean;
  onRegenerate: () => void;
}

function AdvancedDescriptionToolbar({ descMode, setDescMode, hasPlainDescription, showEdit, isEditing, onToggleEdit, showRegenerate, regenerateDisabled, onRegenerate }: AdvancedToolbarProps) {
  return (
    <div className="nd-description-toolbar">
      <DescriptionToggle mode={descMode} onToggle={setDescMode} hasPlainDescription={hasPlainDescription} />
      {showEdit && (
        <button type="button" className="nd-desc-action-btn" onClick={onToggleEdit}>
          &#9998; {isEditing ? 'Done' : 'Edit'}
        </button>
      )}
      {showRegenerate && (
        <button type="button" className="nd-desc-action-btn" disabled={regenerateDisabled} onClick={onRegenerate}>
          &#8635; Regenerate
        </button>
      )}
    </div>
  );
}

export function DescriptionSection({ pov, node, readOnly, err, nodeDetailMode, descMode, setDescMode, update, updatePovNode, descriptionMention, plainDescriptionMention, hideToolbar, isEditing: externalIsEditing, setIsEditing: externalSetIsEditing }: DescriptionSectionProps) {
  const { findQuery, findMode, findCaseSensitive } = useTaxonomyStore();
  const [localIsEditing, setLocalIsEditing] = useState(false);
  const isEditing = externalIsEditing ?? localIsEditing;
  const setIsEditing: (value: boolean | ((v: boolean) => boolean)) => void = externalSetIsEditing ?? setLocalIsEditing;
  useEffect(() => { if (externalIsEditing === undefined) setLocalIsEditing(false); }, [node.id, externalIsEditing]);
  // A validation error on description must stay reachable for the existing scroll+focus
  // recovery flow (NodeDetail's hasErrors effect), so force edit mode open when one is set.
  const descError = err('description');
  useEffect(() => { if (descError) setIsEditing(true); }, [descError]);

  // t/2812: a search match in Formal-but-not-Plain surfaces the Formal tab (even under
  // Simple). Empty query restores the global pref. Fresh regex per test — no /g lastIndex carry.
  const matchIn = (t: string) => !!findQuery && (buildSearchRegex(findQuery, findMode, findCaseSensitive)?.test(t) ?? false);
  const baseDescMode: 'formal' | 'plain' = nodeDetailMode === 'simple' ? 'plain' : descMode;
  const effectiveDescMode: 'formal' | 'plain' =
    baseDescMode === 'plain' && matchIn(node.description ?? '') && !matchIn(node.plain_description ?? '') ? 'formal' : baseDescMode;

  if (nodeDetailMode === 'simple') {
    return (
      <div className={`nd-description nd-description-simple ${descError ? 'has-error' : ''}`}>
        <SimpleDescriptionBody node={node} readOnly={readOnly} descriptionMention={descriptionMention} plainDescriptionMention={plainDescriptionMention} />
      </div>
    );
  }

  const isEditingFormal = isEditing && !readOnly && effectiveDescMode === 'formal';

  return (
    <div className={`nd-description nd-description-advanced ${descError ? 'has-error' : ''}`}>
      {!hideToolbar && (
        <AdvancedDescriptionToolbar
          descMode={descMode}
          setDescMode={setDescMode}
          hasPlainDescription={!!node.plain_description}
          showEdit={!readOnly && effectiveDescMode === 'formal'}
          isEditing={isEditing}
          onToggleEdit={() => setIsEditing(v => !v)}
          showRegenerate={!readOnly}
          regenerateDisabled={node.plain_description === null}
          onRegenerate={() => triggerPovNodeRegeneration(pov, node.id, node.description, updatePovNode)}
        />
      )}

      {isEditingFormal ? (
        <div className="prose">
          <HighlightedTextarea
            value={node.description}
            onChange={(v) => update({ description: v })}
            rows={6}
            mentionSegments={descriptionMention?.segments}
            onSelectRef={descriptionMention?.onSelectRef}
          />
          {descError && <div className="error-text">{descError}</div>}
        </div>
      ) : effectiveDescMode === 'formal' ? (
        <FormalDescriptionBody formal={parseFormalDescription(node.description)} description={node.description} />
      ) : (
        <PlainDescriptionBody node={node} readOnly={readOnly} descriptionMention={descriptionMention} plainDescriptionMention={plainDescriptionMention} />
      )}
    </div>
  );
}

export { AdvancedDescriptionToolbar };
