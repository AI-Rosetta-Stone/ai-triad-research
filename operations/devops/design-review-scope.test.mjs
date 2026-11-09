// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/design-review-scope.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUserFacing, isUserFacingPath } from './design-review-scope.mjs';

test('renderer .tsx/.css under taxonomy-editor/src/renderer is user-facing', () => {
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/components/x/Thing.tsx'), true);
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/App.css'), true);
});

test('poviewer and summary-viewer src are user-facing', () => {
  assert.equal(isUserFacingPath('poviewer/src/components/Chart.tsx'), true);
  assert.equal(isUserFacingPath('summary-viewer/src/App.css'), true);
});

test('introCopy.ts and index.html are user-facing even though they are not .tsx/.css under those dirs', () => {
  assert.equal(isUserFacingPath('lib/electron-shared/introCopy.ts'), true);
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/index.html'), true);
  assert.equal(isUserFacingPath('index.html'), true);
});

test('test/fixture files under a user-facing dir are excluded', () => {
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/components/x/Thing.test.tsx'), false);
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/components/__tests__/Thing.tsx'), false);
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/components/__fixtures__/sample.tsx'), false);
  assert.equal(isUserFacingPath('poviewer/src/components/Chart.spec.tsx'), false);
});

test('a non-user-facing path (server, bridge, ps, non-renderer) is not user-facing', () => {
  assert.equal(isUserFacingPath('operations/devops/enqueue-pr.mjs'), false);
  assert.equal(isUserFacingPath('taxonomy-editor/src/server/routes/oped.ts'), false);
  assert.equal(isUserFacingPath('taxonomy-editor/src/main/ipc/bridge.ts'), false);
  assert.equal(isUserFacingPath('scripts/AITriad/Public/Get-Thing.ps1'), false);
});

test('a .ts (not .tsx/.css) file under renderer is not user-facing (only .tsx/.css match the dir rule)', () => {
  assert.equal(isUserFacingPath('taxonomy-editor/src/renderer/utils/helper.ts'), false);
});

test('isUserFacingPath handles null/empty/undefined without throwing', () => {
  assert.equal(isUserFacingPath(null), false);
  assert.equal(isUserFacingPath(undefined), false);
  assert.equal(isUserFacingPath(''), false);
});

test('isUserFacing: true when ANY file in the set is user-facing, false when none are', () => {
  assert.equal(isUserFacing(['operations/devops/enqueue-pr.mjs', 'taxonomy-editor/src/renderer/App.css']), true);
  assert.equal(isUserFacing(['operations/devops/enqueue-pr.mjs', 'docs/foo.md']), false);
  assert.equal(isUserFacing([]), false);
  assert.equal(isUserFacing(undefined), false);
});

test('isUserFacing accepts either plain path strings or {path} objects (gh pr view --json files shape)', () => {
  assert.equal(isUserFacing([{ path: 'taxonomy-editor/src/renderer/App.css' }]), true);
  assert.equal(isUserFacing([{ path: 'docs/foo.md' }]), false);
});
