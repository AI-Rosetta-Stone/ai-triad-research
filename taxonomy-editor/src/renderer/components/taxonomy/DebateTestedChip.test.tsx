import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { DebateTestedChip, NodeStatusBadge, computeSha256 } from './DebateTestedChip';
import type { DebateTestedRecord } from '../../bridge/types';
import type { PovNode } from '../../types/taxonomy';

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

function makeRecord(overrides: Partial<DebateTestedRecord> = {}): DebateTestedRecord {
  return {
    tier: 'untested',
    sort_key: 0,
    engagements: 0,
    challenges: 0,
    held: 0,
    weakened: 0,
    revisions: [],
    last_tested: '2026-07-01',
    description_hash: '',
    record: [],
    ...overrides,
  };
}

describe('DebateTestedChip', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Untested" for untested tier', () => {
    render(<DebateTestedChip record={makeRecord({ tier: 'untested' })} />);
    expect(screen.getByText('Untested')).toBeTruthy();
  });

  it('renders "Cited" for cited tier', () => {
    render(<DebateTestedChip record={makeRecord({ tier: 'cited' })} />);
    expect(screen.getByText('Cited')).toBeTruthy();
  });

  it('renders "Contested" for contested tier', () => {
    render(<DebateTestedChip record={makeRecord({ tier: 'contested' })} />);
    expect(screen.getByText('Contested')).toBeTruthy();
  });

  it('renders "Well Tested" for well_tested tier', () => {
    render(<DebateTestedChip record={makeRecord({ tier: 'well_tested' })} />);
    expect(screen.getByText('Well Tested')).toBeTruthy();
  });

  it('renders "Untested" when no record is provided', () => {
    render(<DebateTestedChip />);
    expect(screen.getByText('Untested')).toBeTruthy();
  });

  it('applies correct background color for each tier', () => {
    const { container, rerender } = render(<DebateTestedChip record={makeRecord({ tier: 'untested' })} />);
    expect(container.querySelector('.debate-tested-chip')?.getAttribute('style')).toContain('rgb(226, 232, 240)');

    rerender(<DebateTestedChip record={makeRecord({ tier: 'cited' })} />);
    expect(container.querySelector('.debate-tested-chip')?.getAttribute('style')).toContain('rgb(219, 234, 254)');

    rerender(<DebateTestedChip record={makeRecord({ tier: 'contested' })} />);
    expect(container.querySelector('.debate-tested-chip')?.getAttribute('style')).toContain('rgb(254, 243, 199)');

    rerender(<DebateTestedChip record={makeRecord({ tier: 'well_tested' })} />);
    expect(container.querySelector('.debate-tested-chip')?.getAttribute('style')).toContain('rgb(187, 247, 208)');
  });

  it('adds clickable class when onClick is provided', () => {
    const { container } = render(<DebateTestedChip record={makeRecord()} onClick={() => {}} />);
    expect(container.querySelector('.debate-tested-chip.clickable')).toBeTruthy();
  });

  it('does not add clickable class when onClick is absent', () => {
    const { container } = render(<DebateTestedChip record={makeRecord()} />);
    expect(container.querySelector('.debate-tested-chip.clickable')).toBeNull();
  });

  it('adds compact class when compact is true', () => {
    const { container } = render(<DebateTestedChip record={makeRecord()} compact />);
    expect(container.querySelector('.debate-tested-chip.compact')).toBeTruthy();
  });

  it('shows stale warning when description_hash mismatches', async () => {
    const hash = await computeSha256('old description');
    const record = makeRecord({ tier: 'cited', description_hash: hash });

    const { container } = render(
      <DebateTestedChip record={record} description="new description" />,
    );

    await waitFor(() => {
      expect(container.querySelector('.debate-tested-stale')).toBeTruthy();
    });
  });

  it('does not show stale warning when description_hash matches', async () => {
    const desc = 'matching description';
    const hash = await computeSha256(desc);
    const record = makeRecord({ tier: 'well_tested', description_hash: hash });

    const { container } = render(
      <DebateTestedChip record={record} description={desc} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.debate-tested-stale')).toBeNull();
    });
  });

  it('shows stale warning when description_hash is empty (never hashed)', async () => {
    const record = makeRecord({ tier: 'cited', description_hash: '' });

    const { container } = render(
      <DebateTestedChip record={record} description="some text" />,
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(container.querySelector('.debate-tested-stale')).toBeTruthy();
  });
});

describe('NodeStatusBadge (t/4574#24 item 2)', () => {
  function makeNode(tier: DebateTestedRecord['tier']): PovNode {
    return {
      id: 'acc-desires-010',
      category: 'Desires',
      label: 'Test',
      description: 'A test description.',
      parent_id: null,
      children: [],
      situation_refs: [],
      graph_attributes: { debate_tested: makeRecord({ tier }) } as never,
    };
  }

  it.each(['untested', 'cited', 'contested', 'well_tested'] as const)(
    'sets data-tier="%s" and no inline color style — colors come from CSS, not TIER_COLORS.fg',
    (tier) => {
      render(<NodeStatusBadge node={makeNode(tier)} onToggleDrilldown={() => {}} />);
      const badge = screen.getByRole('button', { name: new RegExp(tier === 'well_tested' ? 'well tested' : tier, 'i') });
      expect(badge).toHaveAttribute('data-tier', tier);
      expect(badge.getAttribute('style')).toBeFalsy();
    },
  );

  it('renders nothing when the node has no debate_tested record', () => {
    const node: PovNode = { id: 'acc-desires-011', category: 'Desires', label: 'Test', description: '', parent_id: null, children: [], situation_refs: [] };
    const { container } = render(<NodeStatusBadge node={node} onToggleDrilldown={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('calls onToggleDrilldown when clicked', () => {
    const onToggleDrilldown = vi.fn();
    render(<NodeStatusBadge node={makeNode('cited')} onToggleDrilldown={onToggleDrilldown} />);
    fireEvent.click(screen.getByRole('button', { name: /cited/i }));
    expect(onToggleDrilldown).toHaveBeenCalledTimes(1);
  });
});

describe('computeSha256', () => {
  it('returns sha256-prefixed hex string', async () => {
    const hash = await computeSha256('hello');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic', async () => {
    const a = await computeSha256('test input');
    const b = await computeSha256('test input');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', async () => {
    const a = await computeSha256('input A');
    const b = await computeSha256('input B');
    expect(a).not.toBe(b);
  });
});
