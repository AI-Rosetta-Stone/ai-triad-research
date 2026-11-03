// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4756 (t/4738 prevention): the single place the community blob container name is resolved.
 *
 * Staging isolation (t/2643) depends on every blob store reading the SAME env var:
 * staging sets `AZURE_COMMUNITY_CONTAINER=staging-community`, prod uses the default.
 * A store that hard-codes the prod name instead silently writes staging traffic into prod's container.
 */
export const DEFAULT_COMMUNITY_CONTAINER = 'community';

export function communityContainer(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZURE_COMMUNITY_CONTAINER || DEFAULT_COMMUNITY_CONTAINER;
}

/** True when the container came from the env var rather than the prod default. */
export function isCommunityContainerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AZURE_COMMUNITY_CONTAINER);
}
