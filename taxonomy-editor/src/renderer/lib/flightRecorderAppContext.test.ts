// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418: the local-run fields name the worktree that produced a dump. They are present in Electron
// and null in web/container builds, so server paths never reach a downloadable dump.

import { describe, it, expect } from 'vitest';
import { appPathFields, redactHomePath } from './flightRecorderAppContext';

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

// Security (t/418, p/246#2): the home prefix never reaches a dump; the rest of the path stays.
describe('redactHomePath — t/418 home-prefix placeholder', () => {
  it('replaces a Windows home prefix and keeps the worktree path', () => {
    expect(redactHomePath('C:\\Users\\jsnov\\repos\\ai-triad-research\\.worktrees\\t417-lazy\\taxonomy-editor'))
      .toBe('%USERPROFILE%\\repos\\ai-triad-research\\.worktrees\\t417-lazy\\taxonomy-editor');
  });

  it('replaces a POSIX home prefix', () => {
    expect(redactHomePath('/home/jsnov/src/app')).toBe('%USERPROFILE%/src/app');
    expect(redactHomePath('/Users/jsnov/src/app')).toBe('%USERPROFILE%/src/app');
  });

  it('redacts a packaged app path under the user profile the same way as a dev path', () => {
    expect(redactHomePath('C:\\Users\\jsnov\\AppData\\Local\\Programs\\@interweavedesktop\\resources\\app.asar'))
      .toBe('%USERPROFILE%\\AppData\\Local\\Programs\\@interweavedesktop\\resources\\app.asar');
  });

  it('leaves a path outside the user profile unchanged, and null stays null', () => {
    expect(redactHomePath('D:\\build\\taxonomy-editor')).toBe('D:\\build\\taxonomy-editor');
    expect(redactHomePath(null)).toBeNull();
  });

  it('applies the placeholder to build_root and app_path in Electron', () => {
    expect(appPathFields({ isElectron: true, buildRoot: 'C:\\Users\\jsnov\\x', gitBranch: 'b', appPath: 'C:\\Users\\jsnov\\y' }))
      .toEqual({ build_root: '%USERPROFILE%\\x', git_branch: 'b', app_path: '%USERPROFILE%\\y' });
  });
});
