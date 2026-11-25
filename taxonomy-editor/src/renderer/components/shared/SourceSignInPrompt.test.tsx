// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/678 (PI decision 5e): where the server says sign-in is required, the source's full text is replaced by the
// sign-in prompt in both places the app shows it, never a raw error, an iframe or an empty pane.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@bridge', () => ({ api: {}, isElectronMode: () => false }));

import { SourceSignInPrompt, SOURCE_SIGN_IN_LINE } from './SourceSignInPrompt';
import { SourceDocumentViewer } from '../taxonomy/NodeDetail';
import { SummaryContentView } from '../analysis/SummariesTab';

const viewProps = {
  viewMode: 'document' as const, keyPoints: [], summary: {} as never, summariesFlag: true,
  snapshot: null, snapshotLoading: false, getLabelForId: (() => '') as never,
  handleNodeClick: () => {}, addUnmappedToTaxonomy: () => {},
};

describe('source full text is sign-in only (t/678)', () => {
  it('the prompt names what stays open and links to both sign-ins', () => {
    render(<SourceSignInPrompt />);
    expect(screen.getByText(SOURCE_SIGN_IN_LINE)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in with GitHub' }).getAttribute('href')).toBe('/api/auth/fresh-login/github');
    expect(screen.getByRole('link', { name: 'Sign in with Google' }).getAttribute('href')).toBe('/api/auth/fresh-login/google');
  });

  it('NodeDetail source viewer: signInRequired shows the prompt, not the text or an iframe', () => {
    const { container } = render(<SourceDocumentViewer doc={{ available: true, type: 'pdf', signInRequired: true }} />);
    expect(screen.getByText(SOURCE_SIGN_IN_LINE)).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('NodeDetail source viewer: a signed-in markdown resolution still shows the text', () => {
    render(<SourceDocumentViewer doc={{ available: true, type: 'markdown', content: 'Full source text.' }} />);
    expect(screen.getByText('Full source text.')).toBeTruthy();
    expect(screen.queryByText(SOURCE_SIGN_IN_LINE)).toBeNull();
  });

  it('Summaries document view: the prompt replaces the "no snapshot" pane on a sign-in refusal', () => {
    render(<SummaryContentView {...viewProps} snapshotSignIn />);
    expect(screen.getByText(SOURCE_SIGN_IN_LINE)).toBeTruthy();
    expect(screen.queryByText('No document snapshot available.')).toBeNull();
  });

  it('Summaries document view: without a refusal, the existing empty state is unchanged', () => {
    render(<SummaryContentView {...viewProps} snapshotSignIn={false} />);
    expect(screen.getByText('No document snapshot available.')).toBeTruthy();
  });
});
