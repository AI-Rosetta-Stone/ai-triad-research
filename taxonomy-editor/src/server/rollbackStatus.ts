// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Deployment / rollback status (t/871, design: production-rollback-design.md P1#3).
 *
 * Surfaces what's running and what to roll back to, for the admin rollback UI:
 * - Deploy identity (revision, SHA, tag, image) comes from env vars the deploy
 *   workflow sets (DEPLOY_SHA/DEPLOY_TAG) plus the ACA-injected
 *   CONTAINER_APP_REVISION. Missing vars resolve to null.
 * - knownGoodTag is the previous published semver tag, fetched from the GHCR
 *   tags list (cached) — the most likely rollback target.
 */

import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { log } from './logger.js';

export interface RollbackStatus {
  activeRevision: string | null;
  deploySha: string | null;
  deployTag: string | null;
  deployTimestamp: string | null;
  imageTag: string | null;
  knownGoodTag: string | null;
  previousRevision: string | null;
}

const GHCR_PACKAGE = process.env.GHCR_PACKAGE || 'ai-rosetta-stone/taxonomy-editor';
const KNOWN_GOOD_TTL_MS = 10 * 60 * 1000;
let _knownGoodCache: { tag: string | null; expires: number } | null = null;

type Semver = [number, number, number];

function parseSemver(tag: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpSemver(a: Semver, b: Semver): number {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

/**
 * The previous published semver tag (the likely rollback target), from GHCR.
 * Cached for 10 min. Best-effort: any failure falls back to the KNOWN_GOOD_TAG
 * env var, then null (AC#4). The GHCR package is public — pull uses an anonymous
 * bearer token.
 */
export async function fetchKnownGoodTag(currentTag: string | null): Promise<string | null> {
  if (_knownGoodCache && _knownGoodCache.expires > Date.now()) return _knownGoodCache.tag;
  let tag: string | null = process.env.KNOWN_GOOD_TAG || null;
  try {
    const tokenRes = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${GHCR_PACKAGE}:pull`);
    if (tokenRes.ok) {
      const { token } = await tokenRes.json() as { token?: string };
      if (token) {
        const tagsRes = await fetch(`https://ghcr.io/v2/${GHCR_PACKAGE}/tags/list`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (tagsRes.ok) {
          const { tags } = await tagsRes.json() as { tags?: string[] };
          const semvers = (tags ?? [])
            .map(t => ({ t, v: parseSemver(t) }))
            .filter((x): x is { t: string; v: Semver } => x.v !== null)
            .sort((a, b) => cmpSemver(b.v, a.v)); // newest first
          const cur = currentTag ? parseSemver(currentTag) : null;
          // Prior tag = highest semver strictly below the current deploy; if the
          // current tag isn't semver, fall back to the second-newest published.
          const prior = cur ? semvers.find(x => cmpSemver(x.v, cur) < 0) : semvers[1];
          if (prior) tag = prior.t;
        }
      }
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'rollback-status', level: 'warn',
      message: 'GHCR known-good tag lookup failed; using fallback',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.warn({ err }, 'GHCR known-good tag lookup failed');
  }
  _knownGoodCache = { tag, expires: Date.now() + KNOWN_GOOD_TTL_MS };
  return tag;
}

/** Assemble the current deployment / rollback status. */
export async function getRollbackStatus(): Promise<RollbackStatus> {
  const deployTag = process.env.DEPLOY_TAG || null;
  const deploySha = process.env.DEPLOY_SHA || null;
  const imageTag = process.env.DEPLOY_IMAGE
    || (deployTag ? `ghcr.io/${GHCR_PACKAGE}:${deployTag}` : null);
  return {
    activeRevision: process.env.CONTAINER_APP_REVISION || null,
    deploySha,
    deployTag,
    deployTimestamp: process.env.DEPLOY_TIMESTAMP || null,
    imageTag,
    knownGoodTag: await fetchKnownGoodTag(deployTag),
    previousRevision: process.env.PREVIOUS_REVISION || null,
  };
}

/** Test-only: clear the known-good cache. */
export function _resetKnownGoodCache(): void { _knownGoodCache = null; }
