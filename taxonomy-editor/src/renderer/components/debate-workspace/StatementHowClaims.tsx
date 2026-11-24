// t/469: the claim rows of the per-statement HOW (docs/ux/debate-statement-how.md): a claim, and its
// attacks and supports, collapsed to three per claim with "Show N more".

import { useState } from 'react';
import { collapseItems, type StatementHowClaim, type StatementHowItem } from './statementHow';

const COLLAPSE_AT = 3;

/** One claim and its attacks and supports. The first three are shown; the rest sit behind "Show N more". */
export function ClaimRow({ claim }: { claim: StatementHowClaim }) {
  const [expanded, setExpanded] = useState(false);
  const items: StatementHowItem[] = [...claim.attacks, ...claim.supports];
  const { shown, hidden } = collapseItems(items, COLLAPSE_AT);
  const visible = expanded ? items : shown;
  return (
    <li className="claim-map-row">
      <div className="claim-map-claim-col">
        <div className="claim-map-claim-card">
          <div className="claim-map-claim-badge">C{claim.index}</div>
          <p className="claim-map-claim-point">{claim.node.text ?? ''}</p>
        </div>
      </div>
      <div className="sh-item-col" role="group" aria-label={items.length === 0 ? `No attack mapped to C${claim.index}` : `Attacks and supports on C${claim.index}`}>
        {items.length === 0 && (
          <div className="claim-map-no-attack">
            <p className="claim-map-no-attack-title">No attack mapped to C{claim.index}</p>
          </div>
        )}
        {visible.map(item => <HowItemCard key={item.id} item={item} index={claim.index} />)}
        {!expanded && hidden > 0 && (
          <button type="button" className="sh-show-more" aria-expanded={false} onClick={() => setExpanded(true)}>
            Show {hidden} more
          </button>
        )}
      </div>
    </li>
  );
}

function HowItemCard({ item, index }: { item: StatementHowItem; index: number }) {
  if (item.kind === 'attacks') {
    return (
      <div className="claim-map-attack-card">
        <div className="claim-map-attack-eyebrow">← ATTACK ON C{index}</div>
        <p className="claim-map-attack-text">{item.text}</p>
        <div className="claim-map-attack-footer">
          <span className="claim-map-attack-status">Unverified</span>
        </div>
      </div>
    );
  }
  return (
    <div className="sh-support-card">
      <div className="sh-support-eyebrow">SUPPORTS C{index}</div>
      <p className="sh-support-text">{item.text}</p>
    </div>
  );
}

