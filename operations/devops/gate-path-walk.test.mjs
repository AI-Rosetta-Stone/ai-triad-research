// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/543: unit tests for gate-path-walk.mjs, one per syntax the resolver follows, each with a case it
// must NOT follow. Run: node --test operations/devops/gate-path-walk.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDependenciesOf, normaliseRepoPath, pathsNamedInWorkflow, stepWorkingDirectories, walkDependencies,
} from './gate-path-walk.mjs';

const FILES = new Set([
  'ops/a.mjs', 'ops/b.mjs', 'ops/c.ts', 'ops/d.cjs', 'ops/data.json', 'ops/lib/index.mjs', 'ops/e.json',
  'ops/V.ps1', 'ops/H.ps1', 'ops/M.psm1', 'ops/Sub/Child.ps1', 'mod/Shared.ps1',
  'ops/run.sh', 'ops/common.sh', 'ops/helper.mjs', 'ops/py.py',
  'scripts/check.sh', 'scripts/x.mjs', 'scripts/requirements.txt', 'lib/tsconfig.json', 'README.md',
]);
const deps = (file, text) => localDependenciesOf(file, text, FILES);

test('normaliseRepoPath: strips ./, backslashes and trailing slashes; refuses paths that leave the repo', () => {
  assert.equal(normaliseRepoPath('./a/b/../c.mjs'), 'a/c.mjs');
  assert.equal(normaliseRepoPath('a\\b.ps1'), 'a/b.ps1');
  assert.equal(normaliseRepoPath('../x'), null);
  assert.equal(normaliseRepoPath('/etc/passwd'), null);
});

test('JS: import from, export from, side-effect import, import(), require(), new URL(.., import.meta.url)', () => {
  assert.deepEqual(deps('ops/x.mjs', "import { a } from './a.mjs';\nexport * from \"./b.mjs\";"), ['ops/a.mjs', 'ops/b.mjs']);
  assert.deepEqual(deps('ops/x.mjs', "import './a.mjs';"), ['ops/a.mjs']);
  assert.deepEqual(deps('ops/x.mjs', "const m = await import( './b.mjs' );"), ['ops/b.mjs']);
  assert.deepEqual(deps('ops/x.cjs', "const d = require('./d.cjs');"), ['ops/d.cjs']);
  assert.deepEqual(deps('ops/x.mjs', "readFileSync(new URL('./data.json', import.meta.url))"), ['ops/data.json']);
});

test('JS: extensionless, directory index and TypeScript .js-for-.ts specifiers resolve', () => {
  assert.deepEqual(deps('ops/x.ts', "import { c } from './c.js';"), ['ops/c.ts']);
  assert.deepEqual(deps('ops/x.mjs', "import { l } from './lib';"), ['ops/lib/index.mjs']);
  assert.deepEqual(deps('scripts/y.mjs', "import { a } from '../ops/a';"), ['ops/a.mjs']);
});

test('JS negative: bare packages, node builtins, missing files and dynamic specifiers are ignored', () => {
  const text = [
    "import fs from 'node:fs';", "import { z } from 'zod';", "const p = require('path');",
    "import { q } from './missing.mjs';", "const m = await import(pathToFileURL(p).href);", "await import(`./${name}.mjs`);",
  ].join('\n');
  assert.deepEqual(deps('ops/x.mjs', text), []);
});

test('PowerShell: dot-sourcing by $PSScriptRoot, Join-Path, ./ and a repo-root variable', () => {
  assert.deepEqual(deps('ops/V.ps1', '. $PSScriptRoot/H.ps1'), ['ops/H.ps1']);
  assert.deepEqual(deps('ops/V.ps1', '. "$PSScriptRoot\\Sub\\Child.ps1"'), ['ops/Sub/Child.ps1']);
  assert.deepEqual(deps('ops/V.ps1', ". (Join-Path $PSScriptRoot '..' 'mod' 'Shared.ps1')"), ['mod/Shared.ps1']);
  assert.deepEqual(deps('ops/V.ps1', '. ./ops/H.ps1'), ['ops/H.ps1']);
  assert.deepEqual(deps('ops/V.ps1', ". (Join-Path $RepoRoot 'mod/Shared.ps1')"), ['mod/Shared.ps1']);
});

