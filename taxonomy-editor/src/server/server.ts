// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Azure Application Insights — re-add @azure/monitor-opentelemetry when
// upstream OpenTelemetry vulnerabilities are patched (see p/2#12).

/**
 * Web server for the Taxonomy Editor.
 * Serves the React SPA and provides REST + WebSocket APIs that mirror
 * the Electron IPC bridge (window.electronAPI).
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execFile, ChildProcess } from 'child_process';
import { getGlobalRecorder, setGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { warmup as warmupEmbeddings } from '../../../lib/embeddings/onnxEmbedding.js';
import { prewarmEmbeddingsCache, getEmbeddingsCacheStatus } from './ai/aiBackends.js';
import { startEventLoopMonitor } from './eventLoopMonitor.js';
import { startEmbedQueueDepthMonitor } from './embedQueueDepthMonitor.js';
import { startGroundingSweep } from './groundingSweepScheduler.js';
import { enforceReadOnlyGuard } from './readOnlyGuard.js';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { WebSocketServer, WebSocket } from 'ws';
import {
  PORT, getDataRoot, getStateRoot, assertStateRootIsolation, getApiKey, hasApiKey, storeApiKey, deleteApiKey, deleteAllApiKeys, rotateApiKeyMaterial,
  getStoredApiKeys, addApiKey, removeApiKey, resolveDataPath,
  getPaidGeminiFallbackKey, setPaidGeminiFallbackKey, deletePaidGeminiFallbackKey,
  BROKER_SCRIPT, SCRIPTS_DIR, getProjectRoot, type AIBackend,
  STORAGE_MODE, CACHE_DIR, isEmbeddingWorkerOffloadEnabled, getEmbeddingWorkerPoolSize, getMaxReplicas,
} from './config.js';
import { effectivePerReplicaRpm } from './ai/rpmLimiter.js';
import { configureEmbeddingWorkerPool } from '../../../lib/embeddings/offThreadEmbedding.js';
import { GitHubAPIBackend } from './storage/githubAPIBackend.js';
import { SessionBranchManager } from './storage/sessionBranchManager.js';
import { flushOverlaysWithDeadline, FORCE_EXIT_TIMEOUT_MS } from './shutdownOverlayFlush.js';
import { logRequestMetrics, REQUEST_METRICS_LOG_DELAY_MS } from './requestMetricsLog.js';
import { runWithUser, getCurrentUserId, getSessionBranchName, setSessionBranchName, deriveStorageUserId, type UserContext } from './security/userContext.js';
import { isAuthDisabledAllowed, isPathWithinDir, isTerminalAccessAllowed, isAnonAllowedRoute, invalidRouteParam, missingApiKeyError, resolveTestPersonaOverride } from './security/accessControl.js';
import { sanitizeUserText } from './security/contentSanitizer.js';
import { isFreeTierAiPath } from './anonAiRoutes.js';
import { getRollbackStatus } from './rollbackStatus.js';
import { getErrorSummaryCached, type ErrorEntry } from './errorAggregation.js';
import { isCaseStatus } from './support/types.js';
import * as organizations from './organizations.js';
import { isPov } from './organizations.js';
import { json, error, param, query, getClientIp, createRouter, withEndpointTimeout, normalizedRequestPath, type Handler } from './httpKit.js';
import { computeIsPublicPath } from './publicPaths.js';
import { resolveAllowedOrigins, corsOriginFor, resolveBindHost, isNonLoopbackDevBind, enforceCrossOriginMutationGuard, isWebSocketOriginAllowed } from './networkSecurity.js';
import { parseCookies } from './httpCookies.js';
import { registerAllRoutes } from './routes/all.js';
import { invalidateConflictsCache, warmConflictsCache } from './routes/conflicts.js';
import { anonSessionCookiesWithCreated } from './routes/session.js';
import { setDataRootReady, setDataRootFailed } from './routes/dataRootReadiness.js'; // t/3309: data-root → /readyz readiness cache
import { buildLoginPage, FORBIDDEN_PAGE, SW_HEAL_SCRIPT_CSP_HASH, loginPageHeaders } from './loginPage.js';
import type { ServerCtx } from './routes/context.js';
import { listFlags, setFlag, deleteFlag, type FlagDef } from './featureFlags.js';
import { drainServerLogLines } from './serverLogBuffer.js';
import { initAnonymousSessionStore } from './storage/anonymousSessionStore.js';
import { checkProviderBinding } from './ai/providerBinding.js';
import * as community from './community/community.js';
import * as fileIO from './storage/fileIO.js';
import { FEEDBACK_CATEGORIES, isFeedbackCategory, paginateFeedback } from './storage/feedbackStore.js';
import { stampNodeAuthorship, diffNodes, changedFields } from './storage/editMeta.js';
import { computeNodeConflicts, type TaxNode, type NodeConflict } from './community/nodeConflicts.js';
import { getConfig, getConfigState, writeConfig, forceReload as reloadRuntimeConfig, diffFromDefaults } from './runtimeConfig.js';
import { setRuntimeCredentials, clearRuntimeCredentials, getCredentials } from './security/githubAppAuth.js';
import * as proxyTiers from './ai/proxyTiers.js';
import * as rateLimiter from './security/rateLimiter.js';
import * as analytics from './community/analytics.js';
import { FlightRecorder } from '../../../lib/flight-recorder/flightRecorder.js';
import { INQUIRY_BOOT_ID } from './inquiryJobs.js';
import { log, runWithRequestContext, generateRequestId, getRequestId, getRequestContext } from './logger.js';
import {
  registerReviewHandler,
  getReviewQueue,
  getReviewStats,
  getReviewDetail,
  executeReviewAction,
} from './community/admin/reviewRegistry.js';
import type { ReviewAction } from './community/admin/types.js';
import { calibrationReviewHandler } from './community/admin/calibrationHandler.js';
import { communityReviewHandler } from './community/admin/communityReviewHandler.js';
import { serveStatic } from './staticServe.js';

// Register review domain handlers at startup so the unified admin endpoints
// (queue/stats/action/detail) can delegate to them (t/646, t/647, t/650).
registerReviewHandler(calibrationReviewHandler);
registerReviewHandler(communityReviewHandler);

// ── Server-side flight recorder ──
const serverRecorder = new FlightRecorder({ capacity: 2000, dumpOnError: false });
// t/803: stamp the per-request correlation id (from the logger ALS) onto every
// flight-recorder event recorded during request handling, so server events
// correlate to the originating HTTP request. An explicit request_id passed to
// record() still wins; outside a request the field is omitted.
const _baseServerRecord = serverRecorder.record.bind(serverRecorder);
// t/3067: stamp _sessionBranch on every event so session-scoped dump filtering
// can isolate this user's events from the global ring buffer at write time.
// Object.assign avoids the object-literal excess-property check (RecordInput
// doesn't declare _sessionBranch; Shared Lib owns that type).
serverRecorder.record = (input) => _baseServerRecord(
  Object.assign({}, input, { request_id: getRequestId(), _sessionBranch: getSessionBranchName() ?? null }),
);
serverRecorder.intern('component', 'server');
serverRecorder.intern('component', 'git');
serverRecorder.intern('component', 'data-pull');
serverRecorder.intern('component', 'copy-status');
serverRecorder.intern('component', 'auth');
serverRecorder.intern('component', 'github-api');
serverRecorder.intern('component', 'cache');
serverRecorder.intern('component', 'session');
serverRecorder.intern('component', 'storage');

/* eslint-disable @typescript-eslint/no-use-before-define -- callback runs after module init; SERVER_VERSION, SERVER_START_TIME, githubBackend all safe at call-time */
serverRecorder.setContextProvider(() => {
  const ctx: Record<string, unknown> = {
    server: {
      version: SERVER_VERSION,
      started_at: SERVER_START_TIME,
      uptime_s: Math.round(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1048576),
      heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1048576),
    },
    data: {
      data_root: getDataRoot(),
    },
    environment: {
      deploy_tag: process.env.DEPLOY_TAG ?? null,
      auth_disabled: process.env.AUTH_DISABLED ?? null,
      storage_mode: STORAGE_MODE,
    },
    azure: {
      replica_name: process.env.CONTAINER_APP_REPLICA_NAME ?? null,
      container_start_time: process.env.WEBSITES_CONTAINER_START_TIME ?? null,
      dns_suffix: process.env.CONTAINER_APP_ENV_DNS_SUFFIX ?? null,
      revision: process.env.CONTAINER_APP_REVISION ?? null,
    },
  };

  // Add GitHub API state when in API mode (githubBackend populated after startup)
  if (githubBackend) {
    ctx.storage = {
      mode: STORAGE_MODE,
      cache_generation: githubBackend.getCacheGeneration(),
      cache_file_count: githubBackend.getCachedFileCount(),
      cache_hit_rate: githubBackend.getCacheHitRate(),
      main_sha: githubBackend.getMainSha(),
      last_poll_age_s: githubBackend.getLastPollAge(),
    };
    ctx.github = {
      rate_limit_remaining: githubBackend.getRateLimitRemaining(),
      rate_limit_resets_at: githubBackend.getRateLimitResetsAt(),
      circuit_state: githubBackend.getCircuitState(),
      active_branches: githubBackend.getActiveBranchCount(),
    };
  }

  return ctx;
});
/* eslint-enable @typescript-eslint/no-use-before-define */

