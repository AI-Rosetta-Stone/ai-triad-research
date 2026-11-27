// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { DEFAULT_MODEL } from '../ai-client/index.js';

// Model alias resolution for the cross-judge audit CLI. Kept out of judgeAudit.ts, which runs its
// CLI on import, so the table can be tested.
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  gemini: DEFAULT_MODEL,
  // One tier above Lite: a cross-judge audit must not compare DEFAULT_MODEL with itself (t/781).
  'gemini-flash': 'gemini-3.6-flash',
  'gemini-lite': DEFAULT_MODEL,
  groq: 'groq-openai-gpt-oss-120b',
  llama: 'groq-openai-gpt-oss-120b',
};

export function resolveModelAlias(input: string): string {
  return MODEL_ALIASES[input.toLowerCase()] ?? input;
}
