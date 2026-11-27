// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TranscriptOutline, type OutlineTranscriptEntry } from './TranscriptOutline';

afterEach(cleanup);

const entry = (id: string, type: string, speaker?: string): OutlineTranscriptEntry => ({ id, type, speaker });

describe('TranscriptOutline', () => {
  it('renders nothing when the transcript has no outline anchors', () => {
    const { container } = render(<TranscriptOutline transcript={[entry('c1', 'clarification'), entry('s1', 'system')]} />);
    expect(container.firstChild).toBeNull();
  });

  it('derives phase sections and rounds (speaker-cycle heuristic) in transcript order', () => {
    const transcript: OutlineTranscriptEntry[] = [
      entry('o1', 'opening', 'acc'),
      entry('o2', 'opening', 'saf'),
      // Round 1: acc, saf, skp
      entry('d1', 'statement', 'acc'),
      entry('d2', 'statement', 'saf'),
      entry('d3', 'statement', 'skp'),
      // acc repeats -> Round 2
      entry('d4', 'statement', 'acc'),
      entry('d5', 'cross_respond', 'saf'),
      entry('y1', 'synthesis', 'acc'),
    ];
    render(<TranscriptOutline transcript={transcript} />);
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    expect(labels).toEqual([
      'Synthesis',
      'Opening Statements',
      'Cross-Examination',
      'Round 1',
      'Round 2',
    ]);
  });

  it('scrolls to the first entry of a section/round when clicked', () => {
    const scrollIntoView = vi.fn();
    const getById = vi.spyOn(document, 'getElementById').mockReturnValue({ scrollIntoView } as unknown as HTMLElement);
    const transcript: OutlineTranscriptEntry[] = [
      entry('d1', 'statement', 'acc'),
      entry('d2', 'statement', 'saf'),
      entry('d3', 'statement', 'acc'), // acc repeats -> Round 2 anchored at d3
    ];
    render(<TranscriptOutline transcript={transcript} />);
    fireEvent.click(screen.getByText('Round 2'));
    expect(getById).toHaveBeenCalledWith('debate-entry-d3');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    getById.mockRestore();
  });

  it('starts a fresh round numbering for a new debate section', () => {
    const transcript: OutlineTranscriptEntry[] = [
      entry('d1', 'statement', 'acc'),
      entry('o1', 'opening', 'acc'), // section change interrupts debate
      entry('d2', 'statement', 'acc'), // new debate section -> Round 1 again
    ];
    render(<TranscriptOutline transcript={transcript} />);
    const rounds = screen.getAllByRole('button').map(b => b.textContent).filter(t => t?.startsWith('Round'));
    expect(rounds).toEqual(['Round 1', 'Round 1']);
  });

  it('adds a grouped "Fact Check" section with numbered sub-items when fact-checks exist (t/2275)', () => {
    const transcript: OutlineTranscriptEntry[] = [
      entry('o1', 'opening', 'acc'),
      entry('y1', 'synthesis', 'acc'),
      entry('f1', 'fact-check', 'system'),
      entry('f2', 'fact-check', 'system'),
    ];
    render(<TranscriptOutline transcript={transcript} />);
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    expect(labels).toEqual(['Synthesis', 'Opening Statements', 'Fact Check', 'Fact Check 1', 'Fact Check 2']);
  });

  it('renders no "Fact Check" section when the debate has zero fact-checks (t/2275)', () => {
    const transcript: OutlineTranscriptEntry[] = [
      entry('o1', 'opening', 'acc'),
      entry('y1', 'synthesis', 'acc'),
    ];
    render(<TranscriptOutline transcript={transcript} />);
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    expect(labels.some(l => l?.startsWith('Fact Check'))).toBe(false);
  });

  it('groups fact-checks after Synthesis even when interleaved among debate turns (t/2275)', () => {
    const transcript: OutlineTranscriptEntry[] = [
      entry('d1', 'statement', 'acc'),
      entry('f1', 'fact-check', 'system'), // interleaved mid-debate
      entry('d2', 'statement', 'saf'),
      entry('y1', 'synthesis', 'acc'),
      entry('f2', 'fact-check', 'system'),
    ];
    render(<TranscriptOutline transcript={transcript} />);
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    // Synthesis leads (t/826); the Fact Check section is appended last despite f1 being interleaved.
    expect(labels).toEqual(['Synthesis', 'Cross-Examination', 'Round 1', 'Fact Check', 'Fact Check 1', 'Fact Check 2']);
  });

  it('anchors a fact-check sub-item to its transcript entry id (t/2275)', () => {
    const scrollIntoView = vi.fn();
    const getById = vi.spyOn(document, 'getElementById').mockReturnValue({ scrollIntoView } as unknown as HTMLElement);
    const transcript: OutlineTranscriptEntry[] = [
      entry('y1', 'synthesis', 'acc'),
      entry('f1', 'fact-check', 'system'),
      entry('f2', 'fact-check', 'system'),
    ];
    render(<TranscriptOutline transcript={transcript} />);
    fireEvent.click(screen.getByText('Fact Check 2'));
    expect(getById).toHaveBeenCalledWith('debate-entry-f2');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    getById.mockRestore();
  });
});
