// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/787 (follow-up to t/785): nothing tested that App.tsx calls revalidateAIModel() after the model catalog
// settles, and that call is what keeps a saved retired model id from reaching the API (removing it left the
// suite green). This vitest setup is node-only with no DOM, so App cannot be rendered; instead:
// a source guard fails if the call is removed from App.tsx's startup effect (or from SettingsDialog).
// What revalidation does with a retired id is covered by aiModels.test.ts (getStoredModel); the store itself
// cannot be imported here because this config has no @lib/debate alias.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App startup revalidates the saved AI model (t/787)', () => {
  it('App.tsx calls revalidateAIModel() after initAIModels() settles', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toMatch(/initAIModels\(\)\s*\.then\(\s*\(\)\s*=>\s*useStore\.getState\(\)\.revalidateAIModel\(\)\s*\)/);
  });

  it('SettingsDialog also revalidates after its own catalog refresh', () => {
    const dialog = fs.readFileSync(path.resolve(__dirname, '../components/SettingsDialog.tsx'), 'utf8');
    expect(dialog).toMatch(/useStore\.getState\(\)\.revalidateAIModel\(\)/);
  });
});
