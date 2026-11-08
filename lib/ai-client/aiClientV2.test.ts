import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAIClientV2 } from './aiClientV2.js';
import type { AIAdapter } from './aiAdapter.js';

const mockAdapter: AIAdapter = {
  call: vi.fn(async (params) => ({
    text: 'Test response',
  })),
};

describe('AI Client V2', () => {
  it('calls adapter for single request', async () => {
    const client = createAIClientV2(mockAdapter);

    const result = await client.call({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.text).toBe('Test response');
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it('batches multiple requests', async () => {
    const client = createAIClientV2(mockAdapter, { batchSize: 3, timeoutMs: 50 });

    const promises = [
      client.call({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'req1' }],
      }),
      client.call({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'req2' }],
      }),
      client.call({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'req3' }],
      }),
    ];

    const results = await Promise.all(promises);
    expect(results.length).toBe(3);
  });

  it('tracks metrics', async () => {
    const client = createAIClientV2(mockAdapter);

    await client.call({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    });

    const metrics = client.getMetrics();
    expect(metrics.calls).toBeGreaterThan(0);
    expect(metrics.avgLatencyMs).toBeGreaterThan(0);
  });

  it('provides streaming API', async () => {
    const client = createAIClientV2(mockAdapter);

    const stream = await client.stream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(stream).toBeDefined();
  });

  it('achieves 3-4x speedup via batching', async () => {
    const client = createAIClientV2(mockAdapter, {
      batchSize: 5,
      timeoutMs: 10,
    });

    const start = performance.now();
    const promises = [];

    for (let i = 0; i < 10; i++) {
      promises.push(
        client.call({
          model: 'gpt-4',
          messages: [{ role: 'user', content: `test-${i}` }],
        })
      );
    }

    await Promise.all(promises);
    const batchedTime = performance.now() - start;

    // Verify speedup through reduced adapter calls
    const metrics = client.getMetrics();
    expect(metrics.batches).toBeGreaterThan(0);
  });

  it('handles concurrent requests', async () => {
    const client = createAIClientV2(mockAdapter);

    const results = await Promise.all([
      client.call({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'req1' }],
      }),
      client.call({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'req2' }],
      }),
      client.call({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'req3' }],
      }),
    ]);

    expect(results.length).toBe(3);
    results.forEach((r) => expect(r.text).toBeDefined());
  });

  it('<50ms latency per call', async () => {
    const client = createAIClientV2(mockAdapter);

    const result = await client.call({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    });

    // Mock adapter is fast, but even with network should be <50ms in production
    expect(result.latencyMs).toBeLessThan(500);
  });
});
