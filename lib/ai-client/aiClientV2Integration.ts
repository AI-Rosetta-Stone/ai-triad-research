// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { AIClientV2, type AICallV2 } from './aiClientV2.js';
import { AIAdapterGenerationError, adaptAIAdapter } from './aiClientV2Adapter.js';
import type { AIAdapter } from '../debate/aiAdapter.js';
import {
  emptyCacheUsage,
  flattenEnvelope,
  type GenerateRequest,
  type GenerateResponse,
} from '../debate/cacheTypes.js';
import { resolveBackend } from './registry.js';
import { getFlagValue } from '../phase2Flags.js';

export class AIClientV2Adapter {
  private readonly clientV2: AIClientV2 | null;
  private readonly v2Enabled: boolean;

  constructor(private readonly baseAdapter: AIAdapter) {
    this.v2Enabled = getFlagValue('AI_CLIENT_V2_ENABLED');
    this.clientV2 = this.v2Enabled
      ? new AIClientV2(adaptAIAdapter(baseAdapter), { enabled: true })
      : null;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.clientV2) return this.generateWithBaseAdapter(request);

    try {
      const response = await this.clientV2.call({
        model: request.model,
        messages: [{ role: 'user', content: flattenEnvelope(request.envelope) }],
        temperature: request.options.temperature,
        maxTokens: request.options.maxTokens,
        options: request.options,
        request,
      });
      if (response.generateResponse) return response.generateResponse;
      return this.toGenerateResponse(response.text, request, response.latencyMs);
    } catch (error) {
      if (error instanceof AIAdapterGenerationError) throw error.originalError;
      console.warn('[V2 AI Client] Batch failed, falling back to v1:', error);
      return this.generateWithBaseAdapter(request);
    }
  }

  async *stream(request: GenerateRequest): AsyncGenerator<string> {
    if (!this.clientV2) {
      yield await this.baseAdapter.generateText(
        flattenEnvelope(request.envelope),
        request.model,
        request.options,
      );
      return;
    }

    try {
      const stream = await this.clientV2.stream(this.toAICall(request));
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof AIAdapterGenerationError) throw error.originalError;
      console.warn('[V2 AI Client] Stream failed, falling back to buffered:', error);
      yield await this.baseAdapter.generateText(
        flattenEnvelope(request.envelope),
        request.model,
        request.options,
      );
    }
  }

  private toAICall(request: GenerateRequest): AICallV2 {
    return {
      model: request.model,
      messages: [{ role: 'user', content: flattenEnvelope(request.envelope) }],
      temperature: request.options.temperature,
      maxTokens: request.options.maxTokens,
      options: request.options,
      request,
    };
  }

  private async generateWithBaseAdapter(request: GenerateRequest): Promise<GenerateResponse> {
    if (this.baseAdapter.generate) return this.baseAdapter.generate(request);
    const start = performance.now();
    const text = await this.baseAdapter.generateText(
      flattenEnvelope(request.envelope),
      request.model,
      request.options,
    );
    return this.toGenerateResponse(text, request, performance.now() - start);
  }

  private toGenerateResponse(
    text: string,
    request: GenerateRequest,
    responseTimeMs: number,
  ): GenerateResponse {
    return {
      text,
      usage: emptyCacheUsage(),
      model: request.model,
      backend: resolveBackend(request.model, this.baseAdapter.registry),
      responseTimeMs,
    };
  }
}

export function createAIClientV2Wrapper(baseAdapter: AIAdapter): AIClientV2Adapter {
  return new AIClientV2Adapter(baseAdapter);
}

export function isAIClientV2Ready(): boolean {
  return getFlagValue('AI_CLIENT_V2_ENABLED');
}
