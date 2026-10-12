// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4088: the AI call log's KeySource contract (tests/fixtures/ai-call-log/README.md) lists the key
// variables a writer may log as `env:<VAR>`. That list must stay identical to BACKEND_KEY_ENV_VARS, the
// canonical TS map the TS writers classify against (and PowerShell's $script:AIApiKeyEnvVarMap mirrors).
// A new backend's key variable must be added to both, or this fails.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BACKEND_KEY_ENV_VARS, GENERIC_FALLBACK_ENV, GENERIC_FALLBACK_BACKEND } from './apiKeyFallback.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const README = readFileSync(path.join(REPO_ROOT, 'tests/fixtures/ai-call-log/README.md'), 'utf-8');

function contractEnvVars(): string[] {
  const row = README.split('\n').find((l) => l.includes('`env:<VAR>`') && l.includes('must be one of'));
  if (!row) throw new Error('call-log README: the env:<VAR> row ("must be one of") was not found; update this test with the contract');
  return [...row.slice(row.indexOf('must be one of')).matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]);
}

describe('AI call log KeySource contract parity (t/4088)', () => {
  it('the README env:<VAR> list equals the union of BACKEND_KEY_ENV_VARS', () => {
    const contract = contractEnvVars();
    expect(contract.length).toBeGreaterThanOrEqual(9); // a vacuous parse would pass anything
    const map = Object.values(BACKEND_KEY_ENV_VARS).flat();
    expect([...contract].sort()).toEqual([...map].sort());
  });

  it('the contract names the generic fallback exactly as lib does (gemini only)', () => {
    expect(README).toContain(`\`fallback:${GENERIC_FALLBACK_ENV}\``);
    expect(GENERIC_FALLBACK_BACKEND).toBe('gemini');
    expect(contractEnvVars()).not.toContain(GENERIC_FALLBACK_ENV); // AI_API_KEY is a fallback, never an env:<VAR>
  });
});
