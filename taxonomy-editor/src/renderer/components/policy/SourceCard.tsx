// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336 (t/4333 scope addition, PI): the card at the top of an expanded document: title, link, authors,
// date published, topic tags and a one-line summary. Missing fields are omitted, not shown empty. Only an
// http: or https: URL becomes a link, opened through the bridge; anything else is plain text. Every field
// renders as React text, never HTML.

import { api } from '@bridge';
import type { SourceCardMeta } from '../../../../../lib/sourceIndex/types';
import './SourceCard.css';

/** The URL if it's safe to open (http: or https:), or null. Never throws. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  // URL.canParse first, so an unparseable metadata string is simply not a link (no throw/catch per render).
  if (!url || !URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === 'http:' || protocol === 'https:' ? url : null;
}

export function SourceCard({ card }: { card: SourceCardMeta }) {
  const href = safeExternalUrl(card.url);
  const authors = card.authors.filter(a => a.trim());
  const tags = card.topicTags.filter(t => t.trim());
  return (
    <div className="source-card" aria-label="Source details">
      {card.title && <div className="source-card-title">{card.title}</div>}
      {href ? (
        <a
          className="source-card-url"
          href={href}
          onClick={(e) => { e.preventDefault(); void api.openExternal(href); }}
        >{href}</a>
      ) : card.url && <div className="source-card-url source-card-url-plain">{card.url}</div>}
      {(authors.length > 0 || card.datePublished) && (
        <div className="source-card-byline">
          {authors.length > 0 && <span className="source-card-authors">{authors.join(', ')}</span>}
          {authors.length > 0 && card.datePublished && <span aria-hidden="true"> · </span>}
          {card.datePublished && <span className="source-card-date">{card.datePublished}</span>}
        </div>
      )}
      {tags.length > 0 && (
        <div className="source-card-tags">
          {tags.map(t => <span key={t} className="source-card-tag">{t}</span>)}
        </div>
      )}
      {card.oneLiner && <div className="source-card-oneliner">{card.oneLiner}</div>}
    </div>
  );
}
