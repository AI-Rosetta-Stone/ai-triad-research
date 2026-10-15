// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-6 (spec t/4211): the tag check on a reflection edit card. It shows the target node's tags, how the
// reflecting seat relates to them, and each custodian wing's verdict with the boundary it cited, so the reviewer
// sees why the apply gate flags an edit before choosing to override it.

import type { ReflectionTagCheck } from '../../hooks/useDebateStore/types';
import type { TagRelation } from '@lib/debate/reflectionScope';
import './ReflectionTagCheck.css';

const RELATION_TEXT: Record<TagRelation, string> = {
  own: "Your wing's node",
  shared: 'Shared with another wing',
  foreign: "Another wing's node",
  untagged_target: 'Common ground for the whole camp',
  umbrella_on_tagged: "Untagged seat editing a wing's node",
  no_tags: '',
};

/** Whether the stamp alone flags the edit (staleness is decided at apply time, against the live tags). */
export function tagCheckFlagged(check: ReflectionTagCheck): boolean {
  return check.relation === 'foreign' || !!check.unchecked || !!check.deprecate_shared_note
    || !!check.verdicts?.some(v => v.verdict === 'conflict' || v.verdict === 'tension');
}

export function ReflectionTagCheckBanner({ check }: { check: ReflectionTagCheck | undefined }) {
  if (!check || check.relation === 'no_tags') return null;
  return (
    <div className={`rp-tagcheck${tagCheckFlagged(check) ? ' rp-tagcheck-flagged' : ''}`} role="note" aria-label="Tag check">
      <div className="rp-tagcheck-row">
        <span className="rp-tagcheck-relation">{RELATION_TEXT[check.relation]}</span>
        {check.target_tags.length > 0
          ? check.target_tags.map(t => <span key={t} className="rp-tag-chip">{t}</span>)
          : <span className="rp-tag-chip rp-tag-chip-none">untagged</span>}
        {check.seat_tag && <span className="rp-tagcheck-seat">seat: {check.seat_tag}</span>}
      </div>
      {check.deprecate_shared_note && <div className="rp-tagcheck-note">{check.deprecate_shared_note}</div>}
      {check.unchecked && <div className="rp-tagcheck-note">Tag check incomplete: {check.unchecked}</div>}
      {check.verdicts?.map(v => (
        <div key={v.soul} className={`rp-tagcheck-verdict rp-tagcheck-${v.verdict}`}>
          <span className="rp-tagcheck-verdict-badge">{v.verdict}</span>{' '}
          <span className="rp-tagcheck-soul">{v.soul}</span>
          {v.cited
            ? <> — <q className="rp-tagcheck-cited">{v.cited}</q></>
            : v.verdict !== 'consistent' && <span className="rp-tagcheck-uncited"> (no verified citation)</span>}
          {v.reason && <div className="rp-tagcheck-reason">{v.reason}</div>}
        </div>
      ))}
    </div>
  );
}