setGlobalRecorder(serverRecorder);
// The flight-recorder named-pipe listener is Windows-only desktop/dev IPC — its
// path (\\.\pipe\…) is invalid on Linux, where it emits a noisy EACCES and is
// useless to the headless server (which exposes flight-recorder dumps over HTTP).
// Only start it on Windows, and never let a failure abort server startup. (t/722)
if (process.platform === 'win32') {
  try {
    serverRecorder.startPipeListener(process.pid);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'server',
      level: 'warn',
      message: 'Flight-recorder pipe listener failed to start (non-fatal)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

export { serverRecorder };

// t/3724: one boot event between the last good poll and a first 404 is enough to distinguish
// a routine process restart from a crash from a scale-to-zero cycle — the discriminating signal
// the incident that filed this ticket couldn't get from the inquiry events alone. boot_id is
// shared with inquiryJobs.ts's INQUIRY_BOOT_ID by design (see that file's t/3724 coordination note).
getGlobalRecorder()?.record({
  type: 'server.started', component: 'server', level: 'info',
  message: 'Server process started',
  data: {
    pid: process.pid,
    boot_id: INQUIRY_BOOT_ID,
    build_date: process.env.BUILD_DATE ?? null,
    build_commit: process.env.BUILD_COMMIT ?? null,
    node_version: process.version,
  },
});

// Merge the bounded server-log buffer into a server dump's ndjson as `log.line`
// entries, so a dump is self-contained for offline triage without a Log
// Analytics query (operator request). Log lines are already pino-redacted and
// re-scrubbed in serverLogBuffer; they live in their own capped buffer so they
// never evict curated flight-recorder events.
function appendServerLogs(ndjson: string): string {
  const logs = drainServerLogLines();
  if (logs.length === 0) return ndjson;
  const tail = logs.map(l => JSON.stringify({ type: 'log.line', component: 'server-log', ...l })).join('\n');
  return (ndjson.endsWith('\n') ? ndjson : ndjson + '\n') + tail + '\n';
}

// L1 (t/720): AUTH_DISABLED makes every request an anonymous user with full
// access — fine for local/dev single-operator use, catastrophic in production.
// Hard-block it under NODE_ENV=production (force auth back on) and warn loudly
// whenever it is set so a misconfigured deploy can't silently run wide open.
if (process.env.AUTH_DISABLED === '1') {
  if (!isAuthDisabledAllowed()) {
    delete process.env.AUTH_DISABLED;
    serverRecorder.record({
      type: 'system.error', component: 'server', level: 'error',
      message: 'AUTH_DISABLED=1 is not permitted when NODE_ENV=production — ignoring it and enforcing authentication.',
    });
    log.security.error('AUTH_DISABLED=1 ignored in production; authentication is enforced. Remove AUTH_DISABLED or unset NODE_ENV=production.');
  } else {
    log.security.warn('AUTH_DISABLED=1 — authentication is bypassed (all requests anonymous with full access). Never use this in production.');
  }
}

// ── Storage backend selection ──

let githubBackend: GitHubAPIBackend | null = null;
let sessionManager: SessionBranchManager | null = null;

if (STORAGE_MODE === 'github-api') {
  githubBackend = new GitHubAPIBackend({
    cacheDir: CACHE_DIR,
    recorder: serverRecorder,
  });
  sessionManager = new SessionBranchManager(githubBackend, serverRecorder);
  fileIO.setBackend(githubBackend);
  serverRecorder.record({
    type: 'storage.mode', component: 'storage', level: 'info',
    message: `Storage mode: github-api (cache: ${CACHE_DIR})`,
    data: { mode: 'github-api', cacheDir: CACHE_DIR },
  });

  // User content (chats, debates, community) lives in Azure Blob Storage.
  // Taxonomy/conflicts/calibration stay on the GitHub backend.
  const blobAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (blobAccountUrl) {
    const { AzureBlobBackend } = await import('./storage/azureBlobBackend.js');
    fileIO.setUserContentBackend(new AzureBlobBackend({
      accountUrl: blobAccountUrl,
      userContentContainer: process.env.AZURE_USER_CONTENT_CONTAINER || 'user-content',
      communityContainer: process.env.AZURE_COMMUNITY_CONTAINER || 'community',
    }));
    const briefExportsContainer = process.env.AZURE_BRIEF_EXPORTS_CONTAINER || 'brief-exports';
    fileIO.setBriefExportBackend(new AzureBlobBackend({
      accountUrl: blobAccountUrl,
      userContentContainer: briefExportsContainer,
      communityContainer: briefExportsContainer,
    }));
    serverRecorder.record({
      type: 'storage.mode', component: 'storage', level: 'info',
      message: 'User content storage: azure-blob',
      data: { accountUrl: blobAccountUrl },
    });
  } else {
    log.storage.warn('AZURE_STORAGE_ACCOUNT_URL is unset — Blob backend not initialized; user content will fall back to the primary GitHub backend.');
    serverRecorder.record({
      type: 'storage.mode', component: 'storage', level: 'warn',
      message: 'User content storage: github-api fallback (Azure Blob not configured)',
    });
  }
} else {
  // FilesystemBackend is the default in fileIO.ts — no action needed
  serverRecorder.record({
    type: 'storage.mode', component: 'storage', level: 'info',
    message: `Storage mode: filesystem (data root: ${getDataRoot()})`,
    data: { mode: 'filesystem', dataRoot: getDataRoot() },
  });
}

log.storage.info({ mode: STORAGE_MODE }, 'Storage mode selected');

/**
 * Ensure a session branch exists before any write operation.
 * In API mode, writes cannot target main directly (branch protection).
 * This lazily creates `api-session/{userId}` from main HEAD on first edit
 * and updates the ALS context so GitHubAPIBackend.getEffectiveRef() sees the branch.
 */
async function ensureSessionBranch(): Promise<void> {
  if (!githubBackend || !sessionManager) return; // filesystem mode — no-op
  const userId = getCurrentUserId();
  const branchName = await sessionManager.ensureBranch(userId);
  setSessionBranchName(branchName);
}

// ── Express-like micro-router (zero dependencies) ──

// Handler type + the json/error/param/query helpers live in ./httpKit.ts (t/1295)
// so extracted route clusters (routes/*.ts) share the same contract.
const routes: { method: string; path: string; handler: Handler }[] = [];

function get(p: string, h: Handler) { routes.push({ method: 'GET', path: p, handler: h }); }
function post(p: string, h: Handler) { routes.push({ method: 'POST', path: p, handler: h }); }
function put(p: string, h: Handler) { routes.push({ method: 'PUT', path: p, handler: h }); }
function patch(p: string, h: Handler) { routes.push({ method: 'PATCH', path: p, handler: h }); }
function del(p: string, h: Handler) { routes.push({ method: 'DELETE', path: p, handler: h }); }

// t/1295: registrar + read-mostly context for extracted route clusters
// (routes/*.ts). getGithubBackend is a live getter (not a snapshot) so clusters
// registered at module-load don't capture a stale null before async init assigns it.
const router = createRouter(routes);

// Server identity — resolved once at startup. Threaded to routes/meta.ts (/health)
// via ServerCtx; also used by the startup log + flight-recorder context provider.
const SERVER_VERSION = (() => {
  const candidates = [
    path.resolve(__dirname, '../package.json'),
    path.resolve(__dirname, '../../package.json'),
    '/app/package.json',
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (pkg.version) return pkg.version as string;
    } catch { /* telemetry — silent by design;  try next */ }
  }
  return '0.0.0';
})();

const SERVER_START_TIME = new Date().toISOString();

const serverCtx: ServerCtx = {
  getGithubBackend: () => githubBackend,
  getSessionManager: () => sessionManager,
  broadcastTaxonomyUpdate,
  serverRecorder,
  ensureSessionBranch,
  appendServerLogs,
  invalidateConflictsCache,
  serverVersion: SERVER_VERSION,
  serverStartTime: SERVER_START_TIME,
  broadcastEvent,
  emitToUser,
};

// Client IP for rate limiting (M7): the rightmost X-Forwarded-For entry when the
// peer is our proxy, else the socket address (t/4410). Lives in httpKit.ts (t/1347).

// ── Route registration (t/2749: consolidated into routes/registerAll.ts) ──
// Order is preserved verbatim — see registerAll.ts for the per-cluster comments.
registerAllRoutes(router, serverCtx);

// ── Static file serving ──

const STATIC_DIR = path.resolve(__dirname, '../renderer');

// ── Request router ──

function matchRoute(method: string, pathname: string): { handler: Handler; routePath: string } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const routeParts = route.path.split('/');
    const urlParts = pathname.split('/');
    if (routeParts.length !== urlParts.length) continue;
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) continue;
      if (routeParts[i] !== urlParts[i]) { match = false; break; }
    }
    if (match) return { handler: route.handler, routePath: route.path };
  }
  return null;
}

