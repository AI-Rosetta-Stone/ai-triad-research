// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoverageBadge } from './TaxonomyRefs';
import type { CoverageMap, StrengthWeightedCoverage } from '@lib/debate/coverageTracker';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('./utils', () => ({
  nodeIdToTab: (id: string) => ({ tab: 'acc', colorVar: 'var(--color-acc)' }),
  getNodeLabel: (id: string) => `Label for ${id}`,
  getNodeWeight: () => 1,
  focusMainWindowNode: vi.fn(),
  buildExplainPrompt: vi.fn(() => 'prompt'),
  buildSelectionExplainPrompt: vi.fn(() => 'selection prompt'),
  fixMarkdownLinks: (s: string) => s,
  resolvePolRef: () => null,
  getPolicyAction: () => undefined,
}));

vi.mock('../../utils/humanizeSpeakers', () => ({
  humanizeSpeakerIds: (ids: string[]) => ids.join(', '),
}));

afterEach(() => { vi.clearAllMocks(); });

function makeCoverageMap(overrides: Partial<CoverageMap['stats']> = {}): CoverageMap {
  return {
    stats: {
      totalClaims: 10,
      coveredCount: 6,
      partiallyCoveredCount: 2,
      uncoveredCount: 2,
      coveragePercentage: 80,
      ...overrides,
    },
    claimCoverage: new Map(),
    nodeCoverage: new Map(),
  };
}

describe('CoverageBadge', () => {
  it('renders with coverage percentage', () => {
    const map = makeCoverageMap();
    render(<CoverageBadge coverageMap={map} />);
    expect(screen.getByText(/80\s*%/)).toBeInTheDocument();
  });

  it('applies green class for high coverage', () => {
    const map = makeCoverageMap({ coveragePercentage: 85 });
    const { container } = render(<CoverageBadge coverageMap={map} />);
    expect(container.querySelector('.coverage-badge-green')).toBeTruthy();
  });

  it('applies yellow class for medium coverage', () => {
    const map = makeCoverageMap({ coveragePercentage: 50 });
    const { container } = render(<CoverageBadge coverageMap={map} />);
    expect(container.querySelector('.coverage-badge-yellow')).toBeTruthy();
  });

  it('applies red class for low coverage', () => {
    const map = makeCoverageMap({ coveragePercentage: 20 });
    const { container } = render(<CoverageBadge coverageMap={map} />);
    expect(container.querySelector('.coverage-badge-red')).toBeTruthy();
  });

  it('shows strength-weighted percentage when provided', () => {
    const map = makeCoverageMap({ coveragePercentage: 70 });
    const sw: StrengthWeightedCoverage = {
      strength_weighted_coverage: 65,
      per_claim: [],
    };
    render(<CoverageBadge coverageMap={map} strengthWeighted={sw} />);
    expect(screen.getByText(/70\s*%/)).toBeInTheDocument();
  });
});
