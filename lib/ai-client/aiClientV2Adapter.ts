// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { AIAdapter as ExistingAIAdapter } from '../debate/aiAdapter.js';
import type { GenerateResponse } from '../debate/cacheTypes.js';
import type { AICallV2 } from './aiClientV2.js';

export interface AIAdapter {
  call(params: AICallV2): Promise<{ text: string; generateResponse?: GenerateResponse }>;
}

export class AIAdapterGenerationError extends Error {
  constructor(readonly originalError: unknown) {
    super('Underlying AI adapter generation failed');
    this.name = 'AIAdapterGenerationError';
  }
}

export function adaptAIAdapter(adapter: ExistingAIAdapter): AIAdapter {
  return {
    async call(params) {
      try {
        if (params.request && adapter.generate) {
          const generateResponse = await adapter.generate(params.request);
          return { text: generateResponse.text, generateResponse };
        }

        const prompt = params.messages
          .map(({ role, content }) => `${role.toUpperCase()}:\n${content}`)
          .join('\n\n');
        const text = await adapter.generateText(prompt, params.model, {
          ...params.options,
          temperature: params.options?.temperature ?? params.temperature,
          maxTokens: params.options?.maxTokens ?? params.maxTokens,
        });
        return { text };
      } catch (error) {
        throw new AIAdapterGenerationError(error);
      }
    },
  };
}
