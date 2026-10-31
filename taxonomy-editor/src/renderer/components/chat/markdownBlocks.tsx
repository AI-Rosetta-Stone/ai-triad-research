// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4724 Phase 1: restyle three markdown shapes a POVer's reply already produces — no response-
// schema change, no new data from the model. Detection runs on the already-rendered React
// children react-markdown hands a component override (not the mdast/hast node), since that
// keeps both the detection logic and its tests in plain React terms with no AST API to mock.
// Any shape that doesn't match falls through to the default `<ol>`/`<p>` — the plain-markdown
// fallback is structural (same `if` that decides whether to special-case also IS the fallback),
// not a second code path to keep in sync. Phase 2 (bar chart, category tags, headline figures)
// needs actual structured data from the model — out of scope here (TL's response-schema HLD).

import { Children, isValidElement } from 'react';
import type { ReactNode, ReactElement, HTMLAttributes } from 'react';

function meaningfulChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).filter(c => !(typeof c === 'string' && c.trim() === ''));
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

/** A top-level ordered list where every item's first meaningful child is bold — the
 *  `1. **Lead-in:** rest of the sentence` pattern the option cards restyle. */
export function isCardList(children: ReactNode): boolean {
  const items = Children.toArray(children).filter(
    (c): c is ReactElement => isValidElement(c) && c.type === 'li',
  );
  if (items.length === 0) return false;
  return items.every((li) => {
    const first = meaningfulChildren((li.props as { children?: ReactNode }).children)[0];
    return isValidElement(first) && first.type === 'strong';
  });
}

/** A paragraph that is a single bold run and nothing else — "**Section Title**" on its own
 *  line, not a bold phrase inside otherwise-plain prose. */
export function isEyebrowParagraph(children: ReactNode): boolean {
  const kids = meaningfulChildren(children);
  return kids.length === 1 && isValidElement(kids[0]) && kids[0].type === 'strong';
}

/** A paragraph whose first run is the exact italic phrase "Did you know?". */
export function isDidYouKnowParagraph(children: ReactNode): boolean {
  const first = meaningfulChildren(children)[0];
  if (!isValidElement(first) || first.type !== 'em') return false;
  return extractText((first.props as { children?: ReactNode }).children).trim().toLowerCase() === 'did you know?';
}

function CardList({ children }: { children?: ReactNode }) {
  const items = Children.toArray(children).filter(
    (c): c is ReactElement => isValidElement(c) && c.type === 'li',
  );
  return (
    <div className="chat-option-cards" role="list">
      {items.map((li, i) => {
        const [lead, ...rest] = meaningfulChildren((li.props as { children?: ReactNode }).children);
        return (
          <div className="chat-option-card" role="listitem" key={li.key ?? i}>
            <span className="chat-option-card-ordinal">{String(i + 1).padStart(2, '0')}</span>
            <div className="chat-option-card-title">{lead}</div>
            <div className="chat-option-card-body">{rest}</div>
          </div>
        );
      })}
    </div>
  );
}

function DidYouKnowCallout({ children }: { children?: ReactNode }) {
  const [, ...rest] = meaningfulChildren(children);
  return (
    <div className="chat-dyk-callout">
      <span className="chat-dyk-label">Did you know?</span>
      <p className="chat-dyk-body">{rest}</p>
    </div>
  );
}

/** `ol` component override for react-markdown: restyles a bold-lead-in list as option cards,
 *  degrades to a plain `<ol>` for anything else (nested lists, mixed items, non-top-level). */
export function MarkdownOl({ node: _node, children, ...props }: HTMLAttributes<HTMLOListElement> & { node?: unknown }) {
  if (isCardList(children)) return <CardList>{children}</CardList>;
  return <ol {...props}>{children}</ol>;
}

/** `p` component override: restyles an all-bold line (`**Section Title**` on its own, with no
 *  real markdown heading) as a small-caps eyebrow heading, and a "Did you know?"-led paragraph
 *  as a stat callout; everything else renders as a plain `<p>`. */
export function MarkdownP({ node: _node, children, ...props }: HTMLAttributes<HTMLParagraphElement> & { node?: unknown }) {
  if (isEyebrowParagraph(children)) return <p className="chat-eyebrow-heading">{children}</p>;
  if (isDidYouKnowParagraph(children)) return <DidYouKnowCallout>{children}</DidYouKnowCallout>;
  return <p {...props}>{children}</p>;
}

/** `h1`-`h6` override: a reply's own section heading ("### The Foundational Reality…") is
 *  always a section line in this context, never a literal page heading, so it gets the eyebrow
 *  treatment unconditionally — no shape check needed, unlike the bold-paragraph case above,
 *  since being a heading at all is the signal. Covers the same mockup element the bold-paragraph
 *  case does, for whichever form a given reply actually uses. */
export function MarkdownHeading({ node: _node, children }: HTMLAttributes<HTMLHeadingElement> & { node?: unknown }) {
  return <p className="chat-eyebrow-heading">{children}</p>;
}
