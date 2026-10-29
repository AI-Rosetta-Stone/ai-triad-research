// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4543: the Rosetta Stone tool is the app's launch view (PI decision, t/4541#1). These
// tests cover the content that replaces the retired OnboardingTour and the hand-off into
// each other tool via the feature cards.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSetActiveTab = vi.fn();
const mockOpenSettings = vi.fn();

vi.mock('../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: { setActiveTab: typeof mockSetActiveTab }) => unknown) =>
    selector({ setActiveTab: mockSetActiveTab }),
}));

vi.mock('../hooks/useSettingsDialog', () => ({
  useSettingsDialog: (selector: (s: { open: typeof mockOpenSettings }) => unknown) =>
    selector({ open: mockOpenSettings }),
}));

import { RosettaStoneTab } from './RosettaStoneTab';

describe('RosettaStoneTab (t/4543)', () => {
  beforeEach(() => {
    mockSetActiveTab.mockClear();
    mockOpenSettings.mockClear();
  });

  it('renders the hero title and the specimen question with all three POV voices', () => {
    render(<RosettaStoneTab />);
    expect(screen.getByText('AI Rosetta Stone')).toBeInTheDocument();
    expect(screen.getByText(/Should frontier AI development slow down\?/)).toBeInTheDocument();
    expect(screen.getByText('Accelerationist')).toBeInTheDocument();
    expect(screen.getByText('Safetyist')).toBeInTheDocument();
    expect(screen.getByText('Skeptic')).toBeInTheDocument();
  });

  // t/4632: PI asked to remove the eyebrow, move the tagline beside the title, and add a
  // closing line below the Skeptic row. Title/tagline text itself is unchanged.
  it('t/4632: has no eyebrow, keeps the title and tagline text, and shows the specimen coda', () => {
    render(<RosettaStoneTab />);
    expect(screen.queryByText('AI Triad Research · Berkman Klein Center')).not.toBeInTheDocument();
    expect(screen.getByText('AI Rosetta Stone')).toBeInTheDocument();
    expect(screen.getByText('The goal is NOT to PROVIDE ANSWERS.')).toBeInTheDocument();
    expect(screen.getByText('The goal is to PROVOKE THINKING.')).toBeInTheDocument();
    expect(screen.getByText('The issue isn’t what was said, but why.')).toBeInTheDocument();
  });

  it('t/4632: the coda renders after the Skeptic row, inside the specimen card', () => {
    render(<RosettaStoneTab />);
    const skeptic = screen.getByText('Skeptic').closest('li');
    const specimen = skeptic!.closest('.rosetta-tab-specimen');
    const coda = screen.getByText('The issue isn’t what was said, but why.');
    expect(specimen).toContainElement(coda);
    const children = Array.from(specimen!.children);
    const voicesList = skeptic!.closest('ul');
    // coda is itself a direct child of specimen (not wrapped), so compare it directly —
    // not coda.parentElement, which is specimen and therefore never a child of itself.
    expect(children.indexOf(voicesList!)).toBeLessThan(children.indexOf(coda));
  });

  it('renders the Who it’s for section above What you can do here (t/4542 follow-up)', () => {
    render(<RosettaStoneTab />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    const whoIdx = headings.indexOf('Who it’s for');
    const doIdx = headings.indexOf('What you can do here');
    expect(whoIdx).toBeGreaterThanOrEqual(0);
    expect(doIdx).toBeGreaterThan(whoIdx);
  });

  it('lists all 7 candidate users verbatim (PI follow-up request)', () => {
    render(<RosettaStoneTab />);
    expect(screen.getByText('Policy makers / congressional staff')).toBeInTheDocument();
    expect(screen.getByText('Journalists covering AI policy')).toBeInTheDocument();
    expect(screen.getByText('Academic researchers (AI safety/governance)')).toBeInTheDocument();
    expect(screen.getByText('Think tank analysts')).toBeInTheDocument();
    expect(screen.getByText(/AI lab policy.*trust.*safety teams/)).toBeInTheDocument();
    expect(screen.getByText('Educators / debate coaches')).toBeInTheDocument();
    expect(screen.getByText('Grant-makers / philanthropy program officers')).toBeInTheDocument();
  });

  it('renders the 6 feature cards in rail order ending with Bring Your Own AI Key', () => {
    const { container } = render(<RosettaStoneTab />);
    const cardsSection = container.querySelector('.rosetta-tab-cards');
    expect(cardsSection).not.toBeNull();
    const headings = within(cardsSection as HTMLElement)
      .getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(headings).toEqual([
      'Chat with Perspectives', 'Op-Ed Studies', 'Ask a Question',
      'Run AI Debates', 'Explore the Taxonomy', 'Bring Your Own AI Key',
    ]);
  });

  it('routes the Chat card to the chat tab', async () => {
    render(<RosettaStoneTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Chat' }));
    expect(mockSetActiveTab).toHaveBeenCalledWith('chat');
  });

  it('routes the Taxonomy card to the accelerationist tab', async () => {
    render(<RosettaStoneTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Taxonomy' }));
    expect(mockSetActiveTab).toHaveBeenCalledWith('accelerationist');
  });

  it('routes the Bring Your Own AI Key card to Settings → API Keys, not a tab switch', async () => {
    render(<RosettaStoneTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(mockOpenSettings).toHaveBeenCalledWith('apiKeys');
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });
});
