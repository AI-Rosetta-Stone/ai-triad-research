// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/645: launch the desktop app ITSELF with Playwright's Electron mode, run a scenario, write screenshots.
// It never attaches to an app it didn't start (the reason electron-mcp was rejected, TL p/10#301). Playwright
// drives the app it launches over a localhost-only debugging port, which closes with the app.
// Test-only stubs (dialog results, IPC handler overrides) are applied at run time from the scenario, in this
// process's control of the launched app. Nothing here is part of a shipped build.
//
// Security conditions (t/644, p/306#2), enforced below:
//   - the app gets an allowlisted environment, never this shell's (no AI or GitHub credentials);
//   - the app runs on a throwaway --user-data-dir, never the PI's profile;
//   - --data-root is required and must be a scratch copy: not the real ai-triad-data tree, not a git clone;
//   - --out must be outside the repo.
//
// Usage (from taxonomy-editor/):
//   node scripts/electron-capture/capture.mjs --scenario <file.mjs> --out <dir> --data-root <scratch dir> [--exe <path> | --dev]
//     --exe        the app to launch; default: release/win-unpacked/<product>.exe (run `npm run pack` first)
//     --dev        launch the dev build instead (`electron .`; needs `npm run dev:vite` on :5173)
//     --data-root  AI_TRIAD_DATA_ROOT for the app: a scratch copy of the data, required
//   Exit 0 when the scenario finishes; 1 with harness.log and error.png in --out otherwise; 2 on bad arguments.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const teDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(teDir, '..');

/** Environment variables the launched app may see. Everything else (API keys, tokens) is withheld. */
export const ENV_ALLOWLIST = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive', 'ComSpec', 'COMSPEC', 'PATH', 'Path', 'PATHEXT',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'XDG_RUNTIME_DIR',
];

export function allowlistedEnv(source) {
  const env = {};
  for (const k of ENV_ALLOWLIST) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

/** True when `child` is `parent` or inside it. */
export function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The main checkout that owns `root`: in a worktree `git rev-parse --git-common-dir` is `<main>/.git`, so its
 *  parent is the main checkout. `root` itself when it is the main checkout or git can't say (t/743). */
export function mainCheckoutOf(root = repoRoot) {
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return common ? dirname(common) : root;
  } catch { return root; }
}

/** The real data trees a capture must never run against: .aitriad.json's data_root and this shell's AI_TRIAD_DATA_ROOT.
 *  `.aitriad.json`'s data_root is relative ("../ai-triad-data"), so from a worktree it is resolved against both the
 *  worktree and the main checkout; protecting both is the safe side, and the main checkout's is the real one (t/743).
 *  WARNs through `warn` when the configured data_root exists in neither place, so a guard that protects nothing is visible. */
export function protectedDataRoots(root = repoRoot, env = process.env, warn = console.warn, mainRoot = mainCheckoutOf(root)) {
  const roots = [];
  let cfgFound = false;
  for (const base of new Set([root, mainRoot])) {
    try {
      const cfg = JSON.parse(readFileSync(join(base, '.aitriad.json'), 'utf8'));
      cfgFound = true;
      if (cfg.data_root) roots.push(resolve(base, cfg.data_root));
    } catch { /* no .aitriad.json here: nothing configured to protect beyond the env var */ }
  }
  if (cfgFound && roots.length > 0 && !roots.some((r) => existsSync(r))) {
    warn(`WARN electron-capture: .aitriad.json data_root resolves to ${roots.join(' and ')}, which does not exist; the data-root guard protects nothing from it`);
  }
  if (env.AI_TRIAD_DATA_ROOT) roots.push(resolve(env.AI_TRIAD_DATA_ROOT));
  return [...new Set(roots.map(real))];
}

/** The nearest ancestor of `p` (or `p` itself) that is a git checkout (has a .git dir or file), or null. */
export function enclosingRepo(p) {
  for (let dir = resolve(p); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Why `dataRoot` is refused, or null when it is an acceptable scratch copy. */
export function dataRootProblem(dataRoot, protectedRoots) {
  const p = real(dataRoot);
  if (!existsSync(p)) return `--data-root ${p} does not exist`;
  const hit = protectedRoots.find((r) => isWithin(p, r) || isWithin(r, p));
  if (hit) return `--data-root ${p} overlaps the real data tree ${hit}; use a scratch copy`;
  const repo = enclosingRepo(p);
  if (repo) return `--data-root ${p} is inside the git checkout ${repo}; use a plain scratch copy outside any repo so nothing can be pushed`;
  return null;
}

function main() {
  const { values: args } = parseArgs({
    options: {
      scenario: { type: 'string' }, out: { type: 'string' }, exe: { type: 'string' },
      dev: { type: 'boolean', default: false }, 'data-root': { type: 'string' },
    },
  });
  const usage = (why) => {
    if (why) console.error(`capture: ${why}`);
    console.error('usage: capture.mjs --scenario <file.mjs> --out <dir outside the repo> --data-root <scratch copy> [--exe <path> | --dev]');
    process.exit(2);
  };
  if (!args.scenario || !args.out || !args['data-root']) usage('--scenario, --out and --data-root are required');
  const out = resolve(args.out);
  const repo = enclosingRepo(out);
  if (repo) usage(`--out ${out} is inside the git checkout ${repo}; write shots outside any repo`);
  const dataProblem = dataRootProblem(args['data-root'], protectedDataRoots());
  if (dataProblem) usage(dataProblem);
  return { args, out, dataRoot: real(args['data-root']) };
}

function defaultExe() {
  const dir = join(teDir, 'release', 'win-unpacked');
  const exe = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.exe') && !/uninstall/i.test(f)) : undefined;
  if (!exe) throw new Error(`No packed app in ${dir}. Run \`npm run pack\` first, or pass --exe or --dev.`);
  return join(dir, exe);
}

async function run({ args, out, dataRoot }) {
  mkdirSync(out, { recursive: true });
  const { _electron: electron } = createRequire(join(teDir, 'package.json'))('@playwright/test');
  const scenario = (await import(pathToFileURL(resolve(args.scenario)).href)).default;
  const log = [];
  const note = (m) => { const line = `${new Date().toISOString()} ${m}`; log.push(line); console.log(m); };

  const userDataDir = mkdtempSync(join(tmpdir(), 'electron-capture-profile-'));
  const env = { ...allowlistedEnv(process.env), AI_TRIAD_DATA_ROOT: dataRoot };
  const appArgs = [`--user-data-dir=${userDataDir}`];
  const launch = args.dev
    ? { args: [teDir, ...appArgs], cwd: teDir, env }
    : { executablePath: args.exe ? resolve(args.exe) : defaultExe(), args: appArgs, env };
  note(`launching ${args.dev ? 'dev build' : launch.executablePath}; data root ${dataRoot}; profile ${userDataDir}; env ${Object.keys(env).length} allowlisted vars`);

  const app = await electron.launch({ ...launch, timeout: 120_000 });
  let win;
  try {
    const profile = await app.evaluate(({ app: a }) => a.getPath('userData'));
    if (real(profile) !== real(userDataDir)) throw new Error(`the app is using profile ${profile}, not the throwaway ${userDataDir}; stopping before the scenario`);
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
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`WARN capture: couldn't remove the throwaway profile ${userDataDir}: ${err && err.message}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(main());
