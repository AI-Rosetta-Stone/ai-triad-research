// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('./chartTooltip.css', () => ({}));

const { ChartTooltipLayer, useChartTooltip } = await import('./chartTooltip');

describe('chartTooltip (t/894)', () => {
  it('renders nothing when inactive', () => {
    const { container } = render(<ChartTooltipLayer tip={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders content and clamps left to the viewport', () => {
    render(<ChartTooltipLayer tip={{ x: 5, y: 200, content: 'hello' }} />);
    const el = screen.getByRole('tooltip');
    expect(el).toHaveTextContent('hello');
    // x=5 is clamped up to margin(8)+halfWidth(95) = 103 (jsdom innerWidth = 1024)
    expect(el.style.left).toBe('103px');
    expect(el.style.transform).toBe('translate(-50%, -100%)'); // above cursor by default
  });

  it('flips below the cursor near the top edge', () => {
    render(<ChartTooltipLayer tip={{ x: 500, y: 10, content: 'x' }} />);
    const el = screen.getByRole('tooltip');
    expect(el.style.top).toBe('26px'); // y(10) + 16 when flipped below
    // jsdom 30 serializes the 0 y-offset; jsdom 31 drops it
    expect(el.style.transform).toMatch(/^translate\(-50%(, 0(px)?)?\)$/);
  });

  it('shows on showTip and clears on hideTip (no stuck tooltip)', () => {
    function Harness() {
      const { tip, showTip, hideTip } = useChartTooltip();
      return (
        <>
          <button onClick={() => showTip({ clientX: 300, clientY: 300 }, 'tip!')}>show</button>
          <button onClick={hideTip}>hide</button>
          <ChartTooltipLayer tip={tip} />
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByText('show'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('tip!');
    fireEvent.click(screen.getByText('hide'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