type RawBodyReq = http.IncomingMessage & { __rawBody?: string; __rawBodyBuffer?: Buffer };

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB — debate sessions can reach 10+ MB at 14 rounds

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    // L10: cap request/upload body size, surfaced as HTTP 413 (covers
    // /api/upload-document and every other POST/PUT, which all read via readBody).
    if (totalBytes > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk as Buffer);
  }
  const rawBuffer = Buffer.concat(chunks);
  const raw = rawBuffer.toString('utf-8');
  // Stash raw bytes so HMAC-verified endpoints (webhook) can recompute the
  // signature. Parse-then-stringify would change whitespace and break it.
  (req as RawBodyReq).__rawBody = raw;
  // Binary-safe buffer for handlers that need unmodified bytes (e.g. template upload).
  (req as RawBodyReq).__rawBodyBuffer = rawBuffer;
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (err) {
    // Non-JSON bodies (raw text uploads) legitimately land here, so warn-only —
    // but record so malformed-JSON API calls aren't invisible.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'http-body', level: 'warn',
      message: 'Request body is not valid JSON — passing raw string through',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return raw;
  }
}

// ── HTTP server ──

// t/2532 (M12): CORS/WS allowlist is ALWAYS a concrete array — dev defaults to the
// Vite origins (never `*`), prod uses ALLOWED_ORIGINS ([] + warn if unset).
const ALLOWED_ORIGINS = resolveAllowedOrigins(process.env);
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS) {
  log.security.warn('ALLOWED_ORIGINS not set in production — CORS will reject cross-origin requests');
}

function getCorsOrigin(req: http.IncomingMessage): string {
  return corsOriginFor((req.headers.origin || '') as string, ALLOWED_ORIGINS);
}

// parseCookies now lives in ./httpCookies.ts (t/2019) — shared with loginPage.ts and
// prototype-pollution-safe.

// ── Auth: file-based user allowlist ──
// Reads authorized-users.json from the data volume (or repo root as fallback).
// Azure Easy Auth sets X-MS-CLIENT-PRINCIPAL-NAME and X-MS-CLIENT-PRINCIPAL-IDP
// after successful login. We match against emails, GitHub username, or display name.

interface AuthorizedUser {
  name: string;
  emails?: string[];
  github?: string;
}

interface AuthorizedUsersFile {
  users: AuthorizedUser[];
}

function loadAuthorizedUsers(): AuthorizedUsersFile | null {
  // Only load from the data volume — auth is opt-in per deployment.
  // Drop authorized-users.json into /data/ (Azure Files) to enable the gate.
  const candidates = [
    path.join(getDataRoot(), 'authorized-users.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        // eslint-disable-next-line local/no-raw-data-root-read -- auth allowlist is mount-sourced (/data volume) with an existsSync fallback loop BY DESIGN; routing through readDataFile would flip the trust source from the mount to the data-repo-via-API (auth surface — t/3093#3, ServerAPI route-b)
        const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as AuthorizedUsersFile;
        log.auth.info({ count: data.users.length, path: p }, 'Loaded authorized users');
        return data;
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.auth.error({ path: p, err }, 'Failed to parse authorized users file');
    }
  }
  return null; // No file found = no restriction
}

let authorizedUsersCache: AuthorizedUsersFile | null | undefined;
let authorizedUsersCacheTime = 0;
const AUTH_CACHE_TTL = 30_000; // Re-read file every 30s

function getAuthorizedUsers(): AuthorizedUsersFile | null {
  const now = Date.now();
  if (authorizedUsersCache === undefined || now - authorizedUsersCacheTime > AUTH_CACHE_TTL) {
    authorizedUsersCache = loadAuthorizedUsers();
    authorizedUsersCacheTime = now;
  }
  return authorizedUsersCache;
}

function isUserAuthorized(principalName: string, idp: string): boolean {
  const auth = getAuthorizedUsers();
  if (!auth) return true; // No file = allow all

  // Opt-in: accept any signed-in user, bypass the allowlist. Sign-in is still
  // required because getAuthorizedUsers() returns non-null, so the gate at the
  // top of the request handler still redirects unauthenticated requests.
  if (process.env.AUTH_ALLOW_ALL_SIGNED_IN === '1') return true;

  const name = principalName.toLowerCase();
  for (const user of auth.users) {
    // Match GitHub username
    if (idp === 'github' && user.github && user.github.toLowerCase() === name) return true;
    // Match email (Google, Microsoft, or any provider)
    if (user.emails?.some(e => e.toLowerCase() === name)) return true;
    // Match display name as last resort
    if (user.name.toLowerCase() === name) return true;
  }
  return false;
}

// ── Anonymous route guard ──
// When AUTH_OPTIONAL is enabled, anonymous users get read-only, non-AI access.
// Auth-gate 403 rejection reason codes, surfaced in the response and the flight
// recorder so a 403 can be triaged without reading the auth code (t/763).
type AuthDenyReason = 'anon_route_blocked' | 'no_auth_header' | 'user_not_in_allowlist' | 'no_session';

function recordAuthDenied(reason: AuthDenyReason, method: string, urlPath: string): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'auth',
    level: 'warn',
    message: `Auth gate 403 (${reason}): ${method} ${urlPath}`,
  });
}

// S9: Only trust Easy Auth headers when running on Azure with auth enabled.
// Without this gate, clients can spoof X-MS-CLIENT-PRINCIPAL-NAME if the
// container is exposed directly (not behind Azure's front-end proxy).
const AZURE_AUTH_ENABLED = process.env.WEBSITE_AUTH_ENABLED === 'True'
  || process.env.WEBSITE_AUTH_ENABLED === 'true';

const server = http.createServer((req, res) => { void handleRequest(req, res); });
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Correlation ID: use incoming header or generate a new one
  const requestId = (req.headers['x-request-id'] as string) || generateRequestId();
  res.setHeader('X-Request-Id', requestId);

  const requestStart = Date.now();
  const urlPath = req.url?.split('?')[0] || '';

  return runWithRequestContext(
    { requestId, method: req.method, path: urlPath },
    () => handleRequestInner(req, res, requestId, requestStart),
  );
}

