// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/645: launch the desktop app ITSELF with Playwright's Electron mode, run a scenario, write screenshots.
// It never attaches to an app it didn't start (the reason electron-mcp was rejected, TL p/10#301).
// Test-only stubs (dialog results, IPC handler overrides) are applied at run time from the scenario, in this
// process's control of the launched app. Nothing here is part of a shipped build.
//
// Usage (from taxonomy-editor/):
//   node scripts/electron-capture/capture.mjs --scenario <file.mjs> --out <dir> [--exe <path>] [--data-root <dir>]
//     --exe        the app to launch; default: release/win-unpacked/<product>.exe (run `npm run pack` first)
//     --dev        launch the dev build instead (`electron .`; needs `npm run build` and nothing on :5173)
//     --data-root  sets AI_TRIAD_DATA_ROOT for the app (the app refuses to start without a readable data root)
//   Exit 0 when the scenario finishes; 1 with harness.log and error.png in --out otherwise.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const teDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' }, out: { type: 'string' }, exe: { type: 'string' },
    dev: { type: 'boolean', default: false }, 'data-root': { type: 'string' },
  },
});
if (!args.scenario || !args.out) {
  console.error('usage: capture.mjs --scenario <file.mjs> --out <dir> [--exe <path> | --dev] [--data-root <dir>]');
  process.exit(2);
}

function defaultExe() {
  const dir = join(teDir, 'release', 'win-unpacked');
  const exe = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.exe') && !/uninstall/i.test(f)) : undefined;
  if (!exe) throw new Error(`No packed app in ${dir}. Run \`npm run pack\` first, or pass --exe or --dev.`);
  return join(dir, exe);
}

const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const { _electron: electron } = createRequire(join(teDir, 'package.json'))('@playwright/test');
const scenario = (await import(pathToFileURL(resolve(args.scenario)).href)).default;
const log = [];
const note = (m) => { const line = `${new Date().toISOString()} ${m}`; log.push(line); console.log(m); };

const env = { ...process.env };
if (args['data-root']) env.AI_TRIAD_DATA_ROOT = args['data-root'];
const launch = args.dev
  ? { args: [teDir], cwd: teDir, env }
  : { executablePath: args.exe ? resolve(args.exe) : defaultExe(), env };
note(`launching ${args.dev ? 'dev build' : launch.executablePath}`);

const app = await electron.launch({ ...launch, timeout: 120_000 });
let win;
try {
  win = await app.firstWindow({ timeout: 120_000 });
  await win.setViewportSize({ width: 1280, height: 860 });
  await win.waitForLoadState('domcontentloaded');

  /** Helpers handed to the scenario. All stubs act on this launched app only. */
  const h = {
    app, win, note,
    /** Make dialog.showOpenDialog return the given path(s) (test-time stub in main). */
    stubOpenDialog: (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, [].concat(paths)),
    /** Replace an ipcMain.handle channel with one that returns `value` (test-time stub in main). */
    overrideHandler: (channel, value) => app.evaluate(({ ipcMain }, [c, v]) => { ipcMain.removeHandler(c); ipcMain.handle(c, async () => v); }, [channel, value]),
    setTheme: (theme) => win.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme),
    setWidth: (width, height = 860) => win.setViewportSize({ width, height }),
    /** A fixed caption in the corner, so every shot says what it is. */
    label: (text) => win.evaluate((t) => {
      let l = document.getElementById('capture-label');
      if (!l) {
        l = document.createElement('div'); l.id = 'capture-label';
        Object.assign(l.style, { position: 'fixed', bottom: '6px', left: '6px', zIndex: '2147483647', font: '11px monospace', padding: '3px 6px', border: '1px dashed #888', background: 'rgba(255,255,200,0.95)', color: '#333', pointerEvents: 'none', maxWidth: 'calc(100vw - 12px)' });
        document.body.appendChild(l);
      }
      l.textContent = t;
    }, text),
    shot: async (name) => { await win.waitForTimeout(400); await win.screenshot({ path: join(out, `${name}.png`) }); note(`shot ${name}.png`); },
  };
  await scenario(h);
  note('scenario finished');
} catch (err) {
  note(`ERROR: ${err && err.stack || err}`);
  if (win) await win.screenshot({ path: join(out, 'error.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'harness.log'), log.join('\n') + '\n');
  await app.close().catch(() => {});
}
