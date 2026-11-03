// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverflowMenu } from './OverflowMenu';

describe('OverflowMenu (t/4574#24 item 3: accessible name)', () => {
  it('has an aria-label, so the accessible name is not just the "…" text content', () => {
    render(<OverflowMenu entries={[{ type: 'item', key: 'a', label: 'A', onClick: () => {} }]} />);
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });
});