async function handleRequestInner(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  requestStart: number,
) {
  logRequestCompletionOnFinish(req, res, requestId, requestStart);
  applyResponseSecurityHeaders(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const identity = resolvePrincipalIdentity(req, res);
  if (!identity) return;
  const { principalName, idp } = identity;

  // Auth gate — only enforced when authorized-users.json exists
  // t/2019 (js/user-controlled-bypass): derive the gate path from the SAME normalized
  // pathname the router matches on (normalizedRequestPath) — not raw
  // req.url.split('?') — so an encoded-traversal path can't read as a public prefix
  // here (e.g. /api/public/%2e%2e/admin) while resolving elsewhere at the router.
  const urlPath = normalizedRequestPath(req);
  // ACCEPTED RISK — CodeQL js/user-controlled-bypass on the urlPath-guarded auth
  // branches below AND on the top-level gate `if (!isPublicPath && !authDisabled)`
  // (alerts #4068/#5345/#4847/#4851/#5483, dismissed won't-fix; t/2019,
  // t/2001#5, TL-approved p/87#164/#168/#172): path-based auth inherently branches on a
  // user-controlled request path, so the query fires by design and cannot be removed
  // without removing path-based auth. The exploitable parser-differential IS closed —
  // this gate and the router both decide on ONE canonical normalized path
  // (normalizedRequestPath), and the allowlist (computeIsPublicPath) evaluated on that
  // normalized path is the control. See t/2019#5/#10 for the full rationale.
  // /api/models is public: lets the pre-auth renderer populate the model
  // catalog from ai-models.json. Contains no secrets — just labels + ids.
  // /api/sync/webhook/github is public: GitHub POSTs unauthenticated; the
  // handler does its own HMAC verification against GITHUB_WEBHOOK_SECRET.
  // t/1910: the auth-exempt allowlist (15 exact + 7 prefix terms) moved verbatim to
  // publicPaths.ts so it's testable in isolation; the exact-vs-prefix match-kind split
  // is load-bearing and Server-Auth-reviewed (p/135#8) — do not add paths here.
  const isPublicPath = computeIsPublicPath(urlPath);
  // t/2532 (M12): drive-by defense — reject cross-origin mutating requests before auth (same-origin/no-Origin/public paths pass; networkSecurity.ts).
  if (enforceCrossOriginMutationGuard(req, res, isPublicPath, ALLOWED_ORIGINS)) return;
  // AUTH_DISABLED='1' (default) = anonymous access, no login page.
  // AUTH_OPTIONAL='1' = show login page with anonymous option; sign-in
  //   unlocks platform-tier keys, anonymous users get lower limits + BYOK.
  // Neither = required auth (must sign in + be in authorized-users.json).
  const authDisabled = process.env.AUTH_DISABLED === '1';
  const authOptional = process.env.AUTH_OPTIONAL === '1';

  if (handleAnonAuthEndpoints(req, res, urlPath, authOptional)) return;

  clearAnonCookiesOnSignin(req, res, principalName);

  const authGateCtx: AuthGateCtx = { urlPath, isPublicPath, authDisabled, authOptional, principalName, idp };
  if (enforceAuthGate(req, res, authGateCtx)) return;
  if (enforceAnonRouteGuard(req, res, authGateCtx)) return;

  // Run the remainder of request handling inside a user context so that
  // getCurrentUserId() inside getApiKey()/storeApiKey() sees the caller.
  // Unauthenticated paths (local dev, kill-switch, public endpoints) fall
  // back to '_local' — which keyStore ignores in local-file mode.
  const userCtx = await resolveRequestUserContext(req, res, principalName, idp);
  if (!userCtx) return;
  await runWithUser(userCtx, async () => {

    // t/2019: same canonical parse as the auth gate above (normalizedRequestPath) —
    // gate and router decide on the identical normalized path by construction, not two
    // parses that happen to agree. Named reqPath to not shadow the gate's urlPath.
    const reqPath = normalizedRequestPath(req);
    const route = matchRoute(req.method!, reqPath);

    if (enforceWriteRateLimit(req, res, route, reqPath)) return;
    if (enforceReadOnlyGuard(req, res, !!route, reqPath, principalName, idp)) return;

    if (route) {
      await dispatchMatchedRoute(req, res, route, reqPath);
      return;
    }

    // Static file serving (SPA) — t/3084: HEAD must also hit serveStatic, not the catch-all 404
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, STATIC_DIR)) return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });
}

// Request-pipeline helpers (t/1910: handleRequestInner complexity decomposition).
// Each block below was MOVED VERBATIM out of handleRequestInner — same order, same
// early-returns, same match-kinds. Helpers that can end the response return `true`
// (caller must `return`); `false` means "fall through". Server-Auth reviewed the
// auth-gate extraction (p/135#8-9): exact `===` matches stay exact, `.startsWith`
// prefixes stay prefixes — never promote one to the other.

/** Request-completion logging: registers the res.on('finish') handler (t/1022 anomaly warn). */
function logRequestCompletionOnFinish(req: http.IncomingMessage, res: http.ServerResponse, requestId: string, requestStart: number): void {
  // Log request completion when response finishes
  res.on('finish', () => {
    const duration = Date.now() - requestStart;
    const urlPath = req.url?.split('?')[0] || '';
    // Skip noisy static asset and health check logging
    const isQuiet = urlPath.startsWith('/assets/') || urlPath === '/health' || urlPath === '/healthz';
    if (!isQuiet) {
      log.server.info({
        requestId,
        method: req.method,
        path: urlPath,
        status: res.statusCode,
        duration_ms: duration,
      }, 'Request completed');
      // t/1022: a 404 on /api/*/assets/*.js means index.html was served for an API
      // path (service-worker navigateFallback or SPA catch-all) — this should never
      // happen under normal operation, so surface it as a warning instead of burying
      // it as a routine info-level 404.
      if (res.statusCode === 404 && /^\/api\/.*\/assets\//.test(urlPath)) {
        log.server.warn({
          requestId,
          path: urlPath,
        }, 'Anomalous 404: SPA index.html likely served for an API path (service-worker interception or SPA fallback misconfiguration)');
      }
      serverRecorder.record({
        type: 'lifecycle',
        component: serverRecorder.intern('component', 'server') as string | number,
        level: duration > 5000 ? 'warn' : 'info',
        message: `${req.method} ${urlPath} ${res.statusCode} ${duration}ms`,
        duration_ms: duration,
        data: { method: req.method, path: urlPath, status: res.statusCode, requestId },
      });
    }
  });
}

/** S10/L8/L9/L11: security + CORS headers applied to every response. */
function applyResponseSecurityHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  // S10: Security headers on all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // L8: deny powerful features the app never uses.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production' || process.env.ALLOWED_ORIGINS) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // L9: style-src keeps 'unsafe-inline' — accepted risk. React applies inline
    // style attributes (style={{…}}) which CSP blocks without it; removing it
    // breaks the UI. script-src has NO unsafe-inline, so the XSS surface is small.
    // t/856: scope WebSocket origins instead of a bare `wss:` (which allowed any
    // host). Same-origin ws/wss is covered by 'self'; additionally allow each
    // configured ALLOWED_ORIGINS host over wss.
    const wssOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
      .map(o => o.replace(/^https?:/i, 'wss:'));
    const connectSrc = ["connect-src 'self'", ...wssOrigins].join(' ');
    // script-src adds the sha256 of the login page's static SW-heal script (t/1128)
    // so it runs without re-opening 'unsafe-inline'. The hash is derived from the
    // script constant, so it stays in sync automatically.
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' ${SW_HEAL_SCRIPT_CSP_HASH}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ${connectSrc}; font-src 'self'; worker-src 'self'`);
  }

  // CORS headers — locked to ALLOWED_ORIGINS in production, permissive in dev.
  // (L11: X-Admin-Key dropped — the static admin-key auth path was removed;
  //  admin access is OAuth + ADMIN_USERS only, so there's no key to brute-force.)
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  // t/1132: let the renderer read the token-budget milestone headers cross-origin
  // (same-origin reads them anyway; this covers proxied/cross-origin topologies).
  res.setHeader('Access-Control-Expose-Headers', 'X-Token-Budget-Warning, X-Token-Budget-Resets');
  if (ALLOWED_ORIGINS) res.setHeader('Vary', 'Origin');
}

/** Resolve the caller principal from Easy Auth headers + dev/staging X-Test-Persona
 *  override (t/1125). Returns null when it already sent a 401 — the caller must return. */
function resolvePrincipalIdentity(req: http.IncomingMessage, res: http.ServerResponse): { principalName: string; idp: string } | null {
  // S9: Only read Easy Auth headers when Azure auth is confirmed via env var.
  let principalName = AZURE_AUTH_ENABLED
    ? (req.headers['x-ms-client-principal-name'] as string) || ''
    : '';
  let idp = AZURE_AUTH_ENABLED
    ? (req.headers['x-ms-client-principal-idp'] as string) || ''
    : '';

  // t/1125: dev/staging-only X-Test-Persona override (production-inert — requires
  // ENABLE_TEST_PERSONA_HEADER=1 + a matching X-Test-Persona-Secret). Lets the
  // persona regression matrix exercise authenticated/admin rows from the CLI.
  const personaOverride = resolveTestPersonaOverride(req.headers, community.getAdminUsers());
  if (personaOverride && 'error' in personaOverride) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'X-Auth-Reason': personaOverride.error });
    res.end(JSON.stringify({ error: 'Invalid test persona', reason: personaOverride.error }));
    return null;
  }
  if (personaOverride) {
    principalName = personaOverride.principalName;
    idp = personaOverride.idp;
    log.server.info(
      { persona: personaOverride.persona, principalName: principalName || null, idp: idp || null },
      'Test-persona override applied (dev/staging Easy Auth short-circuit)',
    );
  }
  return { principalName, idp };
}

/** The two anonymous-session establishment endpoints (t/1483). Returns true when handled
 *  (cookies set + responded). Must run before the auth gate — the caller has no session yet. */
