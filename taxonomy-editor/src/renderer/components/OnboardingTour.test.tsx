// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4183: the intro tour opens on the AI Rosetta Stone hero (the copy shared with the login page), with the PI's
// tagline. The other four steps, the pager, Next/Skip and the "seen" flag behave as before.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('./settings/SettingsDialog', () => ({ SettingsDialog: () => <div data-testid="settings-dialog" /> }));

const { OnboardingTour } = await import('./OnboardingTour');

const STORAGE_KEY = 'taxonomy-editor-onboarding-dismissed';

describe('OnboardingTour (t/4183)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has five steps, so the pager shows five dots', () => {
    render(<OnboardingTour onDismiss={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /^Step \d of 5:/ })).toHaveLength(5);
  });

  it('step 1 is the hero: title, the PI tagline exactly as written, the question and three voices, no screenshot', () => {
    const { container } = render(<OnboardingTour onDismiss={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AI Rosetta Stone');
    expect(container.querySelector('.onboarding-hero-eyebrow')?.textContent).toBe('AI Triad Research · Berkman Klein Center');

    const tagline = [...container.querySelectorAll('.onboarding-hero-tagline span')].map(s => s.textContent);
    expect(tagline).toEqual(['The goal is NOT to PROVIDE ANSWERS.', 'The goal is to PROVOKE THINKING.']);
    expect(container.textContent).not.toMatch(/Three schools of thought/);

    expect(container.querySelector('.onboarding-hero-question')?.textContent).toBe('“Should frontier AI development slow down?”');
    const voices = [...container.querySelectorAll('.onboarding-hero-voice')].map(v => [
      v.querySelector('.onboarding-hero-name')?.textContent,
      v.querySelector('.onboarding-hero-line')?.textContent,
    ]);
    expect(voices).toEqual([
      ['Accelerationist', 'Slowing down surrenders the benefits to whoever doesn’t.'],
      ['Safetyist', 'Speed without verification is how we lose control.'],
      ['Skeptic', 'First show me evidence the premise holds.'],
    ]);
    expect(container.querySelector('img')).toBeNull();
  });

  it('Next goes to the former first step, "Explore the Taxonomy", with its screenshot', () => {
    const { container } = render(<OnboardingTour onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Explore the Taxonomy');
    expect(container.querySelector('img.onboarding-image')).not.toBeNull();
  });

  it('Skip from the hero dismisses and records the tour as seen', () => {
    const onDismiss = vi.fn();
    render(<OnboardingTour onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /Skip tour/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('the last step is still the API-key step, reached after four Nexts', () => {
    render(<OnboardingTour onDismiss={vi.fn()} />);
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      act(() => { vi.advanceTimersByTime(250); });
    }
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Bring Your Own AI Key');
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();
  });
});
