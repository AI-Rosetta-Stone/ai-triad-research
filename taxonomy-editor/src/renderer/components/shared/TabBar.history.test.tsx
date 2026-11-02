// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC2 (Design AC8 round 2): a REAL camp-tab click went from 6 to 7 history entries, because
// each camp auto-selects its own first node and that node's placeKey differs. This drives the real
// TabBar click handler and the real auto-select effect against the real taxonomy store, the real
// nav subscriber and a real MemoryHistory — the earlier AC2 test only switched camps on the same
// node, which the UI can't do.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TabBar } from './TabBar';
import { useAutoSelectFirstNode } from '../taxonomy/useAutoSelectFirstNode';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { installNavSubscriber, expectReplace } from '../../navigation/subscriber';
import { MemoryHistory } from '../../navigation/navHistory';

const CAMP_NODES: Record<string, Array<{ id: string; label: string }>> = {
  accelerationist: [{ id: 'acc-1', label: 'Acc first' }, { id: 'acc-2', label: 'Acc second' }],
  safetyist: [{ id: 'saf-1', label: 'Saf first' }],
  skeptic: [{ id: 'skp-1', label: 'Skp first' }],
};

/** The camp tabs plus the camp's auto-select, as PovTab mounts them. */
function CampHarness() {
  const { activeTab, selectedNodeId, setSelectedNodeId } = useTaxonomyStore();
  const ids = (CAMP_NODES[activeTab] ?? []).map(n => n.id);
  useAutoSelectFirstNode(activeTab, ids, selectedNodeId, setSelectedNodeId);
  return <TabBar />;
}

describe('camp-tab switch and its auto-select replace the entry (t/4640 AC2)', () => {
  let history: MemoryHistory;
  let uninstall: () => void;

  beforeEach(() => {
    expectReplace(null);
    useTaxonomyStore.setState({
      activeTab: 'safetyist',
      selectedNodeId: 'saf-1',
      accelerationist: { nodes: CAMP_NODES.accelerationist },
      safetyist: { nodes: CAMP_NODES.safetyist },
      skeptic: { nodes: CAMP_NODES.skeptic },
    } as never);
    history = new MemoryHistory();
    history.push({ path: '/', placeKey: 'rosetta-stone', label: 'Rosetta Stone' });
    uninstall = installNavSubscriber({ taxonomy: useTaxonomyStore }, history, () => {});
  });

  afterEach(() => uninstall());

  it('a real camp-tab click adds no history entry; the entry follows to the new camp\'s node', async () => {
    render(<CampHarness />);
    const before = history.entries().length;
    expect(history.current()?.placeKey).toBe('taxonomy:saf-1');

    await userEvent.click(screen.getByRole('tab', { name: /Accelerationist/ }));

    expect(useTaxonomyStore.getState().selectedNodeId).toBe('acc-1'); // the auto-select ran
    expect(history.entries()).toHaveLength(before);
    expect(history.current()).toMatchObject({ placeKey: 'taxonomy:acc-1', path: '/taxonomy/acc?node=acc-1' });
  });

  it('after a camp switch, the user\'s own node click still pushes', async () => {
    render(<CampHarness />);
    await userEvent.click(screen.getByRole('tab', { name: /Skeptic/ }));
    const before = history.entries().length;

    useTaxonomyStore.getState().setSelectedNodeId('skp-other');

    expect(history.entries()).toHaveLength(before + 1);
    expect(history.current()?.placeKey).toBe('taxonomy:skp-other');
  });
});
