// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/786: drive loadAiSettings itself with a saved settings file. fileIO.test.ts proves the pure
// helper (migrateRetiredModel); this proves loadAiSettings actually calls it, so deleting the
// call turns this file red.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => process.cwd() },
}));

// CONFIG_DIR is os.homedir()/.poviewer, computed at module load. Point homedir at an isolated
// temp dir so this test never reads or writes the real ~/.poviewer.
const FAKE_HOME = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'poviewer-t786-home-'));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const patched = { ...actual, homedir: () => FAKE_HOME };
  return { ...patched, default: patched };
});

let fileIO: typeof import('./fileIO.js');
beforeAll(async () => {
  fileIO = await import('./fileIO.js');
});

const SETTINGS_FILE = path.join(FAKE_HOME, '.poviewer', 'ai-settings.json');

function saveRaw(model: string): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ model, temperature: 0.4 }), 'utf-8');
}

describe('t/786 loadAiSettings migrates a saved retired Gemini id', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(SETTINGS_FILE, { force: true });
  });

  it.each([
    ['gemini-2.5-flash', 'gemini-3.5-flash-lite'],
    ['gemini-2.5-pro', 'gemini-3.8-flash'],
  ])('%s -> %s, keeps the other fields, and logs a WARN', (saved, successor) => {
    saveRaw(saved);
    expect(fileIO.loadAiSettings()).toEqual({ model: successor, temperature: 0.4 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`WARN.*${saved.replace(/\./g, '\.')}.*retired`)));
  });

  it('leaves a saved registry id alone without a WARN', () => {
    saveRaw('gemini-3.8-flash');
    expect(fileIO.loadAiSettings().model).toBe('gemini-3.8-flash');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves an unknown saved id unchanged and logs a WARN', () => {
    saveRaw('my-typo-model');
    expect(fileIO.loadAiSettings().model).toBe('my-typo-model');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WARN.*my-typo-model.*not in ai-models\.json/));
  });
});
