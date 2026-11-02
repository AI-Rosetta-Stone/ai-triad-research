// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4724 (AC2): each rich block's detection fires when the markdown shape fits and falls back
// to plain markdown otherwise. Exercised two ways: the pure detection functions directly against
// constructed React trees (fast, no DOM), and one integration pass per block through the real
// `react-markdown` pipeline with `MarkdownOl`/`MarkdownP` wired in, so the wiring itself — not
// just the detection logic — is covered.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  isCardList, isEyebrowParagraph, isDidYouKnowParagraph, MarkdownOl, MarkdownP, MarkdownHeading,
} from './markdownBlocks';

function renderMd(md: string) {
  return render(<Markdown remarkPlugins={[remarkGfm]} components={{ ol: MarkdownOl, p: MarkdownP, h3: MarkdownHeading }}>{md}</Markdown>);
}

describe('isCardList', () => {
  it('fits: every item starts with a bold lead-in', () => {
    const { container } = renderMd(
      '1. **Grid reliability:** keep the lights on.\n2. **Water limits:** use less of it.\n',
    );
    expect(container.querySelector('.chat-option-cards')).toBeInTheDocument();
    expect(container.querySelectorAll('.chat-option-card')).toHaveLength(2);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('Grid reliability:')).toBeInTheDocument();
  });

  it('falls back: a plain list with no bold lead-ins renders as a normal <ol>', () => {
    const { container } = renderMd('1. First item.\n2. Second item.\n');
    expect(container.querySelector('.chat-option-cards')).toBeNull();
    expect(container.querySelector('ol')).toBeInTheDocument();
  });

  it('falls back: only some items have a bold lead-in', () => {
    const { container } = renderMd('1. **Bold one:** text.\n2. Plain item, no lead-in.\n');
    expect(container.querySelector('.chat-option-cards')).toBeNull();
    expect(container.querySelector('ol')).toBeInTheDocument();
  });

  it('isCardList: empty list is not a card list', () => {
    expect(isCardList([])).toBe(false);
  });
});

describe('isEyebrowParagraph / eyebrow heading', () => {
  it('fits: a paragraph that is entirely one bold run', () => {
    const { container } = renderMd('**The Foundational Reality: The Job Yield Deficit**');
    const eyebrow = container.querySelector('.chat-eyebrow-heading');
    expect(eyebrow).toBeInTheDocument();
    expect(eyebrow).toHaveTextContent('The Foundational Reality: The Job Yield Deficit');
  });

  it('falls back: a bold phrase inside otherwise-plain prose stays a normal paragraph', () => {
    const { container } = renderMd('This sentence has **a bold phrase** in the middle.');
    expect(container.querySelector('.chat-eyebrow-heading')).toBeNull();
    expect(screen.getByText(/This sentence has/)).toBeInTheDocument();
  });

  it('isEyebrowParagraph: plain text children is not an eyebrow', () => {
    expect(isEyebrowParagraph('plain text')).toBe(false);
  });

  it('a real markdown heading (### ...) also gets the eyebrow treatment unconditionally', () => {
    const { container } = renderMd('### The Foundational Reality: The Job Yield Deficit');
    const eyebrow = container.querySelector('.chat-eyebrow-heading');
    expect(eyebrow).toBeInTheDocument();
    expect(container.querySelector('h3')).toBeNull();
  });
});

describe('isDidYouKnowParagraph / stat callout', () => {
  it('fits: a paragraph led by the exact italic phrase "Did you know?"', () => {
    const { container } = renderMd('*Did you know?* Google has invested over $5 billion.');
    const callout = container.querySelector('.chat-dyk-callout');
    expect(callout).toBeInTheDocument();
    expect(callout).toHaveTextContent('Did you know?');
    expect(callout).toHaveTextContent('Google has invested over $5 billion.');
  });

  it('falls back: a different italic lead is not treated as the callout', () => {
    const { container } = renderMd('*Fun fact:* data centers use a lot of water.');
    expect(container.querySelector('.chat-dyk-callout')).toBeNull();
  });

  it('isDidYouKnowParagraph: non-element first child is not a match', () => {
    expect(isDidYouKnowParagraph('plain text')).toBe(false);
  });
});