function handleAnonAuthEndpoints(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, authOptional: boolean): boolean {
  // /.auth/anonymous — sets a session cookie and redirects to the app (browser
  // link on the login page). POST /api/auth/anonymous below is the JSON sibling.
  if (urlPath === '/.auth/anonymous' && authOptional) {
    res.writeHead(302, {
      'Location': '/',
      'Set-Cookie': anonSessionCookiesWithCreated(req), // t/2464 (id) + t/2493 (created marker on fresh mint)
    });
    res.end();
    return true;
  }

  // POST /api/auth/anonymous — JSON sibling of GET /.auth/anonymous (t/1483,
  // follow-up from t/1476). Establishes an anonymous session for programmatic
  // callers (the web-bridge session-recovery path) with the same two cookies but
  // a JSON 200 instead of a 302 + ~2KB HTML round-trip. Must run before the auth
  // gate below — the caller has no session yet. POST-only so a stray GET still
  // falls through to the 302 link / login page. The session id stays in the
  // HttpOnly cookie and is never echoed in the body.
  if (urlPath === '/api/auth/anonymous' && req.method === 'POST' && authOptional) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': anonSessionCookiesWithCreated(req), // t/2464 (id) + t/2493 (created marker on fresh mint)
    });
    res.end(JSON.stringify({ ok: true, anonymous: true }));
    return true;
  }
  return false;
}

/** Clear anonymous cookies when a user signs in via EasyAuth. */
function clearAnonCookiesOnSignin(req: http.IncomingMessage, res: http.ServerResponse, principalName: string): void {
  // Clear anonymous cookies when user signs in via EasyAuth
  if (principalName && parseCookies(req).get('auth_anonymous') === '1') {
    res.setHeader('Set-Cookie', [
      'auth_anonymous=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'anon_session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ]);
  }
}

/** Read-mostly context shared by the auth-gate helpers. */
interface AuthGateCtx {
  urlPath: string;
  isPublicPath: boolean;
  authDisabled: boolean;
  authOptional: boolean;
  principalName: string;
  idp: string;
}

/** Free tier (t/793): keyless POSTs to the allowlisted AI/embeddings paths when
 *  configured. Path membership is the exact-match FREE_TIER_AI_POST_PATHS allowlist
 *  (t/2489, extracted to anonAiRoutes.ts for unit testing); the `freeTierEnabled()`
 *  gate keeps a matched route exempt only when the server has a free-tier key. */
function isFreeTierRoute(method: string, urlPath: string): boolean {
  return isFreeTierAiPath(method, urlPath) && proxyTiers.freeTierEnabled();
}

/** AUTH_OPTIONAL mode gate: show login page / 401 unless signed in or anonymous. */
function enforceOptionalAuthGate(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx): boolean {
  const { principalName, urlPath } = ctx;
  // Optional mode: show login page unless user signed in or chose anonymous
  if (principalName) return false;
  const isAnonymousSession = parseCookies(req).get('auth_anonymous') === '1';
  if (isAnonymousSession) return false;
  // t/1473: API clients can't act on an HTML login page — anonymous /api/*
  // calls (no auth_anonymous cookie) were getting 200 text/html, which the
  // client mis-parsed as "corrupted data" and got permanently stuck. Return
  // a structured 401 so the client can re-establish an anonymous session and
  // retry (client recovery is the child ticket). Mirrors the required-mode
  // /api/ check (t/763) but 401 (a session CAN be established here) not 403.
  // t/1501: skip 401 for routes that don't need a session — isAnonAllowedRoute
  // and freeTierRoute are designed for truly cookie-less anonymous access.
  if (urlPath.startsWith('/api/')) {
    const m = req.method || 'GET';
    if (!isFreeTierRoute(m, urlPath) && !isAnonAllowedRoute(m, urlPath)) {
      recordAuthDenied('no_session', m, urlPath);
      res.writeHead(401, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'no_session' });
      res.end(JSON.stringify({ error: 'Anonymous session required', reason: 'no_session' }));
      return true;
    }
  }
  res.writeHead(200, loginPageHeaders(req));
  res.end(buildLoginPage(true));
  return true;
}

/** Required-auth mode gate: must sign in and be in the allowlist. */
function enforceRequiredAuthGate(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx): boolean {
  const { principalName, idp, urlPath } = ctx;
  // Required mode: must sign in and be in the allowlist
  if (!principalName) {
    // API clients can't act on an HTML login page — return a structured 403
    // with a machine-readable reason (t/763). Browser routes keep the login
    // page so the sign-in flow is unchanged.
    if (urlPath.startsWith('/api/')) {
      recordAuthDenied('no_auth_header', req.method || 'GET', urlPath);
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'no_auth_header' });
      res.end(JSON.stringify({ error: 'Sign in required', reason: 'no_auth_header' }));
      return true;
    }
    res.writeHead(200, loginPageHeaders(req));
    res.end(buildLoginPage(false));
    return true;
  }

  if (!isUserAuthorized(principalName, idp)) {
    recordAuthDenied('user_not_in_allowlist', req.method || 'GET', urlPath);
    // Browser-facing forbidden page; reason exposed via header for triage.
    res.writeHead(403, { 'Content-Type': 'text/html', 'X-Auth-Reason': 'user_not_in_allowlist' });
    res.end(FORBIDDEN_PAGE(principalName));
    return true;
  }
  return false;
}

/** Auth gate. Same control flow as before: public / kill-switch paths fall through;
 *  AUTH_OPTIONAL takes the optional gate; else the required gate runs iff authorized-users.json
 *  is present (original `else if (getAuthorizedUsers())`). Returns true when a response was sent. */
function enforceAuthGate(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx): boolean {
  if (ctx.isPublicPath || ctx.authDisabled) return false;
  if (ctx.authOptional) return enforceOptionalAuthGate(req, res, ctx);
  if (getAuthorizedUsers()) return enforceRequiredAuthGate(req, res, ctx);
  return false;
}

/** Anonymous route guard: in AUTH_OPTIONAL mode, block AI + write routes. */
function enforceAnonRouteGuard(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx): boolean {
  const { authOptional, principalName, isPublicPath, urlPath } = ctx;
  // Anonymous route guard: in AUTH_OPTIONAL mode, block AI + write routes
  if (authOptional && !principalName && !isPublicPath) {
    const method = req.method || 'GET';
    // Free tier (t/793): when configured, keyless users may reach AI generation;
    // the handler enforces the free-tier model pin, per-IP limits, and key. Inert
    // until FREE_TIER_GEMINI_KEY is set, so the AI block otherwise stands.
    if (!isFreeTierRoute(method, urlPath) && !isAnonAllowedRoute(method, urlPath)) {
      recordAuthDenied('anon_route_blocked', method, urlPath);
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'anon_route_blocked' });
      res.end(JSON.stringify({ error: 'Sign in required', reason: 'anon_route_blocked', detail: 'AI features and editing require authentication. Sign in at /.auth/login/github to unlock full access.' }));
      return true;
    }
  }
  return false;
}

/** Resolve the per-request user context (session branch, storage id, anon session).
 *  Returns null when it already sent a 403 (cross-provider binding mismatch) — caller returns. */
async function resolveRequestUserContext(req: http.IncomingMessage, res: http.ServerResponse, principalName: string, idp: string): Promise<UserContext | null> {
  // Resolve session branch for the ALS context (if any).
  // Reads start with the active branch (or undefined → 'main').
  // Writes call ensureSessionBranch() which updates the ALS mid-request.
  const sessionBranch = (githubBackend && sessionManager)
    ? await sessionManager.resolveBranch(principalName || '_local')
    : undefined;
  const isAnon = !principalName;
  const effectivePrincipal = principalName || '_local';
  const effectiveIdp = idp || '_local';
  const storageUserId = deriveStorageUserId(effectivePrincipal, effectiveIdp);

  // Cross-provider collision guard: verify the idp matches the one that first
  // claimed this storageUserId. Prevents a different provider from accessing
  // another user's data by presenting the same normalized email.
  if (!isAnon) {
    const binding = checkProviderBinding(storageUserId, effectiveIdp);
    if (!binding.ok) {
      json(res, {
        error: 'provider_mismatch',
        message: `This account is bound to a different identity provider (${binding.boundTo}). Sign in with your original provider.`,
      }, 403);
      return null;
    }
  }

  // t/803: surface the sanitized storage id (e.g. "jpsnover") in the request log
  // context — never the raw email/principal (PII).
  const reqCtx = getRequestContext();
  if (reqCtx) reqCtx.userId = storageUserId;
  const anonymousSessionId = isAnon ? parseCookies(req).get('anon_session_id') : undefined;
  return { principalName: effectivePrincipal, idp: effectiveIdp, branchName: sessionBranch, storageUserId, isAnonymous: isAnon, anonymousSessionId };
}

