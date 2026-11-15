#!/usr/bin/env node
// Generate THIRD-PARTY-NOTICES.txt for a pnpm workspace package.
//
// Why this exists: generate-license-file@4 walks the local node_modules tree and
// does NOT follow pnpm's symlinked virtual store, so under pnpm it silently drops
// every transitive dependency and lists only direct deps (t/2292 fallout). It was
// also effectively a no-op in CI/build: its "overwrite? (N)" prompt defaults to No
// in a non-TTY, so `npm run licenses` never actually regenerated the file.
//
// This script instead asks pnpm itself for the package's production closure
// (`pnpm --filter <pkg> licenses list --prod --json`) — correct and scoped to this
// importer — then reads each package's license text from the store and emits the
// same block format the old tool produced (so taxonomy-editor's
// scripts/parse-licenses.cjs keeps working).
//
// Output is deterministic (stable sort) so re-running is idempotent — no spurious
// diffs unless the dependency set actually changed.
//
// Usage: node generate-notices.cjs [--output THIRD-PARTY-NOTICES.txt] [--check]
//   --check : generate in memory and exit non-zero if it differs from --output
//             (for CI drift detection); does not write.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { output: 'THIRD-PARTY-NOTICES.txt', check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') out.output = argv[++i];
    else if (argv[i] === '--check') out.check = true;
  }
  return out;
}

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)(\.|$)/i;

/**
 * Resolve the actual on-disk pnpm virtual-store directory for a package.
 *
 * `pnpm licenses list --json` on Windows returns a hashed peer-dep suffix
 * (e.g. `react-markdown@10.1.0_@type_e84814f...`) that does NOT match the
 * real on-disk directory name (`react-markdown@10.1.0_@types+react@19.2.18_...`).
 * This function scans `.pnpm/` for the matching entry so `readLicenseText`
 * can always find the license file (t/2969 — Windows parity fix).
 */
function resolveActualPkgDir(dir) {
  // Fast path: directory already exists (Linux/CI, and Windows when hash matches).
  try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* fall through */ }
  // Slow path: scan .pnpm/ for the real directory entry.
  // dir: .../node_modules/.pnpm/<hashedEntry>/node_modules/<pkgName>[/...]
  const m = /^(.+[/\\]node_modules[/\\]\.pnpm[/\\])([^/\\]+)((?:[/\\]node_modules[/\\].+)?)$/.exec(dir);
  if (!m) return dir;
  const [, pnpmRoot, hashedEntry, tail] = m;
  // Extract name@version prefix: everything up to the first peer-dep separator
  // ('_' that appears after the version's '@'). For scoped packages the name
  // starts with '@'; skip that '@' when finding the version separator.
  const vAt = hashedEntry.indexOf('@', hashedEntry.startsWith('@') ? 1 : 0);
  if (vAt === -1) return dir;
  const uIdx = hashedEntry.indexOf('_', vAt);
  const prefix = uIdx === -1 ? hashedEntry : hashedEntry.slice(0, uIdx);
  // prefix e.g. "react-markdown@10.1.0" or "@types+react@19.2.18"
  let entries;
  try { entries = fs.readdirSync(pnpmRoot); } catch { return dir; }
  const candidates = entries.filter(e => e === prefix || e.startsWith(prefix + '_'));
  if (candidates.length === 1) {
    // Normalize tail separator and join to form the resolved path.
    const resolvedTail = tail ? tail.replace(/^[/\\]/, '') : '';
    return path.join(pnpmRoot, candidates[0], resolvedTail);
  }
  // Multiple candidates (different peer-dep combos) — can't resolve unambiguously.
  return dir;
}

