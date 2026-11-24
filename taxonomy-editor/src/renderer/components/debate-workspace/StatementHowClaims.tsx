// t/469: the claim rows of the per-statement HOW (docs/ux/debate-statement-how.md): a claim, and its
// attacks and supports, collapsed to three per claim with "Show N more". Claims are labelled by their
// argument-graph node id (AN-n, or the node's own id for D-n and user-seed-n).

import { lazy, Suspense, useState } from 'react';
import { collapseItems, type StatementHowClaim, type StatementHowItem } from './statementHow';
// Loaded on first open, so this module does not evaluate the taxonomy-store chain on render.
const TaxNodeDetail = lazy(() => import('../shared/TaxNodeDetail').then(m => ({ default: m.TaxNodeDetail })));

const COLLAPSE_AT = 3;

const POV_LABEL: Record<NonNullable<StatementHowItem['speaker']>, string> = {
  accelerationist: 'Accelerationist',
  safetyist: 'Safetyist',
  skeptic: 'Skeptic',
};

/** "AN-34 ATTACKED by Safetyist AN-42", or "AN-34 ATTACKED by AN-42" when the attacker is not a POV speaker. */
export function pairLabel(claimId: string, item: StatementHowItem): string {
  const verb = item.kind === 'attacks' ? 'ATTACKED' : 'SUPPORTED';
  const by = item.speaker ? `${POV_LABEL[item.speaker]} ${item.id}` : item.id;
  return `${claimId} ${verb} by ${by}`;
}

/** One claim and its attacks and supports. The first three are shown; the rest sit behind "Show N more".
 *  The anchor chip (the claim's first taxonomy reference, as on Openings) toggles the node detail inline. */
export function ClaimRow({ claim }: { claim: StatementHowClaim }) {
  const [expanded, setExpanded] = useState(false);
  const [anchorOpen, setAnchorOpen] = useState(false);
  const items: StatementHowItem[] = [...claim.attacks, ...claim.supports];
  const { shown, hidden } = collapseItems(items, COLLAPSE_AT);
  const visible = expanded ? items : shown;
  const claimId = claim.node.id;
  const anchor = (claim.node.taxonomy_refs ?? [])[0] as string | undefined;
  return (
    <li className="claim-map-row">
      <div className="claim-map-claim-col">
        <div className="claim-map-claim-card">
          <div className="claim-map-claim-badge">{claimId}</div>
          <p className="claim-map-claim-point">{claim.node.text ?? ''}</p>
          {anchor && (
            <button
              type="button"
              className="claim-map-anchor-chip"
              aria-expanded={anchorOpen}
              onClick={() => setAnchorOpen(o => !o)}
            >
              {anchor}
            </button>
          )}
        </div>
        {anchorOpen && anchor && (
          <Suspense fallback={null}>
            <TaxNodeDetail nodeId={anchor} onClose={() => setAnchorOpen(false)} />
          </Suspense>
        )}
      </div>
      <div className="sh-item-col" role="group" aria-label={items.length === 0 ? `No attack mapped to ${claimId}` : `Attacks and supports on ${claimId}`}>
        {items.length === 0 && (
          <div className="claim-map-no-attack">
            <p className="claim-map-no-attack-title">No attack mapped to {claimId}</p>
          </div>
        )}
        {visible.map(item => <HowItemCard key={item.id} item={item} claimId={claimId} />)}
        {!expanded && hidden > 0 && (
          <button type="button" className="sh-show-more" aria-expanded={false} onClick={() => setExpanded(true)}>
            Show {hidden} more
          </button>
        )}
      </div>
    </li>
  );
}

function HowItemCard({ item, claimId }: { item: StatementHowItem; claimId: string }) {
  if (item.kind === 'attacks') {
    return (
      <div className="claim-map-attack-card">
        <div className="claim-map-attack-eyebrow">{pairLabel(claimId, item)}</div>
        <p className="claim-map-attack-text">{item.text}</p>
        <div className="claim-map-attack-footer">
          <span className="claim-map-attack-status">Unverified</span>
        </div>
      </div>
    );
  }
  return (
    <div className="sh-support-card">
      <div className="sh-support-eyebrow">{pairLabel(claimId, item)}</div>
      <p className="sh-support-text">{item.text}</p>
    </div>
  );
}
