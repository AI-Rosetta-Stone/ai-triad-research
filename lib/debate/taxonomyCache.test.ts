import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LRUCache, TaxonomyCache, createTaxonomyCache } from './taxonomyCache.js';

describe('Taxonomy Cache V2', () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = new LRUCache(100, 300000);
  });

  it('stores and retrieves values', () => {
    cache.set('node-1', 'value-1');
    expect(cache.get('node-1')).toBe('value-1');
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('tracks hit rate', () => {
    cache.set('node-1', 'value-1');
    cache.get('node-1');
    cache.get('node-1');
    cache.get('missing');

    const stats = cache.getStats();
    expect(stats.hitRate).toBeGreaterThan(0.5);
  });

  it('evicts LRU entries when full', () => {
    const smallCache = new LRUCache(3, 300000);
    smallCache.set('a', 'val-a');
    smallCache.set('b', 'val-b');
    smallCache.set('c', 'val-c');
    expect(smallCache.getStats().size).toBe(3);

    expect(smallCache.get('a')).toBe('val-a');
    smallCache.set('d', 'val-d');
    expect(smallCache.getStats().size).toBe(3);
    expect(smallCache.getStats().evictions).toBe(1);
    expect(smallCache.get('a')).toBe('val-a');
    expect(smallCache.get('b')).toBeUndefined();
  });

  it('respects TTL expiration', (done) => {
    const shortCache = new LRUCache(10, 50);
    shortCache.set('node-1', 'value-1');

    expect(shortCache.get('node-1')).toBe('value-1');

    setTimeout(() => {
      expect(shortCache.get('node-1')).toBeUndefined();
      done();
    }, 100);
  });

  it('provides TaxonomyCache wrapper', async () => {
    const taxonomyCache = createTaxonomyCache();
    const mockLoader = async () => ({ id: 'node-1', data: 'test' });

    const result1 = await taxonomyCache.getNode('node-1', mockLoader);
    const result2 = await taxonomyCache.getNode('node-1', mockLoader);

    expect(result1).toEqual(result2);
  });

  it('caches falsey values when enabled', async () => {
    const taxonomyCache = new TaxonomyCache(100, 300000, true);
    const loader = vi.fn(async () => false);

    await expect(taxonomyCache.getNode('node-1', loader)).resolves.toBe(false);
    await expect(taxonomyCache.getNode('node-1', loader)).resolves.toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('achieves >80% hit rate on typical workload', () => {
    const cache = new LRUCache(1000, 300000);

    // Simulate typical taxonomy query pattern
    const nodeIds = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];
    for (let i = 0; i < 100; i++) {
      const nodeId = nodeIds[i % nodeIds.length];
      cache.set(nodeId, `value-${nodeId}`);
      cache.get(nodeId);
    }

    const stats = cache.getStats();
    expect(stats.hitRate).toBeGreaterThan(0.8);
  });

  it('maintains <2ms lookup latency', () => {
    const cache = new LRUCache(5000, 300000);

    // Populate cache
    for (let i = 0; i < 1000; i++) {
      cache.set(`node-${i}`, `value-${i}`);
    }

    // Measure lookup time
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      cache.get(`node-${i}`);
    }
    const elapsed = performance.now() - start;
    const avgLatency = elapsed / 1000;

    expect(avgLatency).toBeLessThan(2);
  });

  it('handles cache invalidation', () => {
    cache.set('node-1', 'value-1');
    expect(cache.get('node-1')).toBe('value-1');

    cache.delete('node-1');
    expect(cache.get('node-1')).toBeUndefined();
  });

  it('clears all entries', () => {
    cache.set('node-1', 'value-1');
    cache.set('node-2', 'value-2');
    expect(cache.getStats().size).toBe(2);

    cache.clear();
    expect(cache.getStats().size).toBe(0);
  });
});
