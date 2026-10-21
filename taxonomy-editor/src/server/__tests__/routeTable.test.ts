// @vitest-environment node
//
// t/1295 — acceptance evidence for the server.ts route extraction (B-209).
// TL-approved invariant (t/1295#7): the extraction is zero-behaviour-change iff
//   1. the route SET is unchanged (no add/drop), and
//   2. every pair of routes that can match a common request (unifiable patterns)
//      keeps its relative registration order.
// matchRoute is first-match, so those are the only order-relevant facts — this is
// necessary AND sufficient. The ordered table is kept as an informational diff
// (expected to change as clusters consolidate) — see extractRoutes.ts.

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractRoutes, findCollisionPairs } from './extractRoutes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'server.ts');

describe('server.ts route table (t/1295 — zero-behaviour-change guard)', () => {
  const routes = extractRoutes(serverEntry);

  it('registers exactly 190 routes', () => {
    expect(routes.length).toBe(247); // +GET /api/diag/forwarded-headers (t/4410, TEMPORARY, staging-only); +GET /api/node-source-index/:nodeId (t/4334/t/4335 per-node transport);
    // +POST /api/sync/overlay-conflicts/{use-theirs,keep-mine} (t/4312/t/4315 overlay-conflict resolution); +GET /api/proposals/:filename (t/4192 single-proposal version read); +POST /api/policy-registry/recount (t/4039); +GET /api/pov-tag-proposals + POST /api/pov-tag-proposals/review (t/4055); +POST /api/node-delete-log (t/3860); +POST/DELETE /api/inquiry/:jobId/share (t/3626 mint/revoke) + GET /api/public/inquiry/:shareId (t/3653 public read); +GET /api/community/inquiries + GET /api/community/inquiries/:id (t/3621 community inquiry reader surface); +GET /api/inquiry list — "My Questions" (t/3619); +POST /api/inquiry + GET /api/inquiry/:jobId (t/3581 inquiry job routes); +GET/POST/DELETE /api/admin/allowlist (t/3498 admin Gemini allowlist CRUD); +POST /api/admin/opeds/backfill-own-shares (t/3490 own-share backfill admin route); +POST /api/admin/community/opeds/backfill-shares (t/3484 admin backfill); +GET /api/public/opeds (t/3481 public op-ed index); +POST/DELETE /api/community/opeds/:id/share (t/3315 community op-ed public share); +POST /api/argument-network/attribution (t/3297 server-side claim attribution); +POST /api/taxonomy/relevant-nodes (t/3257 T2 server-side relevance); +POST/POST /internal/canary/loop-sampler/{start,report} (t/3206); +GET /readyz deploy warm-gate (t/3112); +POST/GET/DELETE /api/templates (t/2853); +GET /api/brief-exports/quota-status (t/2831);+POST /api/debates/:debateId/exports, GET /api/export-jobs/:jobId, GET /api/debates/:debateId/exports, GET /api/exports/:exportId/artifacts/:name, DELETE /api/exports/:exportId (t/2804 Brief Export T6); +GET /api/admin/usages (t/1265); +GET /api/organizations/:id/edges (t/1530); +POST/DELETE /api/cruxes/:id/evidence (t/1541); +PATCH /api/debates/:id (t/1636); +GET /api/entity/:ref (t/1786); +GET /api/public/pov/:pov/node/:nodeId (t/1788); +PUT /api/edges (t/1821); +GET /api/entities (t/1883); +GET /api/container-mentions/:containerId (t/1902); +GET /api/greatest-hits (t/1998); +GET/PUT /api/preferences (t/2119); +POST /api/ai/chat-stream (t/2457); +GET /api/analytics/engagement (t/2467); +GET/GET/DELETE /api/oped-sets(/:id) + GET/GET /api/community/opeds(/:id) (t/2573); +GET /api/oped-sets/quota-status (t/2573); +PUT /api/oped-sets/:id rename (t/2594); +POST /api/oped-sets create-SSE + GET /api/oped-runs/:runId (t/2610); +POST/DELETE /api/oped-sets/:setId/share + GET /api/public/oped/:shareId (t/2727); +GET /api/health/embeddings (t/2789)
  });

  // GATE 1 — set identity: sorted (method, path) multiset. Fails on any add/drop.
  it('route set is unchanged', () => {
    expect(routes.map(r => `${r.method} ${r.path}`).sort()).toMatchSnapshot();
  });

  // GATE 2 — collision-pair order: each entry encodes earlier-registered on the
  // left, so this fails if a colliding pair is added, dropped, or reordered.
  it('unifiable route pairs preserve registration order', () => {
    expect(findCollisionPairs(routes)).toMatchSnapshot();
  });

  // INFORMATIONAL — the ordered table WILL change as clusters consolidate; update
  // with `vitest -u` per extraction commit and review the diff. Not a correctness
  // gate (gates 1 & 2 are), just a human-readable record of the move.
  it('ordered route table (informational — expected to change as clusters move)', () => {
    expect(routes.map(r => `${r.method} ${r.path}`)).toMatchSnapshot();
  });
});
