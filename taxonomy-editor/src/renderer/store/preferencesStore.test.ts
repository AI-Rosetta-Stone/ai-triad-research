import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePreferencesStore } from './preferencesStore';

const mockGetPreferences = vi.fn();
const mockSetPreferences = vi.fn();
vi.mock('@bridge', () => ({
  api: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    setPreferences: (...args: unknown[]) => mockSetPreferences(...args),
  },
}));

describe('preferencesStore', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ viewMode: 'simple', nodeDetailTabGroup: 'what' });
    mockGetPreferences.mockReset();
    mockSetPreferences.mockReset();
  });

  describe('viewMode (the rail control)', () => {
    it('setViewMode updates the store and persists it', async () => {
      mockSetPreferences.mockResolvedValue(undefined);
      await usePreferencesStore.getState().setViewMode('advanced');
      expect(usePreferencesStore.getState().viewMode).toBe('advanced');
      expect(mockSetPreferences).toHaveBeenCalledWith({ viewMode: 'advanced', nodeDetailTabGroup: 'what' });
    });

    it('hydrate() reads the persisted viewMode', async () => {
      mockGetPreferences.mockResolvedValue({ viewMode: 'advanced' });
      await usePreferencesStore.getState().hydrate();
      expect(usePreferencesStore.getState().viewMode).toBe('advanced');
    });
  });

  // t/4826: the What/Why/How tab-group filter is panel-wide (not per-node) and independent of
  // viewMode — it never reads or writes it, and the rail never changes it.
  describe('nodeDetailTabGroup (t/4826)', () => {
    it('defaults to "what"', () => {
      expect(usePreferencesStore.getState().nodeDetailTabGroup).toBe('what');
    });

    it('setNodeDetailTabGroup updates the store and persists it alongside viewMode', async () => {
      mockSetPreferences.mockResolvedValue(undefined);
      await usePreferencesStore.getState().setNodeDetailTabGroup('why');
      expect(usePreferencesStore.getState().nodeDetailTabGroup).toBe('why');
      expect(mockSetPreferences).toHaveBeenCalledWith({ viewMode: 'simple', nodeDetailTabGroup: 'why' });
    });

    it('setViewMode never changes the tab group', async () => {
      mockSetPreferences.mockResolvedValue(undefined);
      await usePreferencesStore.getState().setNodeDetailTabGroup('how');
      await usePreferencesStore.getState().setViewMode('advanced');
      expect(usePreferencesStore.getState().nodeDetailTabGroup).toBe('how');
    });

    it('setNodeDetailTabGroup never changes viewMode', async () => {
      mockSetPreferences.mockResolvedValue(undefined);
      await usePreferencesStore.getState().setViewMode('advanced');
      await usePreferencesStore.getState().setNodeDetailTabGroup('why');
      expect(usePreferencesStore.getState().viewMode).toBe('advanced');
    });

    it('hydrate() reads a valid persisted tab group', async () => {
      mockGetPreferences.mockResolvedValue({ viewMode: 'simple', nodeDetailTabGroup: 'how' });
      await usePreferencesStore.getState().hydrate();
      expect(usePreferencesStore.getState().nodeDetailTabGroup).toBe('how');
    });

    it('hydrate() ignores an invalid persisted tab group rather than crashing', async () => {
      mockGetPreferences.mockResolvedValue({ viewMode: 'simple', nodeDetailTabGroup: 'garbage' });
      await usePreferencesStore.getState().hydrate();
      expect(usePreferencesStore.getState().nodeDetailTabGroup).toBe('what'); // untouched default
    });

    it('hydrate() with no persisted tab group leaves the default untouched', async () => {
      mockGetPreferences.mockResolvedValue({ viewMode: 'simple' });
      await usePreferencesStore.getState().hydrate();
      expect(usePreferencesStore.getState().nodeDetailTabGroup).toBe('what');
    });
  });
});
