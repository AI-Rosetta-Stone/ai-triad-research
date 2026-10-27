// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1225 (org as a top-level taxonomy concept — per t/1217 HLD): index + query
// layer over organizations.json. The raw file read lives in storage/fileIO.ts
// (Server Storage, t/1229); this module owns typed parsing, the in-memory cache,
// the topic/policy reverse indexes, and the query helpers the REST routes call.

import { readOrganizations, readOrganizationEdges, getOrganizationsReadStatus } from './storage/fileIO.js';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

export type { Pov, PovStance, TopicEngagement, PolicyEngagement, Organization, OrganizationEdgeType, OrganizationEdge } from '../../../lib/organizations/types.js';
import type { Pov, PovAlignmentTier, Organization, OrganizationEdge } from '../../../lib/organizations/types.js';

const TIER_RANK: Record<PovAlignmentTier, number> = {
  opposes: -2, leans_against: -1, mixed_or_silent: 0, leans_toward: 1, champions: 2,
};

export const POV_CAMPS: readonly Pov[] = ['accelerationist', 'safetyist', 'skeptic'];
export function isPov(v: string): v is Pov {
  return (POV_CAMPS as readonly string[]).includes(v);
}

interface OrgIndexes {
  all: Organization[];
  byId: Map<string, Organization>;
  byTopic: Map<string, Organization[]>;   // topic_ref → orgs
  byPolicy: Map<string, Organization[]>;  // policy_ref → orgs
  edgesByOrg: Map<string, OrganizationEdge[]>;  // org id → incident edges (as source, or org-* target) (t/1530)
}

let cache: OrgIndexes | null = null;

function emptyIndexes(): OrgIndexes {
  return { all: [], byId: new Map(), byTopic: new Map(), byPolicy: new Map(), edgesByOrg: new Map() };
}

/** Index one org into byId + the topic/policy reverse maps. */
function indexOrg(idx: OrgIndexes, org: Organization): void {
  if (typeof org?.id === 'string') idx.byId.set(org.id, org);
  for (const t of org.topic_engagement ?? []) {
    if (!t?.topic_ref) continue;
    (idx.byTopic.get(t.topic_ref) ?? idx.byTopic.set(t.topic_ref, []).get(t.topic_ref)!).push(org);
  }
  for (const p of org.policy_engagement ?? []) {
    if (!p?.policy_ref) continue;
    (idx.byPolicy.get(p.policy_ref) ?? idx.byPolicy.set(p.policy_ref, []).get(p.policy_ref)!).push(org);
  }
}

/** Index one edge under its source, and (for org-to-org edges) under its target too. */
function indexEdge(idx: OrgIndexes, e: OrganizationEdge): void {
  if (!e || typeof e.source !== 'string') return;
  (idx.edgesByOrg.get(e.source) ?? idx.edgesByOrg.set(e.source, []).get(e.source)!).push(e);
  // Org-to-org edges (ALLIED_WITH/COMPETES_WITH/FUNDS) are indexed under the target too,
  // so an org sees incoming relationships, not just the ones it's the source of.
  if (typeof e.target === 'string' && e.target.startsWith('org-') && e.target !== e.source) {
    (idx.edgesByOrg.get(e.target) ?? idx.edgesByOrg.set(e.target, []).get(e.target)!).push(e);
  }
}

function buildIndexes(orgs: Organization[], edges: OrganizationEdge[]): OrgIndexes {
  const idx = emptyIndexes();
  idx.all = orgs;
  for (const org of orgs) indexOrg(idx, org);
  for (const e of edges) indexEdge(idx, e);
  return idx;
}

/**
 * Load organizations.json once and cache the parsed records + reverse indexes.
 * Degrades to an empty set when the file is absent (seeded later by t/1224) or
 * malformed — endpoints return [] rather than erroring. (t/1225)
 *
 * t/4584 (incident): a DEGRADED read (GitHub rate-limit exhaustion, circuit
 * open, no creds — see `getOrganizationsReadStatus`) must never cache an
 * empty result. Caching it here would make a transient GitHub failure
 * permanent for the life of the process, long after GitHub recovers, since
 * `if (cache) return cache` above would keep serving that empty set forever.
 * Only a genuinely resolved read (success OR a confirmed absence) is cached.
 */
