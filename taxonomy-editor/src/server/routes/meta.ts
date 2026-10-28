// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the meta / liveness / taxonomy-dir
// route run, moved verbatim out of server.ts behind the registration seam. This
// run registers before registerTaxonomyRoutes, so registration order — and the
// routeTable snapshot — is preserved by placing registerMetaRoutes() at its
// former position. /health threads server identity (ctx.serverVersion /
// ctx.serverStartTime, new ctx fields) + live GitHub + flight-recorder state
// through ServerCtx.

import fs from 'fs';
import path from 'path';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { classifyDataUnavailable, type ReadinessState } from './readiness.js';
import { getDataRootReadyState } from './dataRootReadiness.js'; // t/3309: cache-once data-root readiness
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getProjectRoot, getDataRoot, hasApiKey, STORAGE_MODE, isStagingIdentity } from '../config.js';
import { getConfig } from '../runtimeConfig.js';
import * as proxyTiers from '../ai/proxyTiers.js';
import { getEmbeddingsCacheStatus, getEmbeddingsResolution } from '../ai/aiBackends.js';
import * as community from '../community/community.js';
import * as fileIO from '../storage/fileIO.js';
import { log } from '../logger.js';
import { LLMS_TXT } from '../llmsTxt.js';
import { getLastEventLoopSample } from '../eventLoopMonitor.js';
import { findUnreachableAllowlistEntries } from '../identityAllowlistCheck.js';
import { getReadOnlyPrincipalEntries } from '../readOnlyGuard.js';
import { getNodeSourceIndexStatus } from '../storage/nodeSourceIndex.js';

// t/2059: throttle the readiness log to state transitions. ACA probes /healthz
// every few seconds, so logging every not-ready probe would spam the log. Emit
// once when the state flips — error for `failed`, info for `warming` — so the
// server log names the state without drowning it.
let lastReadinessState: ReadinessState['state'] | null = null;

function logReadinessTransition(readiness: ReadinessState, dataRoot: string): void {
  if (readiness.state === lastReadinessState) return;
  lastReadinessState = readiness.state;
  if (readiness.state === 'failed') {
    log.server.error({ dataRoot, reason: readiness.reason }, 'Readiness: data-load failed');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'healthz', level: 'error',
      message: 'Readiness: data-load failed', data: { reason: readiness.reason },
    });
  } else {
    log.server.info({ dataRoot, reason: readiness.reason }, 'Readiness: warming (data load in progress)');
  }
}

// t/3309: /readyz data-root failure signal (cond 4), throttled to the transition INTO failed —
// ACA polls /readyz every few seconds, so a per-probe WARN would spam. The message keeps the
// "Data root validation failed" substring the boot-WARN alert (t/3308) keys on, so the Log_s
// alert fires whether the failure surfaces at boot or here. Reset by the handler when the state
// leaves 'failed' (a flap re-logs). The boot exit(1)/WARN path (server.ts) is unchanged — this is
// the readyz-side signal that carries the migration once exit(1) is removed (step 3).
let lastReadyzDataRootFailed = false;

function logDataRootReadyzFailure(reason: string | undefined): void {
  if (lastReadyzDataRootFailed) return;
  lastReadyzDataRootFailed = true;
  log.server.warn({ reason }, 'Data root validation failed — /readyz not-ready (t/3309)');
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'readyz', level: 'error',
    message: 'Data root validation failed — /readyz not-ready', data: { reason },
  });
}

