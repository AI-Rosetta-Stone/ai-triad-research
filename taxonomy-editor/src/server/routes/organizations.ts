// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1383 (route extraction, t/1347 follow-up): the /api/organizations route
// cluster (t/1225, read-only public taxonomy data), moved verbatim out of
// server.ts behind the registration seam. Handlers depend only on module-level
// imports, so ServerCtx is threaded but unused. No collision pairs — /:id is
// 3-segment, the by-* routes 4-segment (see routeTable.test.ts).

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, query } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import * as organizations from '../organizations.js';
import { isPov } from '../organizations.js';
import { getOrganizationsReadStatus } from '../storage/fileIO.js';

export function registerOrganizationsRoutes(r: Router, _ctx: ServerCtx): void {
  const { get } = r;

  // GET /api/organizations?type=&pov=  — list all (optional type / pov-alignment filters)
  get('/api/organizations', async (req, res) => {
    try {
      const rows = await organizations.listOrganizations({ type: query(req, 'type'), pov: query(req, 'pov') });
      // t/4584 (TL incident, root cause: GitHub App rate-limit exhaustion): an
      // empty list from a DEGRADED read must not render as "no organizations" —
      // that was the incident's actual symptom. 503, not 200 [].
      if (rows.length === 0) {
        const status = getOrganizationsReadStatus();
        if (status.degraded) {
          error(res, `Organizations registry temporarily unavailable: ${status.reason}`, 503);
          return;
        }
      }
      json(res, rows);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to list organizations', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // GET /api/organizations/by-pov/:pov?direction=for|against&threshold=0.3
  get('/api/organizations/by-pov/:pov', async (req, res) => {
    try {
      const pov = param(req, 'pov', '/api/organizations/by-pov/:pov');
      if (!isPov(pov)) { error(res, `Unknown POV camp: ${pov}`, 400); return; }
      const direction = query(req, 'direction') === 'against' ? 'against' : 'for';
      json(res, await organizations.organizationsByPov(pov, direction));
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to query organizations by POV', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // GET /api/organizations/by-topic/:topicRef  — orgs engaged with a situation (sit-*)
  get('/api/organizations/by-topic/:topicRef', async (req, res) => {
    try {
      json(res, await organizations.organizationsByTopic(param(req, 'topicRef', '/api/organizations/by-topic/:topicRef')));
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to query organizations by topic', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // GET /api/organizations/by-policy/:policyId  — orgs supporting/opposing a policy (pol-*)
  get('/api/organizations/by-policy/:policyId', async (req, res) => {
    try {
      json(res, await organizations.organizationsByPolicy(param(req, 'policyId', '/api/organizations/by-policy/:policyId')));
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to query organizations by policy', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // GET /api/organizations/:id/edges  — actor-relationship edges incident to an org
  // (allies/competitors/funders derivable client-side by filtering on `type`). 4-segment
  // param-then-literal; registered after the by-* literals so /…/by-*/edges resolves to
  // the by-* handler, before the 3-segment :id below. (t/1530)
  get('/api/organizations/:id/edges', async (req, res) => {
    try {
      json(res, await organizations.organizationEdges(param(req, 'id', '/api/organizations/:id/edges')));
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to query organization edges', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // GET /api/organizations/:id  — single org (registered last; :id must not shadow the by-* literals)
  get('/api/organizations/:id', async (req, res) => {
    try {
      const org = await organizations.getOrganizationById(param(req, 'id', '/api/organizations/:id'));
      if (!org) { error(res, 'Organization not found', 404); return; }
      json(res, org);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to load organization', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });
}
