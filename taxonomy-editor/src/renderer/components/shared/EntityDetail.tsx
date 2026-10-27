// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Read-only entity detail renderer (t/1882 §5). Replaces the DetailPane `case 'entity'`
// placeholder. Consumes the landed `Entity` contract from @lib/entities/types (never
// forks it) and mirrors OrganizationDetail's read-mode rhythm: compact identity header
// → hero description → de-emphasized reference/provenance rows. No editing, no JSON, no
// bare IDs in the reading flow (ids live only in the muted provenance footer). The async
// resolve + error/loading/not_found states are owned upstream by resolveRef/DetailPane;
// this component is pure and synchronous over an already-resolved record.

import type { Entity } from '@lib/entities/types';
import { TypeBadge, ExternalLinkRow } from './DetailPrimitives';
import { coerceStringArray } from '@lib/entities/entityResolve';
import './EntityDetail.css';

const STATUS_LABEL: Record<Entity['status'], string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  deprecated: 'Deprecated',
};

/** Humanize a DOLCE category slug for display; the raw value stays on `title=`. */
function humanizeDolce(category: string): string {
  return category.replace(/-/g, ' ');
}

/**
 * Provenance footer — curation/audit metadata (`discovered_by`, `confidence`), muted and
 * below a divider. Each line is assembled from present parts only; when nothing is present
 * the whole footer (and its divider) is omitted rather than rendering "undefined" (AC #4).
 */
function EntityProvenanceFooter({ discovered_by, confidence }: Pick<Entity, 'discovered_by' | 'confidence'>) {
  const discoveredParts: string[] = [];
  if (discovered_by?.model) discoveredParts.push(`Discovered by ${discovered_by.model}`);
  if (discovered_by?.usage_id) discoveredParts.push(`usage ${discovered_by.usage_id}`);
  const discoveredLine = discoveredParts.join(' · ');
  const confidenceLine = typeof confidence === 'number' ? `Confidence ${confidence}` : '';
  if (!discoveredLine && !confidenceLine) return null;
  return (
    <div className="ed-provenance">
      {discoveredLine && <div>{discoveredLine}</div>}
      {confidenceLine && <div>{confidenceLine}</div>}
    </div>
  );
}

export function EntityDetail({ entity, redirectedFrom }: { entity: Entity; redirectedFrom?: string }) {
  const { name, entity_type, dolce_category, aliases, status, description, external_refs, source_refs, discovered_by, confidence } = entity;
  // aliases + source_refs are both polymorphic in real data (array|string|null) despite
  // their string[] types — coerce before render (t/1882#7 / t/1884#4).
  const aliasesArr = coerceStringArray(aliases);
  // t/4451 (t/4404 SO condition C2): both API paths (ServerAPI t/4527, ElectronMain t/4528)
  // already fold a marked duplicate_of copy to its canonical and dedupe before this component
  // ever sees the record — this is a value-dedupe safety net, not the fold itself. It's
  // necessary because the fold resolves to canonical IDs; a canonical plus its own copy in the
  // same list collapse to the same string once folded, which is exactly what this line catches.
  const sourceRefsArr = Array.from(new Set(coerceStringArray(source_refs)));

  return (
    <div className="entity-detail">
      {redirectedFrom && (
        <div className="ed-redirect-note">Redirected from {redirectedFrom}</div>
      )}

      {status === 'deprecated' && (
        <div className="ed-deprecated-banner" role="note">This entity is deprecated.</div>
      )}

      {/* Identity header */}
      <div>
        <div className="ed-header-row">
          <h2 className="ed-title">{name}</h2>
          <TypeBadge type={entity_type} />
          <span className="ed-dolce-chip" title={dolce_category}>{humanizeDolce(dolce_category)}</span>
        </div>
        {aliasesArr.length > 0 && (
          <div className="ed-aliases">also: {aliasesArr.join(', ')}</div>
        )}
        <div className="ed-status-row">
          <span className={`ed-status-pill ed-status-${status}`}>{STATUS_LABEL[status]}</span>
        </div>
      </div>

      {/* Description — hero content */}
      {description && <p className="ed-description">{description}</p>}

      {/* References — external links */}
      {external_refs && external_refs.length > 0 && (
        <div>
          <h3 className="ed-section-h3">References</h3>
          <div className="ed-flex-col-2">
            {external_refs.map((ref, i) => (
              <ExternalLinkRow key={i} url={ref.url} title={ref.label} />
            ))}
          </div>
        </div>
      )}

      {/* Appears in — source docs. Non-interactive labeled chips in P1a: no doc/source
          viewer target exists yet (spec open-Q3), so they are deliberately not clickable
          and not focusable — wiring is a clean follow-up when a target lands. */}
      {sourceRefsArr.length > 0 && (
        <div>
          <h3 className="ed-section-h3">Appears in</h3>
          <div className="ed-source-chips">
            {sourceRefsArr.map((ref, i) => (
              <span key={i} className="ed-source-chip" title={ref}>doc: {ref}</span>
            ))}
          </div>
        </div>
      )}

      {/* Provenance footer — curation/audit metadata, kept out of the reading flow */}
      <EntityProvenanceFooter discovered_by={discovered_by} confidence={confidence} />
    </div>
  );
}
