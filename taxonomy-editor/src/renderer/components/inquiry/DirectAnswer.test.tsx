// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/286 (Design rulings, t/286#14): wording, the topic-differs rule, empty text, plain text.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DirectAnswerBlock, DebatedTopicLine, agreementLabel, shownDebatedTopic } from './DirectAnswer';

afterEach(cleanup);

describe('agreementLabel', () => {
  it('maps consensus to "Camps agree" and the schema value split to "Camps disagree"', () => {
    expect(agreementLabel('consensus')).toBe('Camps agree');
    expect(agreementLabel('split')).toBe('Camps disagree');
  });
  it('gives no label for an absent or unknown agreement', () => {
    expect(agreementLabel(undefined)).toBeUndefined();
    expect(agreementLabel('maybe')).toBeUndefined();
  });
});

describe('shownDebatedTopic', () => {
  it('hides a topic that is the question after trim and lower-casing', () => {
    expect(shownDebatedTopic('What counts as an AI harm?', '  what COUNTS as an ai harm?  ')).toBeUndefined();
  });
  it('hides an absent or blank topic', () => {
    expect(shownDebatedTopic('q?', undefined)).toBeUndefined();
    expect(shownDebatedTopic('q?', '   ')).toBeUndefined();
  });
  it('shows a different topic, trimmed', () => {
    expect(shownDebatedTopic('Should labs publish evals?', ' Whether labs should be licensed ')).toBe('Whether labs should be licensed');
  });
});

describe('DirectAnswerBlock', () => {
  it('renders the tag on its own element before the answer paragraph', () => {
    const { container } = render(<DirectAnswerBlock directAnswer={{ text: 'Yes, with limits.', agreement: 'consensus' }} />);
    const tag = screen.getByText('Camps agree');
    const text = screen.getByText('Yes, with limits.');
    expect(tag.nextElementSibling).toBe(text);
    expect(container.querySelector('h1,h2,h3')).toBeNull();
  });
  it('renders the paragraph without a tag when agreement is absent', () => {
    render(<DirectAnswerBlock directAnswer={{ text: 'Yes.' }} />);
    expect(screen.getByText('Yes.')).toBeTruthy();
    expect(screen.queryByText(/Camps/)).toBeNull();
  });
  it('renders nothing, tag included, for empty or whitespace text', () => {
    const a = render(<DirectAnswerBlock directAnswer={{ text: '   ', agreement: 'split' }} />);
    expect(a.container.innerHTML).toBe('');
    const b = render(<DirectAnswerBlock directAnswer={undefined} />);
    expect(b.container.innerHTML).toBe('');
  });
  it('shows markdown as plain text', () => {
    render(<DirectAnswerBlock directAnswer={{ text: '**Yes** and _no_', agreement: 'split' }} />);
    expect(screen.getByText('**Yes** and _no_')).toBeTruthy();
  });
});

describe('DebatedTopicLine', () => {
  it('renders "The debate addressed: {topic}" for a different topic', () => {
    render(<DebatedTopicLine question="q?" debatedTopic="A neighbouring question" />);
    expect(screen.getByText('The debate addressed: A neighbouring question')).toBeTruthy();
  });
  it('renders nothing when the topic repeats the question', () => {
    const { container } = render(<DebatedTopicLine question="Q?" debatedTopic="q?" />);
    expect(container.innerHTML).toBe('');
  });
});
