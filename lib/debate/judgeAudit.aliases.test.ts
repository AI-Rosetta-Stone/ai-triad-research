// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/781: the cross-judge audit takes model aliases. If the Gemini aliases collapse onto one id, a
// "second judge" at the Flash tier is the same model as the first and the audit compares it with itself.
import { describe, it, expect } from 'vitest';
import { resolveModelAlias } from './judgeAuditAliases.js';

describe('judgeAudit Gemini aliases', () => {
  it('gemini, gemini-flash and gemini-lite do not all resolve to one model id', () => {
    const ids = ['gemini', 'gemini-flash', 'gemini-lite'].map(resolveModelAlias);
    expect(new Set(ids).size).toBeGreaterThan(1);
  });

  it('gemini-flash is a different model from gemini-lite', () => {
    expect(resolveModelAlias('gemini-flash')).not.toBe(resolveModelAlias('gemini-lite'));
    expect(resolveModelAlias('gemini-flash')).toBe('gemini-3.6-flash');
  });

  it('is case-insensitive and passes an unknown id through', () => {
    expect(resolveModelAlias('Gemini-Flash')).toBe('gemini-3.6-flash');
    expect(resolveModelAlias('some-other-model')).toBe('some-other-model');
  });
});
