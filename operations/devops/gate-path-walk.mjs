// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/543: helpers for gate-file-change.test.mjs. They keep the protected set in
// gate-file-change.mjs honest:
//   pathsNamedInWorkflow  every repo file a workflow (or composite action) names in its text
//   localDependenciesOf   the repo files one script loads or runs by a relative path
//   walkDependencies      the transitive closure of localDependenciesOf
// All three are PURE given the set of repo files. Only listRepoFiles and readRepoText touch disk.
//
// Known limits (each one under-reports, so a gap here is a gap in the test):
//   - A path built at run time ($VAR/x.sh with an unknown VAR, `${{ matrix.app }}`, string
//     concatenation or path.join in JS, Join-Path with a variable segment) is not resolved.
//   - Globs (operations/devops/*.test.mjs, test_*.py) are not expanded.
//   - Indirect invocation is not followed: `pnpm run <script>` (the package.json scripts block),
//     a tool reading its config by default name (eslint.config.mjs, vitest.config.ts), pytest
//     discovering conftest.py. Those files are only found when a workflow names them.
//   - Data a script reads (readFileSync of a JSON allowlist, `jq ... file.json`) is not followed,
//     except JS `new URL('./x', import.meta.url)`.
//   - JS scripts that spawn another script (execFileSync('node', ['x.mjs'])) are not followed.
//   - Python imports are not followed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const posix = path.posix;

/** Every file git tracks under repoRoot, repo-relative with forward slashes. Throws with next steps on failure. */
export function listRepoFiles(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    throw new Error(
      `gate-path-walk: could not list the repo's files with \`git -C ${repoRoot} ls-files\` (${err.message}). ` +
      'Run the test from a git checkout with git on PATH.',
    );
  }
  return new Set(out.split('\0').filter(Boolean));
}

/** Reads a repo-relative file as UTF-8, or null when it cannot be read. */
export function readRepoText(repoRoot, rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return null;
  }
}

/** PURE. Normalises a candidate path to repo-relative form, or null when it leaves the repo. */
export function normaliseRepoPath(p) {
  if (typeof p !== 'string' || !p) return null;
  let s = posix.normalize(p.replace(/\\/g, '/'));
  if (s.startsWith('/') || s === '..' || s.startsWith('../')) return null;
  s = s.replace(/^\.\//, '').replace(/\/+$/, '');
  return s && s !== '.' ? s : null;
}

// ---------------------------------------------------------------------------------------------
// Workflow text

const STEP_KEY = /^(\s*)-\s+(?:name|uses|run|id|if|with|env|shell|working-directory|timeout-minutes|continue-on-error)\s*:/;
const WORKSPACE_PREFIX = /\$\{\{\s*github\.workspace\s*\}\}\/|"?\$\{?GITHUB_WORKSPACE\}?"?\//g;
const TOKEN = /[A-Za-z0-9_.@+\-/*?{}[\]]+/g;

/**
 * PURE. The working directory of the step each line belongs to: '' for none, and '' for one that
 * is an expression such as `${{ matrix.app }}`, which cannot be resolved here.
 */
export function stepWorkingDirectories(lines) {
  const wd = new Array(lines.length).fill('');
  let i = 0;
  while (i < lines.length) {
    const m = STEP_KEY.exec(lines[i]);
    if (!m) { i += 1; continue; }
    const indent = m[1].length;
    let end = i + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() !== '' && (l.length - l.trimStart().length) <= indent) break;
      end += 1;
    }
    let dir = '';
    for (let k = i; k < end; k += 1) {
      const w = /^\s*(?:-\s+)?working-directory\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(lines[k]);
      if (w) { dir = w[1].includes('${{') ? '' : (normaliseRepoPath(w[1]) ?? ''); break; }
    }
    for (let k = i; k < end; k += 1) wd[k] = dir;
    i = end;
  }
  return wd;
}

/**
 * PURE. Every repo file (a member of fileSet) that a workflow or composite-action text names, as
 * [{ path, line }] sorted by path, with the first line it is named on. Full-line comments and
 * tokens with glob characters are skipped. A token is tried from the repo root and, inside a step
 * with a literal `working-directory:`, relative to that directory. Quotes, `./`,
 * `${{ github.workspace }}/` and `$GITHUB_WORKSPACE/` prefixes are stripped.
 */