/** M7: per-IP rate limit on API write methods (100/min). Returns true when 429-limited. */
function enforceWriteRateLimit(req: http.IncomingMessage, res: http.ServerResponse, route: ReturnType<typeof matchRoute>, reqPath: string): boolean {
  // M7: per-IP rate limit on API write methods (100/min) — basic DoS/abuse guard.
  if (route && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') && reqPath.startsWith('/api/')) {
    const wr = rateLimiter.checkRate(`write:${getClientIp(req)}`, 100, 60_000);
    if (!wr.allowed) {
      const retryAfter = Math.max(1, Math.ceil((wr.retryAfterMs ?? 60_000) / 1000));
      // t/925: write-rate 429s were silent — log so abuse/DoS spikes are visible.
      log.server.warn({ component: 'rate-limiter', type: 'write_per_minute', method: req.method, path: reqPath, retryAfter }, 'API write rate-limited');
      res.setHeader('Retry-After', String(retryAfter));
      json(res, { error: 'rate_limited', message: 'Too many requests', retryAfter }, 429);
      return true;
    }
  }
  return false;
}

/** Dispatch a matched route: param validation, body read, handler, error mapping. */
async function dispatchMatchedRoute(req: http.IncomingMessage, res: http.ServerResponse, route: NonNullable<ReturnType<typeof matchRoute>>, reqPath: string): Promise<void> {
  (res as any).__routePath = route.routePath;
  // t/810: validate user-provided path params at the routing layer (primary
  // gate) before the handler runs. Handlers keep assertSafe* as defense-in-depth.
  const badParam = invalidRouteParam(route.routePath, reqPath);
  if (badParam) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server', level: 'warn',
      message: `Blocked invalid path parameter '${badParam}': ${req.method} ${reqPath}`,
    });
    json(res, { error: `Invalid path parameter: ${badParam}`, requestId: getRequestId() }, 400);
    return;
  }
  try {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method!) ? await readBody(req) : {};
    await route.handler(req, res, body);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: route.routePath,
      level: 'error',
      message: `Unhandled error in ${route.routePath}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.error({ err, method: req.method, path: reqPath, route: route.routePath }, 'Error handling request');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // M4: full detail is recorded/logged above; clients get a generic message
    // for server errors in production (the error string can carry file paths).
    const clientError = (status >= 500 && process.env.NODE_ENV === 'production') ? 'Internal server error' : String(err);
    const payload: Record<string, unknown> = { error: clientError };
    if ((err as { quotaInfo?: unknown }).quotaInfo) payload.quotaInfo = (err as { quotaInfo: unknown }).quotaInfo;
    json(res, payload, status);
  }
}

// ── WebSocket: Terminal ──

// M8: cap WebSocket frames at 1 MB (chat/debate messages are far smaller); the
// ws default is 100 MB, an easy memory-exhaustion vector.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const eventClients = new Set<WebSocket>();
const userEventClients = new Map<string, Set<WebSocket>>();

function broadcastEvent(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  for (const ws of eventClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// t/2443: NOTE: revisit registration rule if anonymous generation ever enabled (anon = read-only now).
function getWebSocketUserId(req: http.IncomingMessage): string | null {
  if (process.env.AUTH_DISABLED === '1') return '_local';
  return (AZURE_AUTH_ENABLED ? (req.headers['x-ms-client-principal-name'] as string) || '' : '') || null;
}
function emitToUser(userId: string, type: string, data: unknown): void {
  const msg = JSON.stringify({ type, data });
  userEventClients.get(userId)?.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// POV/taxonomy file keys the client toast knows how to label (Phase 5F / t/652).
const TAXONOMY_POV_FILES = new Set(['accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations']);

/** Map a committed file path to its POV key, or null if it isn't a taxonomy POV file. */
function povKeyForPath(p: string): string | null {
  const base = p.split('/').pop() ?? p;
  if (!base.endsWith('.json')) return null;
  const key = base.slice(0, -'.json'.length);
  return TAXONOMY_POV_FILES.has(key) ? key : null;
}

/**
 * Best-effort Phase 5F broadcast (t/652): after a session save commits, tell other
 * web clients which POV files changed and a changed-node count. Affected POVs come
 * from the committed paths; the count diffs each written POV file against its cached
 * base. Never throws and never fires when no POV file changed — a broadcast failure
 * must not affect the save (web/container mode only; filesystem commits return early).
 */
async function broadcastTaxonomyUpdate(
  backend: GitHubAPIBackend,
  pending: { writes: { path: string; content: string }[]; deletes: string[] } | null,
  user: string,
): Promise<void> {
  try {
    if (!pending) return;
    const povs = new Set<string>();
    let nodeCount = 0;

    for (const w of pending.writes) {
      const key = povKeyForPath(w.path);
      if (!key) continue;
      povs.add(key);
      try {
        const newNodes = (JSON.parse(w.content) as { nodes?: unknown[] }).nodes ?? [];
        const baseRaw = await backend.readBaseFromCache(w.path);
        const oldNodes = baseRaw ? ((JSON.parse(baseRaw.replace(/^﻿/, '')) as { nodes?: unknown[] }).nodes ?? []) : [];
        const diff = diffNodes(
          oldNodes as Parameters<typeof diffNodes>[0],
          newNodes as Parameters<typeof diffNodes>[1],
        );
        nodeCount += diff.added.length + diff.modified.length + diff.deleted.length;
      } catch { /* telemetry — silent by design: node count is best-effort */ }
    }
    for (const p of pending.deletes) {
      const key = povKeyForPath(p);
      if (key) povs.add(key);
    }

    if (povs.size === 0) return; // not a taxonomy change — nothing to announce
    broadcastEvent('taxonomy-updated', { user, nodeCount, povs: [...povs] });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'server',
      level: 'warn',
      message: 'taxonomy-updated broadcast failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

function isWebSocketAuthorized(req: http.IncomingMessage): boolean {
  if (process.env.AUTH_DISABLED === '1') return true;

  // S-WS-AUTH: principalName sourced via getWebSocketUserId (single header-read path
  // shared with the /ws/events registration handler — t/2443 condition 3).
  const principalName = getWebSocketUserId(req) ?? '';
  const idp = AZURE_AUTH_ENABLED
    ? (req.headers['x-ms-client-principal-idp'] as string) || ''
    : '';
  const authOptional = process.env.AUTH_OPTIONAL === '1';

  if (authOptional) {
    if (principalName) return true;
    const cookies = parseCookies(req);
    return cookies.get('auth_anonymous') === '1';
  }

  if (getAuthorizedUsers()) {
    return !!principalName && isUserAuthorized(principalName, idp);
  }

  return true;
}

// L6 (t/720): the terminal WS spawns a server-side shell, so restrict it to
// admins. AUTH_DISABLED is single-operator local/dev mode (L1 forbids it in
// production), so the local operator keeps terminal access; every authenticated
// deployment requires an admin user. Runs outside the per-request ALS context,
// so the userId is derived from the principal headers directly.
function isTerminalWebSocketAllowed(req: http.IncomingMessage): boolean {
  const principalName = AZURE_AUTH_ENABLED
    ? (req.headers['x-ms-client-principal-name'] as string) || ''
    : '';
  const idp = AZURE_AUTH_ENABLED
    ? (req.headers['x-ms-client-principal-idp'] as string) || ''
    : '';
  return isTerminalAccessAllowed({
    authDisabled: process.env.AUTH_DISABLED === '1',
    principalName,
    isAdmin: !!principalName && community.isAdmin(deriveStorageUserId(principalName, idp)),
  });
}

server.on('upgrade', (req, socket, head) => {
  // S-WS-ORIGIN + t/2532: block cross-origin WS upgrades (WS bypasses CORS); same-origin accepted, allowlist enforced in dev too.
  {
    const origin = (req.headers.origin || '') as string;
    if (!isWebSocketOriginAllowed(origin, req.headers.host, ALLOWED_ORIGINS)) {
      log.security.warn({ origin }, 'Blocked WebSocket upgrade from disallowed origin');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  if (!isWebSocketAuthorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url!, 'http://localhost');

  if (url.pathname === '/ws/terminal') {
    if (!isTerminalWebSocketAllowed(req)) {
      log.security.warn('Blocked non-admin terminal WebSocket upgrade');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalConnection(ws);
    });
  } else if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const userId = getWebSocketUserId(req); eventClients.add(ws);
      if (userId) { const s = userEventClients.get(userId) ?? new Set<WebSocket>(); userEventClients.set(userId, s); s.add(ws); }
      const c = () => { eventClients.delete(ws); if (userId) { const s = userEventClients.get(userId); if (s) { s.delete(ws); if (!s.size) userEventClients.delete(userId); } } };
      ws.on('close', c); ws.on('error', c);
    });
  } else {
    socket.destroy();
  }
});

// ── Terminal WebSocket handler ──

let terminalProcess: ChildProcess | null = null;

function handleTerminalConnection(ws: WebSocket) {
  if (terminalProcess) {
    ws.send(JSON.stringify({ type: 'error', data: 'Terminal already active' }));
    return;
  }

  const importCmd = `Import-Module '${path.join(SCRIPTS_DIR, 'AITriad', 'AITriad.psd1')}' -Force`;

  // S-ENV: Only pass safe environment variables to the terminal process.
  // Prevents leaking API keys, webhook secrets, and other sensitive env vars.
  const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME', 'PWD', 'COLORTERM',
    'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT', 'APPDATA',
    'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'NODE_ENV',
    'AI_TRIAD_DATA_ROOT'];
  const safeEnv: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) safeEnv[key] = process.env[key]!;
  }
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  terminalProcess = spawn(pythonCmd, [BROKER_SCRIPT], {
    cwd: getProjectRoot(),
    // AITRIAD_MODULE (t/2830): the broker imports this into the pwsh console on launch.
    // Resolved via the server's SCRIPTS_DIR (config.ts, .aitriad.json-anchored) so it works
    // in the container (/app/scripts) and dev alike — never a hardcoded path.
    env: { ...safeEnv, TERM: 'xterm-256color', PTY_COLS: '120', PTY_ROWS: '30', AITRIAD_MODULE: path.join(SCRIPTS_DIR, 'AITriad', 'AITriad.psd1') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  terminalProcess.stdout?.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString() }));
    }
  });

  terminalProcess.stderr?.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString() }));
    }
  });

  terminalProcess.on('exit', () => {
    terminalProcess = null;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit' }));
    }
  });

  // Import AITriad module after shell startup
  setTimeout(() => {
    if (terminalProcess?.stdin) terminalProcess.stdin.write(importCmd + '\r');
  }, 500);

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'write' && terminalProcess?.stdin) {
        terminalProcess.stdin.write(parsed.data);
      } else if (parsed.type === 'resize' && terminalProcess?.stdin) {
        terminalProcess.stdin.write(`\x1b]R;${parsed.cols};${parsed.rows}\x07`);
      } else if (parsed.type === 'kill') {
        if (terminalProcess) { terminalProcess.kill(); terminalProcess = null; }
      }
    } catch { /* telemetry — silent by design;  ignore malformed messages */ }
  });

  ws.on('close', () => {
    if (terminalProcess) { terminalProcess.kill(); terminalProcess = null; }
  });
}

// ── Graceful shutdown ──

let isShuttingDown = false;

function shutdown(signal: string) {
  if (isShuttingDown) return; // Prevent double-shutdown
  isShuttingDown = true;
  log.server.info({ signal }, 'Shutting down gracefully');

  // Dump server flight recorder on shutdown
  try {
    serverRecorder.record({ type: 'lifecycle', component: 'server', level: 'info', message: `Shutdown: ${signal}` });
    const ndjson = appendServerLogs(serverRecorder.buildDump('manual').ndjson);
    const dumpDir = path.join(getStateRoot(), 'flight-recorder'); // t/2643: class-A writable state
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(path.join(dumpDir, `server-shutdown-${Date.now()}.jsonl`), ndjson);
  } catch { /* telemetry — silent by design;  best effort */ }

  // 1a. Stop GitHubAPIBackend polling (also logs the immediate uncommitted-overlay snapshot, t/4258 Part 1)
  if (githubBackend) {
    githubBackend.shutdown();
  }
  logRequestMetrics(githubBackend, 'shutdown'); // t/4300: final GitHub-call tally for this process's lifetime

  // 1. Kill terminal PTY
  if (terminalProcess) {
    log.server.info('Terminating PTY process');
    terminalProcess.kill();
    terminalProcess = null;
  }

  // 2. Close all WebSocket connections
  for (const ws of eventClients) {
    try { ws.close(1001, 'Server shutting down'); } catch { /* telemetry — silent by design;  ignore */ }
  }
  eventClients.clear();

  // 3. Stop accepting new connections and wait for in-flight requests
  const closeDone = new Promise<void>((resolve) => {
    server.close(() => { log.server.info('All connections closed'); resolve(); });
  });

  // 2a. Flush debounced overlay commits concurrently with closing connections (t/4258/t/4276 C4).
  // closeDone is passed through so the flush can catch a write that lands after its first
  // snapshot but before its connection actually drains (SO e/315#2).
  const flushDone = flushOverlaysWithDeadline(githubBackend, closeDone).catch((err) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server', level: 'warn', message: 'Overlay flush at shutdown threw',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  });

  void Promise.all([closeDone, flushDone]).then(() => {
    log.server.info('Graceful shutdown complete, exiting');
    process.exit(0);
  });

  // 4. Force exit if graceful shutdown stalls
  setTimeout(() => {
    log.server.error(`Graceful shutdown timed out after ${FORCE_EXIT_TIMEOUT_MS / 1000}s, forcing exit`);
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Auto-dump server recorder on uncaught errors
process.on('uncaughtException', (err) => {
  try {
    serverRecorder.record({ type: 'system.error', component: 'server', level: 'fatal', message: err.message, error: { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) } });
    const { ndjson } = serverRecorder.buildDump('uncaught_error', { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) });
    const dumpDir = path.join(getStateRoot(), 'flight-recorder'); // t/2643: class-A writable state
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(path.join(dumpDir, `server-crash-${Date.now()}.jsonl`), ndjson);
  } catch { /* telemetry — silent by design;  best effort */ }
  log.server.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  serverRecorder.record({ type: 'system.error', component: 'server', level: 'error', message: err.message, error: { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) } });
  log.server.error({ err }, 'Unhandled promise rejection');
});

// ── Anonymous session store (in-memory, ephemeral) ──
initAnonymousSessionStore({
  sessionTtlMs: parseInt(process.env.ANON_SESSION_TTL_MS || '0', 10) || undefined,
  maxSessions: parseInt(process.env.ANON_MAX_SESSIONS || '0', 10) || undefined,
});

// ── Start ──
assertStateRootIsolation(); // t/2643: refuse start if staging's state root wasn't isolated (env drift) — no-op prod/local
// t/3296 (t/3290 prevention) → t/3309 Path B (step-3): assert taxonomy/ + dictionary/ are present AND
// non-empty via the ACTIVE backend (validateDataRoot uses listDirectoryStrict — profile-agnostic: fs
// local, GitHub Contents hosted; a transient blip throws rather than false-empties). The outcome is
// cached for the /readyz readiness gate: ready → /readyz 200 (falls through to the embeddings check),
// failed → /readyz 503 'data-root-failed'. The boot NO LONGER exit(1)s — the /readyz deploy warm-gate
// (proven to block a misprovisioned promotion by the Arm-B GV, t/3309#21) is now the SOLE data-root
// deploy protection: a misprovisioned revision never promotes (warm-gate blocks + rolls back) while
// the old rev keeps serving, so the process stays up (liveness) with no crash-loop (t/2683 class).
try {
  await fileIO.validateDataRoot();
  setDataRootReady(); // t/3309: cache data-root readiness for the /readyz gate
} catch (err) {
  // t/3309 step-3: record the definitive failure for the /readyz gate, then CONTINUE (no exit(1)).
  // The boot exit(1)/DATA_ROOT_VALIDATION_ENFORCE path is REMOVED — after the staging Arm-B GV proved
  // the /readyz warm-gate blocks a misprovisioned rev (t/3309#21), the readiness gate supersedes the
  // boot exit. Co-landed with DevOps retiring DATA_ROOT_VALIDATION_ENFORCE from main.bicep (joint-gv).
  // Failure stays OBSERVABLE via the WARN below → stdout→Log_s (condition 4).
  setDataRootFailed(err instanceof Error ? err.message : String(err));
  const errObj = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err);
  log.server.warn({ err: errObj }, 'Data root validation failed at boot — /readyz will report data-root-failed (503); process continues (liveness up), the deploy warm-gate blocks the promotion');
}
// t/4298/t/4299/t/4300: WARN-only boot check — github-api's disk cache must never overlap
// AI_TRIAD_DATA_ROOT (a data-root writer would otherwise silently become what this server
// serves, with no check against GitHub). Synchronous, never throws, no-op on filesystem mode.
fileIO.validateCacheDirDisjoint();
// t/2532 (M12): loopback (127.0.0.1) in dev / 0.0.0.0 in prod; HOST opts into LAN exposure (logged loudly below).
const BIND_HOST = resolveBindHost(process.env);
server.listen(PORT, BIND_HOST, () => {
  if (isNonLoopbackDevBind(process.env)) {
    log.security.warn({ host: BIND_HOST }, 'HOST override → binding a non-loopback interface in dev; the REST API is exposed beyond localhost');
  }
  serverRecorder.record({ type: 'lifecycle', component: 'server', level: 'info', message: 'Server started', data: { port: PORT, host: BIND_HOST, version: SERVER_VERSION, dataRoot: getDataRoot(), platform: process.platform, arch: process.arch, storageMode: STORAGE_MODE } });
  log.server.info({ port: PORT, host: BIND_HOST }, 'Taxonomy Editor running');
  log.server.info({ dataRoot: getDataRoot() }, 'Data root');
  // t/3166: periodic event-loop lag gauge (Pino) + threshold-crossing FR warn at >1s block,
  // so a starvation event (t/3165: 7–8s in-process ONNX froze the loop → ingress-fabricated
  // 500) is directly greppable instead of inferred. Unref'd interval — never holds the process.
  startEventLoopMonitor();
  // t/4300: logged once ~10min post-boot (past typical warm-up), and again at shutdown.
  // Unref'd — never holds the process open.
  setTimeout(() => logRequestMetrics(githubBackend, '10min-post-boot'), REQUEST_METRICS_LOG_DELAY_MS).unref();
  // t/3373: pre-shed early-warning for the embedding worker-offload pool (t/3211 arm-2's real
  // trigger). Samples poolStats() and emits ONE stdout WARN (component:'api' → Log Analytics) when
  // sustained queue depth approaches the dynamic cap — BEFORE a caller eats the 503 queue-shed.
  // Unref'd interval; inert at K=1 idle (queueDepth 0).
  startEmbedQueueDepthMonitor();
  // t/3172 (G8b): scheduled full-taxonomy grounding sweep — path-agnostic correctness backstop for
  // batch/PS/Python writes that bypass the inline G8a hook. Gated on GROUNDING_SWEEP_ENABLED
  // (default OFF): inert until the sequenced enable (t/3203 + TL lock-symmetry sign-off). Unref'd.
  startGroundingSweep();
  // t/3165 observability: one-line boot record of the offload flag's RUNTIME value, so a deploy's
  // effective EMBEDDING_WORKER_OFFLOAD is greppable in Log Analytics at startup — the "looked set
  // in ACA config but process.env evaluated false" regression (bicep value-form) is then visible
  // immediately, not inferred from a debate's compute path.
  log.server.info({ embeddingWorkerOffload: isEmbeddingWorkerOffloadEnabled() }, 'embedding offload flag at boot');
  // t/4177: WARN (not info) the effective per-replica Gemini RPM at boot — this is the number a
  // slow debate is actually paced to, so it must be greppable in Log Analytics without inferring
  // it from MAX_REPLICAS + the FREE_TIER_RPM_PER_KEY constant.
  log.server.warn(
    { maxReplicas: getMaxReplicas(), freeTierRpmPerKey: proxyTiers.FREE_TIER_RPM_PER_KEY, effectivePerReplicaRpm: effectivePerReplicaRpm(proxyTiers.FREE_TIER_RPM_PER_KEY) },
    'effective per-replica Gemini RPM at boot (t/4177)',
  );
  // t/3278 Arm-1: log the baked BUILD_SHA at boot so "what SHA is running?" is answerable from LA on
  // every deploy (the durable primitive vs the incidental t/3211 marker). 'unknown' if the build didn't
  // pass --build-arg BUILD_SHA → a visible gap, not a silent one (drift-check reads /health.buildSha).
  log.server.info({ buildSha: process.env.BUILD_SHA ?? 'unknown' }, 'build sha at boot');
  // t/3211: log the live cgroup-effective core count at boot so the embedding-worker-pool SKU sizing
  // (K = min(EMBEDDING_WORKER_POOL_SIZE, availableParallelism()-1)) is confirmed EMPIRICALLY from LA on
  // the next deploy, not asserted blind from the ACA vCPU config (cgroup quota can differ). DevOps reads
  // this before any 4-vCPU bump + POOL_SIZE flip (p/526#75).
  log.server.info({ availableParallelism: os.availableParallelism(), cpus: os.cpus().length }, 'host core count at boot');
  // t/3211: configure the embedding-worker POOL once at startup with the RAW EMBEDDING_WORKER_POOL_SIZE
  // (default 1 → single worker, today's exact behavior). Shared Lib's configureEmbeddingWorkerPool
  // SELF-CLAMPS to min(size, availableParallelism()-1) + WARNs, so a mis-set value can't oversubscribe
  // the main loop. Inert until POOL_SIZE>1 on a container with spare cores (needs the 4-vCPU SKU + flip).
  const poolSize = getEmbeddingWorkerPoolSize();
  configureEmbeddingWorkerPool(poolSize);
  log.server.info({ requestedPoolSize: poolSize }, 'embedding worker pool configured at boot');
  void warmupEmbeddings().catch((err: unknown) => {
    log.server.error({ err: String(err) }, 'ONNX embedding warmup failed at boot');
    getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'ONNX embedding warmup failed at boot', error: { name: (err as Error)?.name ?? 'Error', message: String(err), stack: (err as Error)?.stack } });
  });
  // t/3085: pre-warm the embeddings.json cache at startup so the first debate request
  // gets the precomputed vectors. Emits an FR signal "embeddings.json loaded: N nodes".
  // t/3086: after prewarm resolves, emit a Pino startup probe (both arms) so the cache
  // state is visible in server logs and in /health without reading the FR dump.
  void prewarmEmbeddingsCache().then(() => {
    const { present, nodeCount } = getEmbeddingsCacheStatus();
    if (present) {
      log.server.info({ embeddings_node_count: nodeCount }, 'startup probe: embeddings.json cache ready');
    } else {
      log.server.warn({}, 'startup probe: embeddings.json ABSENT — debates will re-embed ~3600 texts per session (check t/3085 DevOps half)');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'warn',
        message: 'startup probe: embeddings.json cache absent',
      });
    }
  }).catch((err: unknown) => {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'warn', message: 'embeddings.json pre-warm failed at boot', error: { name: (err as Error)?.name ?? 'Error', message: String(err), stack: (err as Error)?.stack } });
  });

  // t/924: surface the free-tier key pool + effective RPM so rate-limit
  // behavior is observable from startup logs (not inferred from 429 timing).
  const freeTierKeyPool = proxyTiers.parseFreeTierKeys(process.env.FREE_TIER_GEMINI_KEY).length;
  log.server.info({ component: 'server', freeTierKeyPool, effectiveRpm: proxyTiers.scaledFreeTierRpm(freeTierKeyPool) }, 'Free-tier key pool');

  // Initialize analytics storage — uses Azure Append Blobs in container
  // deployments, local NDJSON files in Electron/dev.
  const analyticsBlobUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  const analyticsContainer = process.env.AZURE_ANALYTICS_CONTAINER || 'analytics';
  analytics.initAnalytics(
    getStateRoot(), // t/2643: analytics NDJSON is class-A writable state — isolate the fs-fallback root by construction (not by AZURE_STORAGE_ACCOUNT_URL being set). No-op on prod (stateRoot===dataRoot).
    analyticsBlobUrl ? { accountUrl: analyticsBlobUrl, container: analyticsContainer } : undefined,
    // t/2704: reportStartupProbe logs "initialized" then probes the store, so a broken/empty pipeline is observable at boot (would have surfaced t/2699) instead of as a silent empty dashboard.
  ).then(() => analytics.reportStartupProbe(analyticsBlobUrl ? 'azure-blob' : 'filesystem', analyticsContainer))
    .catch((e) => { /* telemetry — silent by design */ log.analytics.warn({ err: e }, 'Analytics init failed'); });

  if (githubBackend) {
    // Initialize GitHubAPIBackend (token + cache check) AFTER health check is
    // ready. Health passes immediately, then async init.
    log.storage.info('Initializing GitHubAPIBackend');
    githubBackend.initialize().then(async () => {
      log.storage.info('GitHubAPIBackend initialized');
      // Warm the conflicts cache in the background so the first user request
      // doesn't pay the 5s cold-start penalty (1,242 individual file reads).
      try {
        const count = await warmConflictsCache();
        log.server.info({ count }, 'Conflicts cache warmed');
      } catch (e) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'server',
          level: 'warn',
          message: 'Conflicts cache warm failed (non-fatal)',
          error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack },
        });
        log.server.warn({ err: e }, 'Conflicts cache warm failed (non-fatal)');
      }
    }).catch((err) => {
      log.storage.error({ err }, 'GitHubAPIBackend initialization failed');
      // t/4258/t/4281 (Server Storage): serverRecorder.record() alone never
      // reaches console; alert-fallback-active needs "storage.fallback" in
      // ContainerAppConsoleLogs_CL. Trivial addition mirroring the storage/
      // sub-role's fix for the same gap — flagged there, not a design change.
      log.storage.warn({ err }, 'storage.fallback: GitHubAPIBackend initialization failed');
      serverRecorder.record({
        type: 'storage.fallback', component: 'storage', level: 'warn',
        message: `GitHubAPIBackend init failed: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) }
          : { name: 'Error', message: String(err) },
      });
    });
  }
});
