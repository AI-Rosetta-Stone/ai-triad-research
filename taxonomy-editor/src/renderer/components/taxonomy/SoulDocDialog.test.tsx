// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4200: the soul-document dialog shows one tab per Skeptic soul (base, Critical, Institutional), from the real
// tag registry and the real bundled souls. Camps without tags keep the old tab-less layout.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const record = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

// The registry is real unless a test adds a tag with no soul file behind it.
let extraSkepticTag: { id: string; label: string; soul_doc: string; description: string } | null = null;
vi.mock('@lib/schema/povTags', async (importOriginal) => {
  const real = await importOriginal<typeof import('@lib/schema/povTags')>();
  return {
    ...real,
    loadPovTagRegistry: () => {
      const reg = real.loadPovTagRegistry();
      if (!extraSkepticTag) return reg;
      return { ...reg, povs: { ...reg.povs, skeptic: [...(reg.povs.skeptic ?? []), extraSkepticTag] } };
    },
  };
});

const { SoulDocDialog } = await import('./SoulDocDialog');

const BASE_FIRST_VALUE = /^Observed over projected/;
const CRITICAL_FIRST_VALUE = /^Power accountability/;
const INSTITUTIONAL_FIRST_VALUE = /^Deployment evidence over capability evidence/;

const tabNames = () => screen.queryAllByRole('tab').map(t => t.textContent);
const selectedTab = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent;
const firstValue = (container: HTMLElement) => container.querySelector('ol.soul-doc-list li')?.textContent ?? '';

describe('SoulDocDialog (t/4200)', () => {
  beforeEach(() => { extraSkepticTag = null; record.mockClear(); });

  it('Skeptic shows three tabs in registry order: base, Critical, Institutional', () => {
    render(<SoulDocDialog pov="skeptic" onClose={vi.fn()} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(tabNames()).toEqual(['Skeptic', 'Critical', 'Institutional']);
  });

  it.each(['accelerationist', 'safetyist'])('%s has no tags, so no tab strip (the old layout)', (pov) => {
    const { container } = render(<SoulDocDialog pov={pov} onClose={vi.fn()} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(container.querySelector('.soul-doc-personality')?.textContent).toBeTruthy();
  });

  it('each tab shows its own soul: the value hierarchies differ, and a tag tab shows its description', () => {
    const { container } = render(<SoulDocDialog pov="skeptic" onClose={vi.fn()} />);
    expect(firstValue(container)).toMatch(BASE_FIRST_VALUE);
    expect(container.querySelector('.soul-doc-tab-description')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Critical' }));
    expect(firstValue(container)).toMatch(CRITICAL_FIRST_VALUE);
    expect(container.querySelector('.soul-doc-tab-description')?.textContent).toMatch(/overhyped/);

    fireEvent.click(screen.getByRole('tab', { name: 'Institutional' }));
    expect(firstValue(container)).toMatch(INSTITUTIONAL_FIRST_VALUE);
  });

  it('a node tagged institutional opens on the Institutional tab', () => {
    const { container } = render(<SoulDocDialog pov="skeptic" nodeTags={['institutional']} onClose={vi.fn()} />);
    expect(selectedTab()).toBe('Institutional');
    expect(firstValue(container)).toMatch(INSTITUTIONAL_FIRST_VALUE);
  });

  it('an untagged node, or one whose tag has no tab, opens on the base tab', () => {
    const { unmount } = render(<SoulDocDialog pov="skeptic" onClose={vi.fn()} />);
    expect(selectedTab()).toBe('Skeptic');
    unmount();
    render(<SoulDocDialog pov="skeptic" nodeTags={['not-a-tag']} onClose={vi.fn()} />);
    expect(selectedTab()).toBe('Skeptic');
  });

  it('a tag whose soul file is missing shows the not-found message and records a warn, without throwing', () => {
    extraSkepticTag = { id: 'ghost', label: 'Ghost', soul_doc: 'skeptic.ghost', description: 'No soul file behind this tag.' };
    render(<SoulDocDialog pov="skeptic" nodeTags={['ghost']} onClose={vi.fn()} />);
    expect(selectedTab()).toBe('Ghost');
    expect(screen.getByRole('alert').textContent).toMatch(/Soul document not found: skeptic\.ghost\.soul\.json/);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', component: 'soul-doc-dialog' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Critical' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tabs follow the ARIA pattern: one selected, roving tabindex, arrow keys wrap', () => {
    render(<SoulDocDialog pov="skeptic" onClose={vi.fn()} />);
    const [base, critical, institutional] = screen.getAllByRole('tab');
    expect([base, critical, institutional].map(t => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    fireEvent.keyDown(base, { key: 'ArrowRight' });
    expect(selectedTab()).toBe('Critical');
    expect(document.activeElement).toBe(critical);
    fireEvent.keyDown(critical, { key: 'ArrowLeft' });
    fireEvent.keyDown(base, { key: 'ArrowLeft' });
    expect(selectedTab()).toBe('Institutional');
    fireEvent.keyDown(institutional, { key: 'Home' });
    expect(selectedTab()).toBe('Skeptic');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(base.id);
  });

  it('closes from the close button and the overlay, not from a click inside the dialog', () => {
    const onClose = vi.fn();
    const { container } = render(<SoulDocDialog pov="skeptic" onClose={onClose} />);
    fireEvent.click(container.querySelector('.soul-doc-dialog')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(container.querySelector('.dialog-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