export function registerMetaRoutes(r: Router, ctx: ServerCtx): void {
  const { get, put } = r;

  get('/third-party-notices', (_req, res) => {
    const noticesPath = path.join(getProjectRoot(), 'taxonomy-editor', 'THIRD-PARTY-NOTICES.txt');
    try {
      const content = fs.readFileSync(noticesPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch {
      /* telemetry — silent by design */
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('License notices file not found. Run npm run licenses to generate.');
    }
  });

  get('/healthz', async (_req, res) => {
    const dataRoot = fileIO.getDataRootPath();
    const dataAvailable = await fileIO.isDataAvailable();
    if (dataAvailable) {
      // Reset the readiness-log throttle so a later re-failure (a flapping
      // replica: failed → healthy → failed) re-logs instead of being swallowed
      // by the sentinel still reading its pre-recovery state (Quality t/2059#5).
      lastReadinessState = null;
      json(res, { status: 'healthy', dataRoot });
      return;
    }
    // Not ready → still 503 (readiness semantics unchanged), but name WHY so a
    // permanent data-load failure is distinguishable from a normal cold-start
    // warm-up, in both the body and the server log (t/2059). `state` is
    // 'warming' | 'failed'; on 'failed', `reason` carries the underlying cause.
    const readiness = classifyDataUnavailable(ctx, process.uptime());
    logReadinessTransition(readiness, dataRoot);
    json(res, { status: 'unhealthy', state: readiness.state, reason: readiness.reason, dataRoot }, 503);
  });

  // t/3112/t/3165: deploy warm-gate + RESOLUTION gate. Constraint #1 (t/3090#11): no traffic
  // to an un-warmed revision. /healthz gates on DATA load only; the embeddings.json cache is
  // pre-warmed fire-and-forget (server.ts). t/3165 hardened this from PRESENCE to RESOLUTION:
  // a cache can be present (nodeCount>0) yet not resolve a keyed lookup at runtime (stale/wrong
  // corpus, empty/corrupt vectors) — the t/3165 class that mere-presence let through the gate.
  // /readyz now returns 200 ONLY when a canary keyed lookup RESOLVES to a real vector via the
  // same nodes[id].vector path the compute path uses. Single shared predicate: the ACA warm-gate
  // AND DevOps2's resolution deploy-gate (t/3091) both poll GET /readyz — status code 503 = block,
  // no auth (PUBLIC_EXACT_PATHS, anon). Distinct from /api/health/embeddings (ONNX model warmup).
  get('/readyz', (_req, res) => {
    // t/3309: data-root validation composes into the readiness gate AHEAD of the embeddings
    // check — a misprovisioned data root means the corpus is absent, so there's nothing for
    // embeddings to resolve against. State is CACHE-ONCE (dataRootReadiness): validated once at
    // startup, read here per probe — no per-probe GitHub Contents call (cond 2). A definitive
    // 'failed' is a hard 503 (not masked as a slow warm-up, cond 3); 'validating' is warming.
    // The 200-ready body is unchanged (data-root 'ready' falls through to the existing embeddings
    // gate), preserving the shared warm-gate body-contract fixture (t/3114).
    // t/3236 (server half tracked t/3340): test-only fault knob — force the DEFINITIVE data-root-FAILED
    // readiness so DevOps can exercise the deploy warm-gate's FIRE arm (503 'failed' → block traffic-
    // shift → fail+rollback) against a REAL staging revision with real data, no 700M throwaway repo.
    // TL cond 1: forces the definitive 'failed' state (NOT 'validating'), so the warm-gate sees a
    // definitive failure. ENABLE-GUARD (TL re-GV, t/3340#4/#5): gated on isStagingIdentity() — ACA
    // auto-injects CONTAINER_APP_NAME=/staging/i (drift-proof; prod's app name CANNOT match) — AND the
    // explicit flag. FAIL-CLOSED: both signals default-absent → inert; prod-excluded by construction
    // (not a fail-open NODE_ENV/branch check). So DevOps arms it with a SINGLE var on NORMAL staging
    // (no NODE_ENV flip → none of the HOST/STORAGE_MODE/ALLOWED_ORIGINS confounds). RUNTIME-scoped to
    // this response only: boot validateDataRoot runs against real data, unaffected — no ENFORCE change.
    // GATE CO-LOCATION (TL t/3340#6): isStagingIdentity()'s own doc says "used only by the state-root
    // isolation guard — never an auth/security decision." This call is a DELIBERATE, TL-approved
    // exception — it's staging-only FEATURE-scoping of a fail-safe test knob (worst case = a self-DoS
    // behind the flag on staging only), NOT an access-control decision. A future isStagingIdentity
    // doc-usage sweep should read this as a justified exception, not drift.
    const forceDataRootFailed = isStagingIdentity() && process.env.READYZ_FORCE_DATA_ROOT_FAILED === '1';
    const dr = forceDataRootFailed
      ? { state: 'failed' as const, reason: 'forced (READYZ_FORCE_DATA_ROOT_FAILED test knob, t/3236)' }
      : getDataRootReadyState();
    if (dr.state === 'failed') {
      logDataRootReadyzFailure(dr.reason); // cond 4: WARN→Log_s once per failure episode
      json(res, { status: 'failed', reason: `data-root-failed: ${dr.reason ?? 'unknown'}` }, 503);
      return;
    }
    // Reset the failure-log throttle so a later re-failure (flap: failed → ready → failed) re-logs.
    lastReadyzDataRootFailed = false;
    if (dr.state === 'validating') {
      json(res, { status: 'warming', reason: 'data-root-validating' }, 503);
      return;
    }
    const { present, nodeCount, resolves, canaryId } = getEmbeddingsResolution();
    if (present && (nodeCount ?? 0) > 0 && resolves) {
      json(res, { status: 'ready', nodeCount, resolves: true });
      return;
    }
    const reason = !present ? 'cache-absent' : !resolves ? 'canary-not-resolving' : 'empty';
    json(res, { status: 'warming', present, nodeCount, resolves: false, reason, canary: canaryId }, 503);
  });

  get('/health', async (_req, res) => {
    // M5: liveness probes (unauthenticated) get a minimal OK. Operational detail
    // (versions, storage internals, GitHub rate limits, paths) only for admins.
    // AI key status is always included so deployment gates can verify readiness.
    const geminiReady = await hasApiKey('gemini');
    const freeKeyPoolSize = proxyTiers.freeTierKeyCount();
    // t/3278 Arm-1: buildSha in the UNAUTH branch — the drift checker (Arm-2) hits /health anonymously
    // to compare the running image's SHA against origin/main HEAD. Public repo → the commit SHA is not
    // secret. `?? null` so a build that didn't bake BUILD_SHA is a visible null (a vacuous compare the
    // checker treats as sha-unavailable), never a crash.
    // t/4239/t/4240: eventLoopLagMs in the same unauth branch — the t/4180 load-test harness polls
    // /health anonymously (same as every VU), so an admin-gated field would be invisible to it.
    // Lead-approved minor info disclosure (current load state, not data, p/648#240).
    // t/4505: a count only (never names/reasons — those stay on /api/admin/health and the boot
    // WARN) so the unauthenticated deploy smoke check can read it with no admin session.
    const identityAllowlistUnreachable = findUnreachableAllowlistEntries(community.getAdminUsers(), getReadOnlyPrincipalEntries()).length;
    // t/4521: public /health gets a bare boolean (never built yet → null, same precedent as
    // t/4505's count-only split) — the full status (indexVersion, summaryReadFailures) stays
    // admin-only below, since those are operational detail, not a liveness signal.
    const nodeSourceIndexStatus = getNodeSourceIndexStatus();
    const nodeSourceIndexComplete = nodeSourceIndexStatus === null ? null : nodeSourceIndexStatus.complete;
    // t/4584 (TL incident, root cause: GitHub App rate-limit exhaustion): the
    // installation's shared rate limit is the signal that would have caught
    // this before it became a user-visible outage — public (not admin-gated,
    // same precedent as eventLoopLagMs/nodeSourceIndexComplete above) so an
    // unauthenticated monitor/alert can watch it without a session. null for
    // backends with no GitHub rate limit (Electron/local filesystem mode).
    const githubBackendForHealth = ctx.getGithubBackend();
    const githubRateLimitRemaining = githubBackendForHealth?.getRateLimitRemaining() ?? null;
    const githubRateLimitResetsAt = githubBackendForHealth?.getRateLimitResetsAt() ?? null;
    // t/4586 AC (flagged missing post-deploy, t/4586#4): same precedent as the rate-limit
    // fields above — a tripped circuit breaker is the other half of "GitHub reachability"
    // an unauthenticated alert should see, null for backends with no circuit (Electron/local).
    const githubCircuitOpen = githubBackendForHealth ? githubBackendForHealth.getCircuitState() === 'open' : null;
    const entityRegistryDegraded = fileIO.getEntityRegistryStatus().degraded;
    const organizationsRegistryDegraded = fileIO.getOrganizationsReadStatus().degraded;
    if (!community.isAdmin()) {
      json(res, {
        status: 'ok', buildSha: process.env.BUILD_SHA ?? null,
        ai: { geminiKeyConfigured: geminiReady, freeTierKeyPoolSize: freeKeyPoolSize },
        eventLoopLagMs: getLastEventLoopSample()?.maxMs ?? null, identityAllowlistUnreachable, nodeSourceIndexComplete,
        githubRateLimitRemaining, githubRateLimitResetsAt, githubCircuitOpen, entityRegistryDegraded, organizationsRegistryDegraded,
      });
      return;
    }
    const base: Record<string, unknown> = {
      status: 'ok',
      version: ctx.serverVersion,
      startedAt: ctx.serverStartTime,
      uptime: Math.round(process.uptime()),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      dataRoot: getDataRoot(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      flightRecorder: {
        eventsTotal: ctx.serverRecorder.buffer.count,
        eventsRetained: ctx.serverRecorder.buffer.retained,
        capacity: ctx.serverRecorder.buffer.capacity,
      },
      storage: {
        mode: STORAGE_MODE,
      },
    };

    base.ai = {
      geminiKeyConfigured: geminiReady,
      freeTierEnabled: freeKeyPoolSize > 0,
      freeTierKeyPoolSize: freeKeyPoolSize,
      freeTierLimits: freeKeyPoolSize > 0 ? { requestsPerMinute: proxyTiers.scaledFreeTierRpm(freeKeyPoolSize), tokensPerDay: getConfig().tiers.free.tokensPerDay } : null,
    };

    // t/3086: embeddings cache probe result — surfaces t/3085 condition in /health without FR access.
    const embeddingsStatus = getEmbeddingsCacheStatus();
    base.embeddings = { cachePresent: embeddingsStatus.present, nodeCount: embeddingsStatus.nodeCount };

    // t/4521: full status admin-only (summaryReadFailures is operator diagnostic detail);
    // public /health above only got the boolean. null (never built) passes through as-is.
    base.nodeSourceIndex = nodeSourceIndexStatus;

    // t/4584: full reason admin-only, same split as nodeSourceIndex above —
    // public /health only got the booleans.
    base.entityRegistry = fileIO.getEntityRegistryStatus();
    base.organizationsRegistry = fileIO.getOrganizationsReadStatus();

    const githubBackend = githubBackendForHealth;
    if (githubBackend) {
      (base.storage as Record<string, unknown>).mainSha = githubBackend.getMainSha();
      (base.storage as Record<string, unknown>).cacheFileCount = githubBackend.getCachedFileCount();
      (base.storage as Record<string, unknown>).cacheGeneration = githubBackend.getCacheGeneration();
      (base.storage as Record<string, unknown>).fallbackActive = githubBackend.getCircuitState() === 'open';
      (base.storage as Record<string, unknown>).overlay = githubBackend.getOverlayStats(); // t/727 memory monitoring

      base.github = {
        rateLimit: {
          remaining: githubBackend.getRateLimitRemaining(),
          resetsAt: githubBackend.getRateLimitResetsAt(),
        },
        cacheHitRate: githubBackend.getCacheHitRate(),
        circuitState: githubBackend.getCircuitState(),
        coherencyViolations: githubBackend.getCoherencyViolations(),
        activeBranches: githubBackend.getActiveBranchCount(),
        lastPollAgeS: githubBackend.getLastPollAge(),
      };
    }

    json(res, base);
  });

  // t/1143: llms.txt convention (https://llmstxt.org) — a public, static markdown
  // file so IDE agents / AI tools get structured context about the app instead of
  // parsing raw SPA HTML. Static + cacheable.
  get('/llms.txt', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(LLMS_TXT);
  });

  get('/api/taxonomy-dirs', async (_req, res) => {
    json(res, await fileIO.getTaxonomyDirs());
  });

  get('/api/taxonomy-dir/active', (_req, res) => {
    json(res, fileIO.getActiveTaxonomyDirName());
  });

  put('/api/taxonomy-dir/active', (_req, res, body) => {
    const { dirName } = body as { dirName: string };
    const previous = fileIO.getActiveTaxonomyDirName();
    try {
      fileIO.setActiveTaxonomyDir(dirName);
      log.api.info({ component: 'taxonomy-dir', previous, active: dirName }, 'Active taxonomy directory changed');
      getGlobalRecorder()?.record({
        type: 'lifecycle', component: 'taxonomy-dir', level: 'info',
        message: 'Active taxonomy directory changed',
        data: { previous, active: dirName },
      });
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'taxonomy-dir', level: 'error',
        message: 'Failed to switch active taxonomy directory',
        data: { previous, requested: dirName },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });
}
