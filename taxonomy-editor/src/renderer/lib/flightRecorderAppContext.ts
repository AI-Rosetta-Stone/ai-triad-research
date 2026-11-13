// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418: the local-run fields of the flight-recorder context.app block. They name the worktree that
// produced a dump. Electron and dev only: web and container builds get null, so server paths never
// reach a user-downloadable dump.

export interface AppPathFields {
  build_root: string | null;
  git_branch: string | null;
  app_path: string | null;
}

export function appPathFields(input: {
  isElectron: boolean;
  buildRoot: string | null | undefined;
  gitBranch: string | null | undefined;
  appPath: string | null | undefined;
}): AppPathFields {
  if (!input.isElectron) return { build_root: null, git_branch: null, app_path: null };
  return {
    build_root: input.buildRoot ?? null,
    git_branch: input.gitBranch ?? null,
    app_path: input.appPath ?? null,
  };
}

// Declared by vite.config.ts `define`; `typeof` keeps the reads safe where a define is absent (tests).
declare const __BUILD_ROOT__: string | null;
declare const __BUILD_BRANCH__: string | null;

/** The context.app fields for the running build. `eApi` is the Electron bridge, undefined in web builds. */
export function localRunContext(eApi: { appPath?: string | null } | undefined): AppPathFields {
  return appPathFields({
    isElectron: !!eApi,
    buildRoot: typeof __BUILD_ROOT__ !== 'undefined' ? __BUILD_ROOT__ : null,
    gitBranch: typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : null,
    appPath: eApi?.appPath ?? null,
  });
}
