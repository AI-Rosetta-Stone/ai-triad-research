// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4532: the shared collapse header used by Steelman Vulnerability and Intellectual Lineage.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleSection } from './CollapsibleSection';

describe('CollapsibleSection', () => {
  it('collapsed by default: children not rendered, chevron ▸, aria-expanded false', () => {
    render(
      <CollapsibleSection title="Steelman Vulnerability" sectionId="x" expanded={false} onToggle={vi.fn()}>
        <div>body content</div>
      </CollapsibleSection>,
    );
    expect(screen.queryByText('body content')).toBeNull();
    const header = screen.getByRole('button', { name: /Steelman Vulnerability/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header.textContent).toContain('▸');
  });

  it('expanded: children render, chevron ▾, aria-expanded true, aria-controls matches the body id', () => {
    render(
      <CollapsibleSection title="Intellectual Lineage" sectionId="y" expanded onToggle={vi.fn()}>
        <div>body content</div>
      </CollapsibleSection>,
    );
    expect(screen.getByText('body content')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /Intellectual Lineage/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header.textContent).toContain('▾');
    expect(header.getAttribute('aria-controls')).toBe(screen.getByText('body content').parentElement!.id);
  });

  it('clicking the header calls onToggle', () => {
    const onToggle = vi.fn();
    render(
      <CollapsibleSection title="Steelman Vulnerability" sectionId="x" expanded={false} onToggle={onToggle}>
        <div>body</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Steelman Vulnerability/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
