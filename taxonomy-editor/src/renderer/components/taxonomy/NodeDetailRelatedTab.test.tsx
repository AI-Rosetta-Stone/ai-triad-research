// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4827 (PI-reported, portrait monitors): below a container-width breakpoint, the side-by-side
// split squeezes the list and wastes the detail pane on an empty state. Locks the stacked
// class/behavior at a narrow container width, driven by the SPLIT CONTAINER's own width
// (ResizeObserver) — not viewport orientation or width.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRef, act } from 'react';
import { render, screen } from '@testing-library/react';
import { NodeDetailRelatedTab } from './NodeDetailRelatedTab';

vi.mock('../edge-browser/RelatedEdgesPanel', () => ({ RelatedEdgesPanel: () => <div>related list</div> }));
vi.mock('../edge-browser/EdgeDetailPanel', () => ({ EdgeDetailPanel: () => <div>edge detail</div> }));

// jsdom has no ResizeObserver. Stub it to capture the callback so each test can fire it with a
// fake contentRect width, exactly as the real browser API would after layout.
let roCallback: ResizeObserverCallback | null = null;
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) { roCallback = cb; }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function fireResize(width: number) {
  act(() => {
    roCallback?.([{ contentRect: { width } } as ResizeObserverEntry], null as unknown as ResizeObserver);
    vi.advanceTimersByTime(50);
  });
}

describe('NodeDetailRelatedTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    roCallback = null;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderTab(selectedEdge: unknown = null) {
    const splitContainerRef = createRef<HTMLDivElement>();
    const { container } = render(
      <NodeDetailRelatedTab
        selectedEdge={selectedEdge}
        relatedSplitPct={40}
        handleSplitMouseDown={vi.fn()}
        splitContainerRef={splitContainerRef}
      />,
    );
    return container;
  }

  it('renders unstacked (wide) before the first resize measurement', () => {
    const container = renderTab();
    expect(container.querySelector('.node-detail-related-split-stacked')).toBeNull();
    expect(container.querySelector('.resize-handle')).not.toBeNull();
  });

  it('stays unstacked at a wide container width, with the resize handle present', () => {
    const container = renderTab();
    fireResize(900);
    expect(container.querySelector('.node-detail-related-split-stacked')).toBeNull();
  });

  it('stacks below the breakpoint — adds the stacked class and drops the resize handle', () => {
    const container = renderTab();
    fireResize(400);
    expect(container.querySelector('.node-detail-related-split-stacked')).not.toBeNull();
    expect(container.querySelector('.resize-handle')).toBeNull();
  });

  it('stacked with no edge selected: hides the detail pane entirely (no wasted empty-state space)', () => {
    const container = renderTab(null);
    fireResize(400);
    expect(container.querySelector('.node-detail-related-detail')).toBeNull();
    expect(screen.queryByText('No edge selected')).toBeNull();
  });

  it('stacked with an edge selected: shows the detail pane below the list, full width', () => {
    const container = renderTab({ id: 'edge-1' });
    fireResize(400);
    expect(screen.getByText('edge detail')).toBeInTheDocument();
    expect(container.querySelector('.node-detail-related-detail')).not.toBeNull();
  });

  it('unstacked (wide) with no edge selected: still shows the detail pane with its empty state', () => {
    renderTab(null);
    fireResize(900);
    expect(screen.getByText('No edge selected')).toBeInTheDocument();
  });
});
