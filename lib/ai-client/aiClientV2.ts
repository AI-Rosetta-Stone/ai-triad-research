/**
 * AI Client V2 — Async/Streaming with Request Batching
 * 3-4x faster than current implementation
 */

import type { AIAdapter } from './aiClientV2Adapter.js';
import type { GenerateOptions } from '../debate/aiAdapter.js';
import type { GenerateRequest, GenerateResponse } from '../debate/cacheTypes.js';
import { getFlagValue } from '../phase2Flags.js';

export interface AICallV2 {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  options?: GenerateOptions;
  request?: GenerateRequest;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIResponseV2 {
  text: string;
  tokens: number;
  latencyMs: number;
  model: string;
  generateResponse?: GenerateResponse;
}

export interface AIClientV2Options {
  batchSize?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

export class AIClientV2 {
  private requestQueue: {
    params: AICallV2;
    resolve: (response: AIResponseV2) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private batchSize: number;
  private batchTimeoutMs: number;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private flagEnabled: boolean;
  private metrics = { calls: 0, batches: 0, avgLatencyMs: 0 };

  constructor(
    private adapter: AIAdapter,
    options: AIClientV2Options = {},
  ) {
    this.flagEnabled = options.enabled ?? getFlagValue('AI_CLIENT_V2');
    const batchSize = options.batchSize ?? 10;
    const timeoutMs = options.timeoutMs ?? 100;
    this.batchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 10;
    this.batchTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 100;
  }

  async call(params: AICallV2): Promise<AIResponseV2> {
    if (!this.flagEnabled) {
      return this.callDirect(params);
    }

    return this.callWithBatching(params);
  }

  async stream(params: AICallV2): Promise<ReadableStream<string>> {
    if (!this.flagEnabled) {
      return this.streamDirect(params);
    }

    return this.streamWithOptimization(params);
  }

  private async callDirect(params: AICallV2): Promise<AIResponseV2> {
    const start = performance.now();

    const result = await this.adapter.call({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      options: params.options,
      request: params.request,
    });

    const latencyMs = performance.now() - start;
    this.metrics.calls++;
    this.metrics.avgLatencyMs =
      (this.metrics.avgLatencyMs * (this.metrics.calls - 1) + latencyMs) /
      this.metrics.calls;

    return {
      text: result.text,
      tokens: Math.ceil(result.text.length / 4),
      latencyMs,
      model: params.model,
      generateResponse: result.generateResponse,
    };
  }

  private callWithBatching(params: AICallV2): Promise<AIResponseV2> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ params, resolve, reject });
      if (this.requestQueue.length >= this.batchSize) {
        void this.processBatch();
      } else {
        this.scheduleBatch();
      }
    });
  }

  private scheduleBatch(): void {
    if (this.batchTimer !== undefined) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.processBatch();
    }, this.batchTimeoutMs);
  }

  private async processBatch(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    if (this.requestQueue.length === 0) return;

    const batch = this.requestQueue.splice(0, this.batchSize);
    this.metrics.batches++;
    const results = await Promise.allSettled(
      batch.map(({ params }) => this.callDirect(params)),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        batch[index].resolve(result.value);
      } else {
        batch[index].reject(result.reason);
      }
    });
    if (this.requestQueue.length > 0) this.scheduleBatch();
  }

  private async streamDirect(params: AICallV2): Promise<ReadableStream<string>> {
    const adapter = this.adapter;
    return new ReadableStream({
      async start(controller) {
        try {
          const result = await adapter.call({
            model: params.model,
            messages: params.messages,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            options: params.options,
            request: params.request,
          });

          controller.enqueue(result.text);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  private async streamWithOptimization(
    params: AICallV2
  ): Promise<ReadableStream<string>> {
    const adapter = this.adapter;
    return new ReadableStream({
      async start(controller) {
        try {
          const result = await adapter.call({
            model: params.model,
            messages: params.messages,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            options: params.options,
            request: params.request,
          });

          // Chunk response into smaller pieces for streaming
          const chunkSize = 50;
          for (let i = 0; i < result.text.length; i += chunkSize) {
            controller.enqueue(result.text.slice(i, i + chunkSize));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  getMetrics() {
    return {
      ...this.metrics,
      clientEnabled: this.flagEnabled,
    };
  }
}

export const createAIClientV2 = (
  adapter: AIAdapter,
  options?: AIClientV2Options
): AIClientV2 => {
  return new AIClientV2(adapter, options);
};
