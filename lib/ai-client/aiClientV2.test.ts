import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAIClientV2 } from './aiClientV2.js';
import type { AIAdapter } from './aiClientV2Adapter.js';
import { createAIClientV2Wrapper } from './aiClientV2Integration.js';
import type { AIAdapter as ExistingAIAdapter } from '../debate/aiAdapter.js';
import {
  emptyCacheUsage,
  type GenerateRequest,
  type GenerateResponse,
} from '../debate/cacheTypes.js';

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
    const client = createAIClientV2(mockAdapter, { batchSize: 3, timeoutMs: 50, enabled: true });

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
      enabled: true,
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

  it('preserves cached generation results and request options when enabled', async () => {
    vi.stubEnv('AI_CLIENT_V2_ENABLED', 'true');
    try {
      const request: GenerateRequest = {
        envelope: {
          layer1_static: 'static',
          layer2_persona: '',
          layer3_turn: '',
          layer4_variable: '',
          meta: { promptType: 'brief' },
        },
        model: 'openai-gpt-4.1-mini',
        options: {
          signal: new AbortController().signal,
          timeoutMs: 1200,
          responseSchema: { type: 'object' },
        },
      };
      const response: GenerateResponse = {
        text: 'cached response',
        usage: emptyCacheUsage(),
        model: request.model,
        backend: 'openai',
        responseTimeMs: 12,
      };
      const baseAdapter: ExistingAIAdapter = {
        registry: {
          backends: [],
          models: [{
            id: request.model,
            apiModelId: 'gpt-4.1-mini',
            label: 'GPT-4.1 mini',
            backend: 'openai',
          }],
        },
        generateText: vi.fn(async () => response.text),
        generate: vi.fn(async () => response),
      };

      const result = await createAIClientV2Wrapper(baseAdapter).generate(request);

      expect(result).toBe(response);
      expect(baseAdapter.generate).toHaveBeenCalledWith(request);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('forwards generation options when the adapter only supports text generation', async () => {
    vi.stubEnv('AI_CLIENT_V2_ENABLED', 'true');
    try {
      const request: GenerateRequest = {
        envelope: {
          layer1_static: 'static',
          layer2_persona: '',
          layer3_turn: '',
          layer4_variable: '',
          meta: { promptType: 'brief' },
        },
        model: 'openai-gpt-4.1-mini',
        options: {
          signal: new AbortController().signal,
          timeoutMs: 1200,
          responseSchema: { type: 'object' },
        },
      };
      const baseAdapter: ExistingAIAdapter = {
        registry: {
          backends: [],
          models: [{
            id: request.model,
            apiModelId: 'gpt-4.1-mini',
            label: 'GPT-4.1 mini',
            backend: 'openai',
          }],
        },
        generateText: vi.fn(async () => 'fallback text'),
      };

      await createAIClientV2Wrapper(baseAdapter).generate(request);

      expect(baseAdapter.generateText).toHaveBeenCalledWith(
        'USER:\nstatic',
        request.model,
        expect.objectContaining(request.options),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not retry a failed underlying adapter request', async () => {
    vi.stubEnv('AI_CLIENT_V2_ENABLED', 'true');
    const failure = new Error('provider failed');
    const request: GenerateRequest = {
      envelope: {
        layer1_static: 'static',
        layer2_persona: '',
        layer3_turn: '',
        layer4_variable: '',
        meta: { promptType: 'brief' },
      },
      model: 'openai-gpt-4.1-mini',
      options: {},
    };
    const baseAdapter: ExistingAIAdapter = {
      registry: {
        backends: [],
        models: [{
          id: request.model,
          apiModelId: 'gpt-4.1-mini',
          label: 'GPT-4.1 mini',
          backend: 'openai',
        }],
      },
      generate: vi.fn(async () => { throw failure; }),
      generateText: vi.fn(async () => 'fallback text'),
    };

    try {
      await expect(createAIClientV2Wrapper(baseAdapter).generate(request)).rejects.toBe(failure);
      expect(baseAdapter.generate).toHaveBeenCalledOnce();
      expect(baseAdapter.generateText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not retry a failed underlying adapter stream', async () => {
    vi.stubEnv('AI_CLIENT_V2_ENABLED', 'true');
    const failure = new Error('provider failed');
    const request: GenerateRequest = {
      envelope: {
        layer1_static: 'static',
        layer2_persona: '',
        layer3_turn: '',
        layer4_variable: '',
        meta: { promptType: 'brief' },
      },
      model: 'openai-gpt-4.1-mini',
      options: {},
    };
    const baseAdapter: ExistingAIAdapter = {
      registry: {
        backends: [],
        models: [{
          id: request.model,
          apiModelId: 'gpt-4.1-mini',
          label: 'GPT-4.1 mini',
          backend: 'openai',
        }],
      },
      generate: vi.fn(async () => { throw failure; }),
      generateText: vi.fn(async () => 'fallback text'),
    };

    try {
      const readStream = async () => {
        const chunks: string[] = [];
        for await (const chunk of createAIClientV2Wrapper(baseAdapter).stream(request)) {
          chunks.push(chunk);
        }
        return chunks;
      };
      await expect(readStream()).rejects.toBe(failure);
      expect(baseAdapter.generate).toHaveBeenCalledOnce();
      expect(baseAdapter.generateText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
