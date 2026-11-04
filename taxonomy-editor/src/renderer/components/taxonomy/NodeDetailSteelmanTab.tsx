// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4826 (Design spec §3, docs/ux/node-detail-tab-groups.md): Steelman Vulnerability, promoted
// from a collapsible sub-section of the retired Analysis tab to its own top-level tab. Renders
// expanded (no disclosure header) and always shows, with an empty state when the node has none —
// extracted to its own file (was SteelmanVulnerabilitySection in NodeDetail.tsx) so the promotion
// doesn't push NodeDetail.tsx over its line budget (ADR-007), same reasoning as t/4827's
// NodeDetailRelatedTab extraction.

import { POV_META } from '@lib/electron-shared/povMeta';
import type { PovNode } from '../../types/taxonomy';
import { EmptyState } from '../shared/EmptyState';

interface NodeDetailSteelmanTabProps {
  node: PovNode;
  readOnly?: boolean;
  update: (updates: Partial<PovNode>) => void;
}

const EMPTY_HEADLINE = 'No steelman analysis yet';
const EMPTY_DIRECTION = "This node hasn't been analysed for its strongest counter-case.";

export function NodeDetailSteelmanTab({ node, readOnly, update }: NodeDetailSteelmanTabProps) {
  const vulnerability = node.graph_attributes?.steelman_vulnerability;

  if (typeof vulnerability === 'string') {
    return (
      <div className="form-group">
        {readOnly ? (
          <div className="ga-promoted-text">{vulnerability}</div>
        ) : (
          <textarea
            className="nd-vulnerability-input"
            value={vulnerability}
            rows={3}
            onChange={(e) => {
              update({ graph_attributes: { ...node.graph_attributes!, steelman_vulnerability: e.target.value } });
            }}
          />
        )}
      </div>
    );
  }

  if (typeof vulnerability === 'object' && vulnerability) {
    return (
      <div className="form-group">
        <div className="ga-promoted-text">
          {(['from_accelerationist', 'from_safetyist', 'from_skeptic'] as const).map(key => {
            const vuln = vulnerability as Record<string, string | undefined>;
            const povKey = key.replace('from_', '') as 'accelerationist' | 'safetyist' | 'skeptic';
            const meta = POV_META[povKey];
            // Hide a POV with no vulnerability text in BOTH modes — an empty POV rendered a
            // blank textarea in edit mode (noise). These are AI-populated (POV-node regen), not
            // manually seeded, so hiding an empty one loses nothing; regen repopulates it.
            if (!vuln[key]) return null;
            return (
              <div key={key} className="vulnerability-subsection">
                {/* eslint-disable-next-line local/no-inline-style -- color is per-POV, computed from meta.cssVar */}
                <strong style={{ color: `var(${meta.cssVar})` }}>{meta.label}:</strong>
                {readOnly ? (
                  <span> {vuln[key]}</span>
                ) : (
                  <textarea
                    className="nd-vulnerability-input"
                    value={vuln[key] ?? ''}
                    rows={2}
                    onChange={(e) => {
                      update({ graph_attributes: { ...node.graph_attributes!, steelman_vulnerability: { ...vuln, [key]: e.target.value } } });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // t/4826 spec §3: "both tabs always show... with no data, show the standard EmptyState" —
  // keeps the existing +Add affordance (previously a bare button with no empty-state framing)
  // via EmptyState's own action slot, rather than dropping it.
  return (
    <EmptyState
      headline={EMPTY_HEADLINE}
      direction={EMPTY_DIRECTION}
      action={readOnly || !node.graph_attributes ? undefined : {
        label: '+ Add Vulnerability',
        onClick: () => update({ graph_attributes: { ...node.graph_attributes!, steelman_vulnerability: '' } }),
      }}
    />
  );
}