export function pathsNamedInWorkflow(text, fileSet) {
  const lines = String(text).split(/\r?\n/);
  const wds = stepWorkingDirectories(lines);
  const found = new Map();
  lines.forEach((raw, idx) => {
    if (/^\s*#/.test(raw)) return;
    const line = raw.replace(WORKSPACE_PREFIX, '');
    for (const tok of line.match(TOKEN) ?? []) {
      if (/[*?{}[\]]/.test(tok)) continue;
      const t = tok.replace(/^[@+-]+(?=[A-Za-z0-9_./])/, '').replace(/[.,;:]+$/, '');
      if (!/[A-Za-z0-9_]/.test(t)) continue;
      const candidates = [normaliseRepoPath(t)];
      if (wds[idx]) candidates.push(normaliseRepoPath(`${wds[idx]}/${t}`));
      for (const c of candidates) {
        if (c && fileSet.has(c) && !found.has(c)) found.set(c, idx + 1);
      }
    }
  });
  return [...found].map(([p, line]) => ({ path: p, line })).sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------------------------
// Script dependencies

const JS_EXT = /\.(?:mjs|cjs|js|jsx|ts|mts|cts|tsx)$/;
const PS_EXT = /\.(?:ps1|psm1|psd1)$/i;
const SH_EXT = /\.(?:sh|bash)$/;
const JS_TRY = ['', '.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.json', '/index.mjs', '/index.js', '/index.ts'];
const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|mts|sh|bash|ps1|psm1|py)$/;

function firstExisting(cands, fileSet) {
  for (const c of cands) {
    const n = normaliseRepoPath(c);
    if (n && fileSet.has(n)) return n;
  }
  return null;
}

function resolveJs(spec, dir, fileSet) {
  const base = posix.join(dir, spec);
  const cands = JS_TRY.map((e) => base + e);
  // TypeScript sources import './x.js' for a file that is x.ts on disk.
  const ts = /\.([mc]?)js$/.exec(base);
  if (ts) cands.push(base.slice(0, -ts[0].length) + `.${ts[1]}ts`, base.slice(0, -ts[0].length) + '.tsx');
  return firstExisting(cands, fileSet);
}

/** PURE. Relative specifiers a JS/TS source loads: import/export from, side-effect import, import(), require(), new URL(.., import.meta.url). */
export function jsRelativeSpecifiers(text) {
  const specs = [];
  const res = [
    /\bfrom\s*['"](\.{1,2}\/[^'"\n]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
    /\bnew\s+URL\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const re of res) for (const m of String(text).matchAll(re)) specs.push(m[1]);
  return specs;
}

/**
 * PURE. One PowerShell path expression as a relative path, or null. `$PSScriptRoot` paths are
 * relative to the script's directory. A path under another variable (`$RepoRoot`, `$root`) keeps
 * only its literal tail; the caller tries it from the script's directory and each ancestor, which
 * includes the repo root.
 */
function psPathExpr(expr) {
  const e = expr.trim();
  // CodeQL js/redos (alert 6742): no nested quantifier here. Match the head once, take the rest
  // as one group, then check the rest is ONLY quoted literals, -ChildPath/-AdditionalChildPath
  // flags, commas and whitespace (a linear scan), and read the literals out of it.
  const jp = /^\(\s*Join-Path\s+(?:-Path\s+)?\$\{?[A-Za-z_]\w*\}?\s+([^()]*)\)$/i.exec(e);
  if (jp) {
    const rest = jp[1];
    const leftover = rest.replace(/'[^'$]*'|"[^"$]*"|-(?:Additional)?ChildPath\b|[\s,]/gi, '');
    const parts = [...rest.matchAll(/'([^'$]+)'|"([^"$]+)"/g)].map((m) => m[1] ?? m[2]);
    return leftover === '' && parts.length ? parts.join('/') : null;
  }
  const s = e.replace(/^["']|["']$/g, '');
  const m = /^\$\{?[A-Za-z_]\w*\}?[\\/]([^$]+)$/.exec(s);
  if (m) return m[1];
  if (/^\.\.?[\\/]/.test(s)) return s;
  return null;
}

const PS_ARG = String.raw`(\(\s*Join-Path[^)]*\)|"[^"]+"|'[^']+'|\S+)`;

/** PURE. Relative paths a PowerShell script loads: dot-sourcing, Import-Module and `&`, by a $PSScriptRoot or ./ path. */
export function psRelativeSpecifiers(text) {
  const specs = [];
  const forms = [
    new RegExp(String.raw`^\s*\.\s+` + PS_ARG),
    new RegExp(String.raw`\bImport-Module\s+(?:-Name\s+)?` + PS_ARG, 'i'),
    new RegExp(String.raw`(?:^|[\s;(|])&\s+` + PS_ARG),
  ];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    for (const re of forms) {
      const m = re.exec(line);
      if (!m) continue;
      const rel = psPathExpr(m[1]);
      if (rel) specs.push(rel.replace(/\\/g, '/'));
    }
  }
  return specs;
}

const DIRNAME = String.raw`\$\(\s*dirname\s+["']?\$(?:0|\{BASH_SOURCE(?:\[0\])?\}|BASH_SOURCE)["']?\s*\)`;

/** PURE. Shell variables that hold the script's own directory: X="$(dirname "$0")", X=$(cd "$(dirname "$0")" && pwd). */
function shellDirVars(src) {
  const dirVars = new Set();
  for (const m of src.matchAll(/^\s*(?:readonly\s+|local\s+|export\s+|declare\s+-r\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm)) {
    // The script's own directory, not a path under or above it.
    if (/dirname\s+["']?\$(?:0|\{BASH_SOURCE|BASH_SOURCE)/.test(m[2]) && !/\)["']?\/|\/\.\./.test(m[2])) dirVars.add(m[1]);
  }
  return dirVars;
}

// $(dirname "$0") holds quotes and a space, so it is swapped for this marker before arguments are split.
const SCRIPT_DIR_MARK = '@SCRIPTDIR@';
const markScriptDir = (line) => line.replace(new RegExp(DIRNAME, 'g'), SCRIPT_DIR_MARK);

/** PURE. Strips a leading $(dirname "$0")/ or script-dir variable; null when another variable leads. */
function stripShellDir(p, dirVars) {
  const s = p.startsWith(`${SCRIPT_DIR_MARK}/`) ? p.slice(SCRIPT_DIR_MARK.length + 1) : p;
  const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(.+)$/.exec(s);
  if (v) return dirVars.has(v[1]) ? v[2] : null;
  return s;
}

const usable = (p) => p != null && !p.includes('$') && !p.startsWith('/') && !p.startsWith('~');

/** PURE. Relative paths a shell script sources: `source x` / `. x` with a relative, $(dirname "$0") or script-dir-variable path. */
export function shRelativeSpecifiers(text) {
  const src = String(text);
  const dirVars = shellDirVars(src);
  const specs = [];
  for (const raw of src.split(/\r?\n/)) {
    const m = /^\s*(?:source|\.)\s+("[^"]+"|'[^']+'|\S+)/.exec(markScriptDir(raw));
    if (!m) continue;
    const p = stripShellDir(m[1].replace(/^["']|["']$/g, ''), dirVars);
    if (usable(p)) specs.push(p);
  }
  return specs;
}

const INVOKE = new RegExp(
  String.raw`(?:^|[\s;&|(\x60])(?:node|bash|sh|pwsh|python3?|tsx|npx\s+tsx|pnpm\s+exec\s+tsx)\s+` +
  String.raw`(?:-{1,2}[A-Za-z][\w-]*(?:=\S+)?\s+)*("[^"\n]+"|'[^'\n]+'|[^\s;|&)'"]+)`,
  'g',
);

/**
 * PURE. Script paths a shell or PowerShell script RUNS: `node x.mjs`, `bash x.sh`, `pwsh -File x.ps1`,
 * `python x.py`, `tsx x.ts` (options between the interpreter and the path are skipped). The path may
 * be relative, $(dirname "$0")/... or a script-dir variable (shell), or $PSScriptRoot/... (PowerShell).
 */
export function invokedSpecifiers(text, { shell = true } = {}) {
  const src = String(text);
  const dirVars = shell ? shellDirVars(src) : null;
  const specs = [];
  for (const raw of src.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    for (const m of (shell ? markScriptDir(raw) : raw).matchAll(INVOKE)) {
      const q = m[1].replace(/^["']|["']$/g, '');
      if (!SCRIPT_EXT.test(q)) continue;
      const p = shell ? stripShellDir(q, dirVars) : (psPathExpr(q) ?? q);
      if (usable(p)) specs.push(p.replace(/\\/g, '/'));
    }
  }
  return specs;
}

/** The script's directory joined with spec, then each ancestor directory up to the repo root. */
function fromDirAndAncestors(dir, spec) {
  const out = [];
  for (let d = dir; ; d = posix.dirname(d)) {
    out.push(d === '.' ? spec : posix.join(d, spec));
    if (d === '.' || d === '') break;
  }
  return out;
}

/**
 * PURE. The repo files one script loads or runs by a relative path. Bare package imports (node
 * builtins, npm packages, PowerShell modules by name) are ignored. JS/TS specifiers resolve from
 * the script's directory. PowerShell `./x` and shell paths depend on the caller's (or a `cd`'s)
 * directory; they are tried from the script's directory, then each ancestor up to the repo root.
 */
export function localDependenciesOf(file, text, fileSet) {
  const dir = posix.dirname(file);
  const out = new Set();
  let specs = [];
  if (JS_EXT.test(file)) {
    for (const s of jsRelativeSpecifiers(text)) { const r = resolveJs(s, dir, fileSet); if (r) out.add(r); }
  } else if (PS_EXT.test(file)) {
    specs = [...psRelativeSpecifiers(text), ...invokedSpecifiers(text, { shell: false })];
  } else if (SH_EXT.test(file)) {
    specs = [...shRelativeSpecifiers(text), ...invokedSpecifiers(text)];
  }
  for (const s of specs) { const r = firstExisting(fromDirAndAncestors(dir, s), fileSet); if (r) out.add(r); }
  out.delete(file);
  return [...out].sort();
}

/**
 * PURE given readText. Follows localDependenciesOf from every start file until nothing new.
 * `descend(file)` decides whether a reached file's own dependencies are followed (default: all).
 * The gate test descends only through protected files: what product code loads is product code.
 * Returns Map<reached file, the file that first loaded it>. Start files are not in the map.
 */
export function walkDependencies(starts, readText, fileSet, { descend = () => true } = {}) {
  const seen = new Set(starts);
  const reachedFrom = new Map();
  const queue = [...starts];
  while (queue.length) {
    const f = queue.shift();
    const text = readText(f);
    if (text == null) continue;
    for (const dep of localDependenciesOf(f, text, fileSet)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      reachedFrom.set(dep, f);
      if (descend(dep)) queue.push(dep);
    }
  }
  return reachedFrom;
}
