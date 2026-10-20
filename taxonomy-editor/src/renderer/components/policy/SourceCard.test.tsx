// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336 (t/4333 scope addition): the source card. Missing fields omitted; only http(s) links.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SourceCardMeta } from '../../../../../lib/sourceIndex/types';

const openExternal = vi.hoisted(() => vi.fn());
vi.mock('@bridge', () => ({ api: { openExternal } }));

const { SourceCard, safeExternalUrl } = await import('./SourceCard');

const card = (over: Partial<SourceCardMeta> = {}): SourceCardMeta => ({
  title: 'AI Governance Report', url: 'https://example.org/report', authors: ['A. Author', 'B. Writer'],
  datePublished: '2025-06-01', topicTags: ['governance', 'compute'], oneLiner: 'Argues for open development.', ...over,
});

beforeEach(() => { openExternal.mockClear(); });

describe('safeExternalUrl', () => {
  it('allows http and https', () => {
    expect(safeExternalUrl('https://example.org/x')).toBe('https://example.org/x');
    expect(safeExternalUrl('http://example.org/x')).toBe('http://example.org/x');
  });
  it('refuses every other scheme, unparseable strings and empties', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'not a url', '', null, undefined]) {
      expect(safeExternalUrl(bad as string | null)).toBeNull();
    }
  });
});

describe('SourceCard', () => {
  it('renders every field when present, and opens the link through the bridge', () => {
    render(<SourceCard card={card()} />);
    expect(screen.getByText('AI Governance Report')).toBeInTheDocument();
    expect(screen.getByText('A. Author, B. Writer')).toBeInTheDocument();
    expect(screen.getByText('2025-06-01')).toBeInTheDocument();
    expect(screen.getByText('governance')).toBeInTheDocument();
    expect(screen.getByText('Argues for open development.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'https://example.org/report' }));
    expect(openExternal).toHaveBeenCalledWith('https://example.org/report');
  });

  it('omits missing fields entirely', () => {
    render(<SourceCard card={card({ url: null, authors: [], datePublished: '', topicTags: [], oneLiner: null })} />);
    expect(screen.getByText('AI Governance Report')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('.source-card-byline')).toBeNull();
    expect(document.querySelector('.source-card-tags')).toBeNull();
    expect(document.querySelector('.source-card-oneliner')).toBeNull();
  });

  it('a javascript: or file: URL is plain text, never a link', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd']) {
      const { unmount } = render(<SourceCard card={card({ url: bad })} />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText(bad)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders metadata as text, never as HTML', () => {
    render(<SourceCard card={card({ title: '<img src=x onerror=alert(1)>' })} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('.source-card img')).toBeNull();
  });
});