test('PowerShell Join-Path: -ChildPath flags and commas still parse; no exponential backtracking (CodeQL js/redos 6742)', () => {
  assert.deepEqual(deps('ops/V.ps1', ". (Join-Path -Path $PSScriptRoot -ChildPath 'Sub', 'Child.ps1')"), ['ops/Sub/Child.ps1']);
  assert.deepEqual(deps('ops/V.ps1', '. (Join-Path $PSScriptRoot "$name.ps1")'), []);
  // The alert's shape: an opening Join-Path followed by many repetitions of a quoted piece and a tab.
  // The old pattern backtracked exponentially on this; the linear one must answer at once.
  const evil = '. (Join-Path\t$_\t' + '"!"\t'.repeat(5000) + '!';
  const t0 = Date.now();
  assert.deepEqual(deps('ops/V.ps1', evil), []);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('PowerShell: Import-Module and & by a relative path', () => {
  assert.deepEqual(deps('ops/V.ps1', 'Import-Module "$PSScriptRoot/M.psm1" -Force'), ['ops/M.psm1']);
  assert.deepEqual(deps('ops/V.ps1', "Import-Module (Join-Path $PSScriptRoot 'M.psm1')"), ['ops/M.psm1']);
  assert.deepEqual(deps('ops/V.ps1', '& $PSScriptRoot/H.ps1 -Name x'), ['ops/H.ps1']);
  assert.deepEqual(deps('ops/V.ps1', 'pwsh -NoProfile -File ./ops/H.ps1'), ['ops/H.ps1']);
});

test('PowerShell negative: module by name, a dynamic variable, a comment and a missing file are ignored', () => {
  const text = ['Import-Module Pester', '. $wmr', '# . $PSScriptRoot/H.ps1', '. $PSScriptRoot/Nope.ps1', 'Import-Module -Name PSScriptAnalyzer'].join('\n');
  assert.deepEqual(deps('ops/V.ps1', text), []);
});

test('shell: source and . by a relative path, $(dirname "$0") and a script-dir variable', () => {
  assert.deepEqual(deps('ops/run.sh', 'source ./common.sh'), ['ops/common.sh']);
  assert.deepEqual(deps('ops/run.sh', '. "$(dirname "$0")/common.sh"'), ['ops/common.sh']);
  assert.deepEqual(deps('ops/run.sh', 'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n. "$HERE/common.sh"'), ['ops/common.sh']);
  assert.deepEqual(deps('ops/run.sh', 'DIR=$(dirname "$0")\nsource ${DIR}/common.sh'), ['ops/common.sh']);
});

test('shell: scripts run by node, bash and python, from the script dir or after a cd to an ancestor', () => {
  assert.deepEqual(deps('ops/run.sh', 'node helper.mjs --json > out\nbash "$(dirname "$0")/common.sh"'), ['ops/common.sh', 'ops/helper.mjs']);
  assert.deepEqual(deps('ops/run.sh', 'cd "$REPO_ROOT"\nnode --test scripts/x.mjs\npython3 ops/py.py'), ['ops/py.py', 'scripts/x.mjs']);
});

test('shell negative: an unknown variable, a parent-dir variable, an absolute path and a comment are ignored', () => {
  const text = [
    'source "$SOMEWHERE/common.sh"', 'UP="$(cd "$(dirname "$0")/.." && pwd)"', '. "$UP/common.sh"',
    'source /etc/profile', '# source ./common.sh', 'node -e "require(1)"',
  ].join('\n');
  assert.deepEqual(deps('ops/run.sh', text), []);
});

test('other file types (JSON, Python) have no followed dependencies', () => {
  assert.deepEqual(deps('ops/e.json', '{"import": "./a.mjs"}'), []);
  assert.deepEqual(deps('ops/py.py', 'from . import helper\nimport ops.a'), []);
});

test('walkDependencies: follows transitively, records the first loader, and stops where descend says no', () => {
  const texts = {
    'ops/a.mjs': "import './b.mjs';",
    'ops/b.mjs': "import './c.js';",
    'ops/c.ts': "import './lib/index.mjs';",
    'ops/lib/index.mjs': '',
  };
  const read = (f) => texts[f] ?? null;
  const all = walkDependencies(['ops/a.mjs'], read, FILES);
  assert.deepEqual([...all], [['ops/b.mjs', 'ops/a.mjs'], ['ops/c.ts', 'ops/b.mjs'], ['ops/lib/index.mjs', 'ops/c.ts']]);
  const stopped = walkDependencies(['ops/a.mjs'], read, FILES, { descend: (f) => f !== 'ops/b.mjs' });
  assert.deepEqual([...stopped.keys()], ['ops/b.mjs']);
});

test('stepWorkingDirectories: a literal working-directory applies to its own step only; an expression is ignored', () => {
  const lines = [
    '    steps:',
    '      - name: one',
    '        working-directory: scripts',
    '        run: bash check.sh',
    '      - name: two',
    '        run: bash check.sh',
    '      - name: three',
    '        working-directory: ${{ matrix.app }}',
    '        run: pnpm test',
  ];
  assert.deepEqual(stepWorkingDirectories(lines), ['', 'scripts', 'scripts', 'scripts', '', '', '', '', '']);
});

test('pathsNamedInWorkflow: quotes, ./, working-directory, GITHUB_WORKSPACE; skips comments, globs and non-files', () => {
  const wf = [
    'jobs:',
    '  j:',
    '    steps:',
    "      - run: node './scripts/x.mjs' --mode=block",
    '      - name: wd',
    '        working-directory: scripts',
    '        run: |',
    '          bash check.sh',
    '          pip install -r requirements.txt',
    '      - run: tsc -p "${{ github.workspace }}/lib/tsconfig.json"',
    '      # bash ops/run.sh   (a comment: not named)',
    "      - run: node --test 'ops/*.mjs' ops/{a,b}.mjs",
    '      - run: echo scripts lib ops/missing.mjs',
    '        env:',
    '          F: $GITHUB_WORKSPACE/README.md',
  ].join('\n');
  assert.deepEqual(pathsNamedInWorkflow(wf, FILES).map((x) => x.path),
    ['lib/tsconfig.json', 'README.md', 'scripts/check.sh', 'scripts/requirements.txt', 'scripts/x.mjs']);
  // `check.sh` outside the working-directory step does not resolve.
  assert.deepEqual(pathsNamedInWorkflow('      - run: bash check.sh', FILES), []);
});
