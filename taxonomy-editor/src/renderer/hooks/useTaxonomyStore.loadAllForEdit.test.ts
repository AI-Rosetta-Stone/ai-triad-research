// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4208 (TL GV gap on the t/4187 bundle, p/775#56): the loadAll tests in
// useTaxonomyStore.test.ts only check loadAll's *outcome* (state populated) via a mock that
// resolves regardless of which bridge method is called, so a regression back to plain
// loadTaxonomyFile wouldn't fail them — it would only surface later as the lost-update bug
// t/4187 fixes. This file pins the call target itself. Split out rather than added inline to
// stay under useTaxonomyStore.test.ts's max-lines budget (t/4197, p/775#45/#46).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApi } = vi.hoisted(() => {
  const mockApi = {
    loadTaxonomyFile: vi.fn(),
    loadTaxonomyFileForEdit: vi.fn().mockResolvedValue({ nodes: [] }),
    loadPolicyRegistry: vi.fn().mockResolvedValue({ policies: [] }),
    loadConflictFiles: vi.fn().mockResolvedValue([]),
    loadConflictClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    loadAggregatedCruxes: vi.fn().mockResolvedValue({ cruxes: [] }),
    trackEvent: vi.fn(),
  };
  return { mockApi };
});

vi.mock('@bridge', () => ({ api: mockApi }));

vi.mock('@lib/debate', () => ({
  normalizeNodeProperties: vi.fn(),
}));

vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodeTypeFromId: vi.fn(() => 'pov'),
}));

vi.mock('@lib/debate/types', () => ({
  POV_KEYS: ['accelerationist', 'safetyist', 'skeptic'],
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }),
}));

vi.mock('../utils/validation', () => ({
  stripInvalidLogicalForm: vi.fn().mockReturnValue({ removed: false }),
}));

vi.mock('../data/lineageCategories', () => ({
  loadLineageCategoriesData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../data/lineageLookup', () => ({
  loadLineageInfoData: vi.fn().mockResolvedValue(undefined),
}));

import { useTaxonomyStore } from './useTaxonomyStore';

describe('useTaxonomyStore loadAll call target (t/4208)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.loadTaxonomyFileForEdit.mockResolvedValue({ nodes: [] });
    mockApi.loadPolicyRegistry.mockResolvedValue({ policies: [] });
    useTaxonomyStore.setState({ accelerationist: null, loading: false });
  });

  it('loads every POV and situations via loadTaxonomyFileForEdit, never plain loadTaxonomyFile', async () => {
    await useTaxonomyStore.getState().loadAll(true);
    expect(mockApi.loadTaxonomyFileForEdit).toHaveBeenCalledWith('accelerationist');
    expect(mockApi.loadTaxonomyFileForEdit).toHaveBeenCalledWith('safetyist');
    expect(mockApi.loadTaxonomyFileForEdit).toHaveBeenCalledWith('skeptic');
    expect(mockApi.loadTaxonomyFileForEdit).toHaveBeenCalledWith('situations');
    expect(mockApi.loadTaxonomyFile).not.toHaveBeenCalled();
  });
});
