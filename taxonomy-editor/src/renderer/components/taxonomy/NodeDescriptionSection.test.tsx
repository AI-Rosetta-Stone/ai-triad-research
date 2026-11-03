// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4574 spec §2.4: the Formal description parses into a lead sentence plus
// ENCOMPASSES/EXCLUDES clauses, falling back to the full text as paragraphs when it
// can't parse — never dropping content.

import { describe, it, expect } from 'vitest';
import { parseFormalDescription } from './NodeDescriptionSection';

describe('parseFormalDescription (t/4574 spec §2.4)', () => {
  it('parses a well-formed genus-differentia description into lead + encompasses + excludes', () => {
    const desc = 'A Belief within accelerationist discourse that AI progress should be unregulated.\nEncompasses: open-source models, rapid deployment.\nExcludes: safety-first regulation.';
    const parsed = parseFormalDescription(desc);
    expect(parsed).toEqual({
      lead: 'A Belief within accelerationist discourse that AI progress should be unregulated.',
      encompasses: 'open-source models, rapid deployment.',
      excludes: 'safety-first regulation.',
    });
  });

  it('parses when only Encompasses is present', () => {
    const desc = 'A Desire within safetyist discourse for caution.\nEncompasses: slow rollout, audits.';
    const parsed = parseFormalDescription(desc);
    expect(parsed?.lead).toBe('A Desire within safetyist discourse for caution.');
    expect(parsed?.encompasses).toBe('slow rollout, audits.');
    expect(parsed?.excludes).toBeUndefined();
  });

  it('falls back to null (full-text paragraphs) when neither marker is present — never drops text', () => {
    const desc = 'A plain description with no genus-differentia markers at all.';
    expect(parseFormalDescription(desc)).toBeNull();
  });

  it('falls back to null when the lead would be empty', () => {
    const desc = 'Encompasses: something.\nExcludes: something else.';
    expect(parseFormalDescription(desc)).toBeNull();
  });

  it('returns null for an undefined description', () => {
    expect(parseFormalDescription(undefined)).toBeNull();
  });
});
