import { describe, it, expect, beforeEach } from 'vitest';
import { usePreferencesStore } from './preferencesStore';

describe('preferencesStore', () => {
  beforeEach(() => {
    // Reset store state
    usePreferencesStore.setState({ nodeDetailModes: {} });
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
      await store.setNodeDetailMode('node-\', 'advanced');
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
});
