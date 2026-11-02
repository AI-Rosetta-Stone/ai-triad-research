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
    // Reset store state
    usePreferencesStore.setState({ nodeDetailModes: {}, viewMode: 'simple' });
    mockGetPreferences.mockReset();
    mockSetPreferences.mockReset();
  });

  it('gets node detail mode with simple default', () => {
    const mode = usePreferencesStore.getState().getNodeDetailMode('node-1');
    expect(mode).toBe('simple');
  });

  it('sets and gets node detail mode', async () => {
    const store = usePreferencesStore.getState();
    await store.setNodeDetailMode('node-1', 'advanced');
    const mode = store.getNodeDetailMode('node-1');
    expect(mode).toBe('advanced');
  });

  it('LRU eviction removes oldest entry when cap exceeded', async () => {
    const store = usePreferencesStore.getState();
    // Add 501 entries (cap is 500)
    for (let i = 0; i < 501; i++) {
      await store.setNodeDetailMode(`node-${i}`, 'advanced');
    }
    const modes = usePreferencesStore.getState().nodeDetailModes;
    expect(Object.keys(modes).length).toBeLessThanOrEqual(500);
  });

  it('re-toggled key moves to end (LRU)', async () => {
    const store = usePreferencesStore.getState();
    await store.setNodeDetailMode('node-1', 'advanced');
    await store.setNodeDetailMode('node-2', 'advanced');
    await store.setNodeDetailMode('node-1', 'simple'); // Re-toggle
    const keys = Object.keys(usePreferencesStore.getState().nodeDetailModes);
    // node-1 should be last after re-toggle
    expect(keys[keys.length - 1]).toBe('node-1');
  });

  it('round-trips through persist: write, hydrate, read back', async () => {
    mockGetPreferences.mockResolvedValue({ nodeDetailModes: { 'node-1': 'advanced' } });
    await usePreferencesStore.getState().hydrate();
    expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('advanced');
    expect(usePreferencesStore.getState().getNodeDetailMode('node-2')).toBe('simple');
  });

  it('hydrate never overwrites a mode written since app start (t/4574, Design t/4574#11)', async () => {
    // hydrate() is in flight (unresolved) while a user write lands first.
    let resolveHydrate: (v: unknown) => void = () => {};
    mockGetPreferences.mockReturnValue(new Promise(resolve => { resolveHydrate = resolve; }));
    mockSetPreferences.mockResolvedValue(undefined);

    const hydratePromise = usePreferencesStore.getState().hydrate();
    await usePreferencesStore.getState().setNodeDetailMode('node-1', 'advanced');

    // The stale persisted blob (captured before the write) resolves after the write.
    resolveHydrate({ nodeDetailModes: { 'node-1': 'simple' } });
    await hydratePromise;

    expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('advanced');
  });

  describe('global toggle sync (t/4736)', () => {
    it('getNodeDetailMode falls back to the global viewMode, not a hard-coded default', () => {
      usePreferencesStore.setState({ viewMode: 'advanced' });
      expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('advanced');

      usePreferencesStore.setState({ viewMode: 'simple' });
      expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('simple');
    });

    it('a per-node override still wins over the global viewMode', async () => {
      usePreferencesStore.setState({ viewMode: 'advanced' });
      await usePreferencesStore.getState().setNodeDetailMode('node-1', 'simple');
      expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('simple');
      expect(usePreferencesStore.getState().getNodeDetailMode('node-2')).toBe('advanced');
    });

    it('setViewMode clears every per-node override, so already-open nodes follow it too', async () => {
      await usePreferencesStore.getState().setNodeDetailMode('node-1', 'advanced');
      await usePreferencesStore.getState().setNodeDetailMode('node-2', 'advanced');
      expect(Object.keys(usePreferencesStore.getState().nodeDetailModes)).toHaveLength(2);

      mockSetPreferences.mockResolvedValue(undefined);
      await usePreferencesStore.getState().setViewMode('advanced');

      expect(usePreferencesStore.getState().nodeDetailModes).toEqual({});
      expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('advanced');
      expect(usePreferencesStore.getState().getNodeDetailMode('node-2')).toBe('advanced');
      expect(mockSetPreferences).toHaveBeenCalledWith({ viewMode: 'advanced', nodeDetailModes: {} });
    });

    it('a per-node switch made after a global change sticks until the next global change', async () => {
      mockSetPreferences.mockResolvedValue(undefined);
      await usePreferencesStore.getState().setViewMode('advanced');
      await usePreferencesStore.getState().setNodeDetailMode('node-1', 'simple');

      expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('simple');
      expect(usePreferencesStore.getState().getNodeDetailMode('node-2')).toBe('advanced');

      await usePreferencesStore.getState().setViewMode('simple');
      expect(usePreferencesStore.getState().getNodeDetailMode('node-1')).toBe('simple');
    });
  });
});