/** Read the best-effort license text for a package from its installed directory. */
function readLicenseText(pkgDir, spdx, pkgId) {
  const resolvedDir = resolveActualPkgDir(pkgDir);
  let dirAccessible = false;
  try {
    const files = fs.readdirSync(resolvedDir);
    dirAccessible = true;
    // Prefer a plain LICENSE file; fall back to any LICENSE-* variant.
    const exact = files.filter(f => LICENSE_FILE_RE.test(f))
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const f of exact) {
      const full = path.join(resolvedDir, f);
      // Single fd (open → fstat → read → close) so the is-file check and the
      // read act on the same handle — no TOCTOU race (js/file-system-race).
      let fd;
      try {
        fd = fs.openSync(full, 'r');
        if (fs.fstatSync(fd).isFile()) {
          const txt = fs.readFileSync(fd, 'utf-8').replace(/\r\n/g, '\n').trim();
          if (txt) return txt;
        }
      } catch { /* unreadable — try next */ } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      }
    }
  } catch { /* dir gone or unreadable */ }
  const fallback = spdx && spdx !== 'Unknown' ? spdx : 'License text not provided by the package author.';
  // Emit an observable warning when the package directory couldn't be found even
  // after path resolution — silent SPDX substitution is the silent-degradation
  // anti-pattern (t/2969). Packages that exist on disk but ship without a license
  // file (dirAccessible=true, no LICENSE) are intentional and do not warn.
  if (!dirAccessible) {
    const label = pkgId || path.basename(resolvedDir);
    process.stderr.write(
      `::warning::generate-notices: package dir not found for ${label}` +
      ` — falling back to SPDX "${fallback}". Resolved path: ${resolvedDir}\n`
    );
  }
  return fallback;
}

