import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// t/4665 (TL, p/331#2547): the real bug was `stray-file-guard.yml` checking out the PR HEAD
// and running scripts/ci/stray-file-guard.mjs from it -- a PR branched before that file
// existed on main crashed with "Cannot find module". run-stray-file-guard.sh fixes this by
// sourcing the guard script from the base ref instead, and must fail OPEN (warn, exit 0) if
// the base ref somehow still lacks it, since the guard is warn-only.
//
// Exercises the real script against a real git repo (a bare "origin" plus a local clone)
// rather than mocking git, so a change to the git plumbing itself would be caught here too.

const SCRIPT = path.resolve(import.meta.dirname, '../run-stray-file-guard.sh');

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

function initBareOrigin(dir) {
  run('git', ['init', '--bare', dir]);
}

function initClone(originDir, cloneDir) {
  run('git', ['clone', originDir, cloneDir]);
  run('git', ['-C', cloneDir, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', cloneDir, 'config', 'user.name', 'Test']);
  // Normalize to 'main' regardless of the host's init.defaultBranch (e.g. 'master').
  run('git', ['-C', cloneDir, 'checkout', '-b', 'main']);
}

function commitAll(cloneDir, message) {
  run('git', ['-C', cloneDir, 'add', '-A']);
  run('git', ['-C', cloneDir, 'commit', '-m', message, '--allow-empty']);
  run('git', ['-C', cloneDir, 'push', 'origin', 'HEAD']);
}

describe('run-stray-file-guard.sh', () => {
  let tmpRoot;
  let originDir;
  let cloneDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stray-guard-test-'));
    originDir = path.join(tmpRoot, 'origin.git');
    cloneDir = path.join(tmpRoot, 'clone');
    initBareOrigin(originDir);
    initClone(originDir, cloneDir);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('fails open with a WARN when the base ref has no copy of the guard script', () => {
    // Base ref ("main") never gets the guard script -- simulates a PR cut before #4260.
    commitAll(cloneDir, 'base commit, no guard script');
    run('git', ['-C', cloneDir, 'checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(cloneDir, 'some-file.ts'), '// change\n');
    commitAll(cloneDir, 'feature commit');
    run('git', ['-C', cloneDir, 'fetch', 'origin']);

    const output = run('bash', [SCRIPT, 'main'], cloneDir);

    expect(output).toContain('::warning::');
    expect(output).toContain('stray-file-guard.mjs not found');
    // No throw => exit 0, which execFileSync would have thrown on a non-zero exit.
  });

  it('runs the guard from the base ref when it exists there, even if absent on the PR head', () => {
    // main HAS the guard script; the feature branch is cut from BEFORE that commit, so the
    // guard script is absent on the PR head too -- this is the exact shape of the real bug.
    commitAll(cloneDir, 'base commit, no guard script yet');
    run('git', ['-C', cloneDir, 'checkout', '-b', 'feature']);

    run('git', ['-C', cloneDir, 'checkout', 'main']);
    fs.mkdirSync(path.join(cloneDir, 'scripts', 'ci'), { recursive: true });
    // Real ESM syntax (import/export), matching the real stray-file-guard.mjs -- Sage p/26#362 /
    // TL p/331#2549: an earlier version of this stub had no import/export, so it ran fine even
    // when run-stray-file-guard.sh piped it into node via an extensionless mktemp path. Node's
    // loader only throws ERR_UNKNOWN_FILE_EXTENSION on ESM syntax without a resolvable
    // extension, so a CommonJS-shaped stub can't catch that regression.
    fs.writeFileSync(
      path.join(cloneDir, 'scripts', 'ci', 'stray-file-guard.mjs'),
      "import process from 'node:process';\n" +
      "process.stdin.resume(); process.stdin.on('end', () => { console.log('guard ran'); process.exit(0); });\n" +
      "export {};\n",
    );
    commitAll(cloneDir, 'add guard script to main');

    run('git', ['-C', cloneDir, 'checkout', 'feature']);
    fs.writeFileSync(path.join(cloneDir, 'some-file.ts'), '// change\n');
    commitAll(cloneDir, 'feature commit, still no guard script here');

    // The real workflow's actions/checkout populates every remote-tracking ref via
    // fetch-depth:0; this clone needs the same explicit fetch to see origin/main.
    run('git', ['-C', cloneDir, 'fetch', 'origin']);

    const output = run('bash', [SCRIPT, 'main'], cloneDir);

    expect(output).not.toContain('::warning::');
    expect(output).toContain('guard ran');
  });
});
