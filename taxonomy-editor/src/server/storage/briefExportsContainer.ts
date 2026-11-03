// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4756 (t/4738 prevention): the single place the brief exports blob container name is resolved.
 *
 * Staging isolation (t/2643) depends on every blob store reading the SAME env var:
 * staging sets `AZURE_BRIEF_EXPORTS_CONTAINER=staging-brief-exports`, prod uses the default.
 * A store that hard-codes the prod name instead silently writes staging traffic into prod's container.
 */
export const DEFAULT_BRIEF_EXPORTS_CONTAINER = 'brief-exports';

export function briefExportsContainer(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZURE_BRIEF_EXPORTS_CONTAINER || DEFAULT_BRIEF_EXPORTS_CONTAINER;
}

/** True when the container came from the env var rather than the prod default. */
export function isBriefExportsContainerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AZURE_BRIEF_EXPORTS_CONTAINER);
}