function guardShouldRefuse(branch, isLinkedWorktree, isCI) {
  return branch === 'main' && !isLinkedWorktree && !isCI;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkgJsonPath = path.resolve('package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.error('generate-notices: no package.json in the current directory');
    process.exit(1);
  }
  const pkgName = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).name;
  // Validate against the npm package-name charset before it reaches a subprocess.
  if (!pkgName || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName)) {
    console.error(`generate-notices: package.json "name" missing or not a valid npm name: ${pkgName}`);
    process.exit(1);
  }

  // Preflight: node_modules must be present to produce a complete license list.
  // Running without them yields a partial/empty set and silently commits incorrect
  // output — an early exit with a clear message is preferable (t/2969).
  if (!fs.existsSync(path.resolve('node_modules'))) {
    console.error(
      'generate-notices: node_modules not found in the current directory' +
      ' — run "pnpm install" first'
    );
    process.exit(1);
  }

  // Preflight: refuse to run on the shared main checkout to prevent accidental
  // dirty-tree incidents (t/2969). Linked worktrees have a git-dir path that
  // contains "/worktrees/" or "\worktrees\"; the primary checkout does not.
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const isLinkedWorktree = /[/\\]worktrees[/\\]/.test(gitDir);
    if (guardShouldRefuse(branch, isLinkedWorktree, Boolean(process.env.CI))) {
      console.error(
        'generate-notices: refusing to run on the shared main checkout — ' +
        'use a linked worktree instead: git worktree add -b <branch> .worktrees/<name>'
      );
      process.exit(1);
    }
  } catch { /* git unavailable or not a repo — skip guard */ }

  // Ask pnpm for this importer's production dependency closure with store paths.
  // On Windows `pnpm` is a .cmd shim which execFile can't spawn directly (EINVAL);
  // invoke it through cmd.exe with args as discrete argv entries (no shell:true,
  // so no DEP0190 arg-concatenation risk). pkgName is validated above.
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'cmd.exe' : 'pnpm';
  const binArgs = (isWin ? ['/c', 'pnpm'] : [])
    .concat(['--filter', pkgName, 'licenses', 'list', '--prod', '--json']);
  let raw;
  try {
    raw = execFileSync(bin, binArgs, {
      encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    console.error(`generate-notices: "pnpm --filter ${pkgName} licenses list" failed: ${err.message}`);
    process.exit(1);
  }

  const byLicenseType = JSON.parse(raw); // { "MIT": [ {name, versions, paths, license}, ... ], ... }

  // Flatten to one row per (name@version), resolving each to a store dir + text.
  const rows = [];
  for (const entries of Object.values(byLicenseType)) {
    for (const e of entries) {
      const versions = e.versions && e.versions.length ? e.versions : [''];
      const paths = e.paths && e.paths.length ? e.paths : [];
      versions.forEach((v, i) => {
        const dir = paths[i] || paths[0];
        if (!dir) return;
        rows.push({ id: v ? `${e.name}@${v}` : e.name, dir, spdx: e.license || 'Unknown' });
      });
    }
  }
  // Deduplicate identical name@version (a pkg can appear under multiple parents).
  const seen = new Set();
  const unique = rows.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));

  // ── @img/sharp-* cross-platform normalization ────────────────────────────
  // pnpm licenses list only returns packages installed on the *current*
  // platform. @img/sharp-* are optional native-binary shims — Linux CI
  // installs @img/sharp-linux-x64 while Windows installs @img/sharp-win32-x64
  // — causing non-deterministic output across platforms (t/2920 blocker 2).
  // Fix: enumerate ALL @img/sharp-* variants from pnpm-lock.yaml and replace
  // the platform-installed set so output is identical on any OS.
  //
  // SPDX mapping (stable for the sharp package family):
  //   @img/sharp-libvips-*  → LGPL-3.0-or-later  (libvips native C library)
  //   @img/sharp-*          → Apache-2.0           (sharp platform binary shim)
  const SHARP_RE = /^@img\/sharp-/;
  // @napi-rs/canvas is an optional native-binary family (pulled by pdfjs-dist's optionalDependencies).
  // Normalized the same way as sharp, so the notices don't depend on which platform generated them (t/273).
  // License: MIT for every variant.
  const CANVAS_RE = /^@napi-rs\/canvas/;
  // Pre-populate spdxTextCache from installed packages before stripping sharp.
  // Apache-2.0 is always available via sharp@0.35.x (installed on every OS).
  // LGPL-3.0-or-later falls back to the SPDX identifier when libvips is not
  // installed locally — @img/sharp-libvips-* do not ship a LICENSE file, so
  // readLicenseText returns the SPDX string in all cases anyway.
  const spdxTextCache = new Map();
  for (const r of unique) {
    if (!spdxTextCache.has(r.spdx)) {
      const t = readLicenseText(r.dir, r.spdx, r.id);
      if (t !== r.spdx) spdxTextCache.set(r.spdx, t);
    }
  }
  // Read ALL @img/sharp-* packages from the root pnpm-lock.yaml.
  const lockPath = path.resolve('..', 'pnpm-lock.yaml');
  const sharpAll = [];
  if (fs.existsSync(lockPath)) {
    const lockContent = fs.readFileSync(lockPath, 'utf-8');
    // Guard: fail loudly if a new platform-conditional prod dep appears outside the
    // @img/sharp-* normalizer — prevents a silent false-fire on the blocking gate.
    // Triggered? Extend the normalization block in this script to cover the new family.
    // Scans packages: section only (not snapshots/importers); resets on every entry
    // (scoped or non-scoped) to prevent cpu/os from one package bleeding across
    // boundaries into the next (t/2969 — broadened from scoped-only).
    //
    // A package is "platform-conditional" only when its cpu/os is RESTRICTIVE —
    // i.e. it excludes at least one common platform (win32/darwin/linux) or is
    // limited to a single CPU arch. A package with os:[win32,darwin,linux] is
    // cross-platform and must NOT be flagged (t/2969 — onnxruntime-node false-positive fix).
    { const gLines = lockContent.split('\n');
      const COMMON_OS = ['win32', 'darwin', 'linux'];
      const platformIds = new Set();
      let inPkgs = false; let curPkg = null; let isRestricted = false;
      for (const ln of gLines) {
        if (ln === 'packages:') { inPkgs = true; continue; }
        if (inPkgs && /^\S/.test(ln)) { // new top-level section — end of packages:
          if (curPkg && isRestricted) platformIds.add(curPkg);
          inPkgs = false; curPkg = null; isRestricted = false; continue;
        }
        if (!inPkgs) continue;
        if (/^  \S/.test(ln)) { // any package entry at 2-space indent
          if (curPkg && isRestricted) platformIds.add(curPkg);
          // Match both scoped (@scope/name) and non-scoped (name) packages.
          const gm = /^  '?(@[^'@]+|[^'@\s][^'@]*)@([^':\s]+)'?:/.exec(ln);
          curPkg = gm ? `${gm[1].replace(/\\/g, '/')}@${gm[2]}` : null;
          isRestricted = false;
        } else if (curPkg) {
          // os: [win32] is restrictive; os: [win32,darwin,linux] is not.
          const osM = /^\s+os:\s*\[([^\]]*)\]/.exec(ln);
          if (osM) {
            const osList = osM[1].split(',').map(s => s.trim().replace(/'/g, ''));
            if (COMMON_OS.some(o => !osList.includes(o))) isRestricted = true;
          }
          // cpu: [x64] is restrictive (single-arch); broader lists are not.
          const cpuM = /^\s+cpu:\s*\[([^\]]*)\]/.exec(ln);
          if (cpuM) {
            const cpuList = cpuM[1].split(',').map(s => s.trim().replace(/'/g, ''));
            if (cpuList.length <= 1) isRestricted = true;
          }
        }
      }
      if (inPkgs && curPkg && isRestricted) platformIds.add(curPkg);
      const unexpected = unique.filter(r => {
        const name = r.id.lastIndexOf('@') > 0 ? r.id.slice(0, r.id.lastIndexOf('@')) : r.id;
        return platformIds.has(r.id) && !SHARP_RE.test(name) && !CANVAS_RE.test(name);
      });
      if (unexpected.length > 0) {
        console.error(`generate-notices: platform-specific prod dep(s) outside the @img/sharp-* ` +
          `normalizer detected: ${unexpected.map(r => r.id).join(', ')}. ` +
          `Extend the lockfile normalization block in generate-notices.cjs to cover the new family.`);
        process.exit(1);
      }
    }
    const pkgRe = /^\s+'(@img\/sharp-[^']+)@([^']+)':/gm;
    const seenSharp = new Set();
    let m;
    while ((m = pkgRe.exec(lockContent)) !== null) {
      const id = `${m[1]}@${m[2]}`;
      if (!seenSharp.has(id)) {
        seenSharp.add(id);
        const spdx = m[1].startsWith('@img/sharp-libvips-') ? 'LGPL-3.0-or-later' : 'Apache-2.0';
        sharpAll.push({ id, dir: '', spdx });
      }
    }
    // Same for every @napi-rs/canvas variant in the lock (all MIT).
    const canvasRe = /^\s+'(@napi-rs\/canvas[^']*)@([^']+)':/gm;
    const seenCanvas = new Set();
    while ((m = canvasRe.exec(lockContent)) !== null) {
      const id = `${m[1]}@${m[2]}`;
      if (!seenCanvas.has(id)) {
        seenCanvas.add(id);
        sharpAll.push({ id, dir: '', spdx: 'MIT' });
      }
    }
  }
  // Replace platform-installed @img/sharp-* and @napi-rs/canvas-* with the canonical cross-platform set.
  const resolvedRows = sharpAll.length > 0
    ? [...unique.filter(r => !SHARP_RE.test(r.id) && !CANVAS_RE.test(r.id)), ...sharpAll]
    : unique;

  // Group packages that share identical license text into one block.
  const groups = new Map(); // licenseText -> Set(id)
  for (const r of resolvedRows) {
    // For lockfile-sourced entries (no local install, dir=''), use spdxTextCache
    // populated from the installed peer; fall back to the SPDX identifier.
    const text = r.dir
      ? readLicenseText(r.dir, r.spdx, r.id)
      : (spdxTextCache.get(r.spdx) ?? r.spdx);
    if (!groups.has(text)) groups.set(text, new Set());
    groups.get(text).add(r.id);
  }

  // Deterministic ordering: sort ids in each block, blocks by their first id.
  const blocks = [...groups.entries()]
    .map(([text, ids]) => ({ text, ids: [...ids].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.ids[0].localeCompare(b.ids[0]));

  const header =
    'This file lists the licenses of the third-party npm packages bundled in this product.\n' +
    'Generated by scripts/generate-notices.cjs (pnpm-aware; see the script header for why).\n';

  const parts = [header];
  for (const block of blocks) {
    const plural = block.ids.length > 1;
    parts.push(
      '\n-----------\n\n' +
      `The following npm package${plural ? 's' : ''} may be included in this product:\n\n` +
      block.ids.map(id => ` - ${id}`).join('\n') + '\n\n' +
      (plural
        ? 'These packages each contain the following license:\n\n'
        : 'This package contains the following license:\n\n') +
      block.text + '\n',
    );
  }
  const output = parts.join('') + '\n';

  const outPath = path.resolve(args.output);
  if (args.check) {
    const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').replace(/\r\n/g, '\n') : '';
    if (existing.trim() !== output.trim()) {
      console.error(`generate-notices: ${args.output} is out of date — run "npm run licenses" and commit.`);
      process.exit(1);
    }
    console.log(`generate-notices: ${args.output} is up to date (${resolvedRows.length} packages).`);
    return;
  }
  fs.writeFileSync(outPath, output, 'utf-8');
  console.log(`generate-notices: wrote ${args.output} (${resolvedRows.length} packages, ${blocks.length} license blocks).`);
}

if (require.main === module) main();

// Exported for unit testing only (t/2973).
module.exports = { _guardShouldRefuse: guardShouldRefuse };
