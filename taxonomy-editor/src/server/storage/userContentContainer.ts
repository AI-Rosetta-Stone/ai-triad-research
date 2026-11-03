// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4733/t/4738: the single place the user-content blob container name is resolved.
 *
 * Staging isolation (t/2643) depends on every blob store reading the SAME env var:
 * staging sets `AZURE_USER_CONTENT_CONTAINER=staging-user-content`, prod uses the default.
 * A store that hard-codes the prod name instead (the free-pool budget did, t/4733) silently
 * writes staging traffic into prod's container. `userContentContainerLiteral.test.ts` fails
 * if any other server module spells the prod container name out.
 */
export const DEFAULT_USER_CONTENT_CONTAINER = 'user-content';

export function userContentContainer(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZURE_USER_CONTENT_CONTAINER || DEFAULT_USER_CONTENT_CONTAINER;
}

/** True when the container came from the env var rather than the prod default. */
export function isUserContentContainerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AZURE_USER_CONTENT_CONTAINER);
}
