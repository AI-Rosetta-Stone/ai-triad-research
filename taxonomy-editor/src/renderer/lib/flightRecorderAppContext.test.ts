// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418: the local-run fields name the worktree that produced a dump. They are present in Electron
// and null in web/container builds, so server paths never reach a downloadable dump.

import { describe, it, expect } from 'vitest';
import { appPathFields } from './flightRecorderAppContext';

const LOCAL = {
  buildRoot: 'C:/repos/ai-triad-research/.worktrees/ux-integration/taxonomy-editor',
  gitBranch: 'test/ux-integration',
  appPath: 'C:/repos/ai-triad-research/.worktrees/ux-integration/taxonomy-editor',
};

describe('appPathFields — t/418 local run context', () => {
  it('records build_root, git_branch and app_path in Electron', () => {
    expect(appPathFields({ isElectron: true, ...LOCAL })).toEqual({
      build_root: LOCAL.buildRoot,
      git_branch: LOCAL.gitBranch,
      app_path: LOCAL.appPath,
    });
  });

  it('is null in web and container builds, even when the globals are set', () => {
    expect(appPathFields({ isElectron: false, ...LOCAL })).toEqual({
      build_root: null,
      git_branch: null,
      app_path: null,
    });
  });

  it('is null per field when Electron did not supply a value', () => {
    expect(appPathFields({ isElectron: true, buildRoot: undefined, gitBranch: null, appPath: undefined })).toEqual({
      build_root: null,
      git_branch: null,
      app_path: null,
    });
  });
});