async function load(): Promise<OrgIndexes> {
  if (cache) return cache;
  try {
    const raw = await readOrganizations();
    const edgesRaw = await readOrganizationEdges();
    const status = getOrganizationsReadStatus();
    if (status.degraded) {
      log.server.warn({ reason: status.reason }, 'organizations.load: degraded read, not caching — will retry next call');
      return emptyIndexes();
    }
    const list = (raw as { organizations?: unknown })?.organizations;
    const orgs = Array.isArray(list) ? (list as Organization[]).filter(o => o && typeof o.id === 'string') : [];
    const edges = Array.isArray(edgesRaw) ? edgesRaw.filter(e => e && typeof e.source === 'string') : [];
    cache = buildIndexes(orgs, edges);
  } catch (err) {
    log.server.warn({ err }, 'Failed to load organizations.json; serving empty set, will retry next call');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'organizations', level: 'error',
      message: 'Failed to load organizations.json; serving empty set, will retry next call',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return emptyIndexes(); // t/4584: not cached — a parse/index error may be transient too.
  }
  return cache;
}

/** Drop the in-memory cache (tests / hot-reload). */
export function resetOrganizationsCache(): void { cache = null; }

// ── Query helpers (1:1 with the REST routes) ──

/** All orgs, optionally filtered by `type` and/or alignment with a `pov` (leans_toward or champions). */
export async function listOrganizations(opts: { type?: string | null; pov?: string | null } = {}): Promise<Organization[]> {
  const { all } = await load();
  let out = all;
  if (opts.type) out = out.filter(o => o.type === opts.type);
  if (opts.pov && isPov(opts.pov)) {
    const pov = opts.pov;
    out = out.filter(o => {
      const tier = o.pov_alignment?.[pov]?.tier;
      return tier === 'leans_toward' || tier === 'champions';
    });
  }
  return out;
}

export async function getOrganizationById(id: string): Promise<Organization | null> {
  const { byId } = await load();
  return byId.get(id) ?? null;
}

/** Orgs aligned with `pov`; `for` → leans_toward/champions, `against` → opposes/leans_against. Sorted by tier strength desc. (t/1225 Q2) */
export async function organizationsByPov(
  pov: Pov, direction: 'for' | 'against' = 'for',
): Promise<Organization[]> {
  const { all } = await load();
  return all
    .filter(o => {
      const tier = o.pov_alignment?.[pov]?.tier;
      if (!tier) return false;
      const rank = TIER_RANK[tier];
      return direction === 'for' ? rank >= 1 : rank <= -1;
    })
    .sort((a, b) =>
      Math.abs(TIER_RANK[b.pov_alignment?.[pov]?.tier ?? 'mixed_or_silent']) -
      Math.abs(TIER_RANK[a.pov_alignment?.[pov]?.tier ?? 'mixed_or_silent']));
}

/** Orgs engaged with a situation/topic (`sit-*`). Reverse index. (HLD scenario #4) */
export async function organizationsByTopic(topicRef: string): Promise<Organization[]> {
  const { byTopic } = await load();
  return byTopic.get(topicRef) ?? [];
}

/** Orgs supporting/opposing a policy action (`pol-*`). Reverse index. (HLD scenario #6) */
export async function organizationsByPolicy(policyId: string): Promise<Organization[]> {
  const { byPolicy } = await load();
  return byPolicy.get(policyId) ?? [];
}

/**
 * All actor-relationship edges incident to `orgId` — where it's the `source`, or the
 * `target` of an org-to-org edge (`ALLIED_WITH`/`COMPETES_WITH`/`FUNDS`). Consumers
 * filter by `type` for allies/competitors/funders and read direction from
 * source/target. `[]` for an unknown org (consistent with the by-topic/by-policy
 * reverse-index helpers, which don't 404). (t/1530) */
export async function organizationEdges(orgId: string): Promise<OrganizationEdge[]> {
  const { edgesByOrg } = await load();
  return edgesByOrg.get(orgId) ?? [];
}
