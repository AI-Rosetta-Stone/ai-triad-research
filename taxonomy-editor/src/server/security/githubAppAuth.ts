// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * GitHub App installation-token minting for Phase-2 sync.
 *
 * Three credential modes, tried in order:
 *
 *   1. GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + (GITHUB_APP_PRIVATE_KEY
 *      inline, or GITHUB_APP_PRIVATE_KEY_SECRET_NAME fetched from Key Vault).
 *      Produces a short-lived installation token (~1 h). Preferred for prod —
 *      commits are attributed to the app bot, web-user email is in the
 *      `author` trailer.
 *
 *   2. GITHUB_TOKEN (personal access token or fine-grained token). Dev/test
 *      convenience. Commits are attributed to the token owner.
 *
 *   3. No credentials set → `getCredentials()` returns null. Callers render
 *      a disabled UI state; endpoints 503 with a clear message.
 *
 * JWT signing uses Node's built-in crypto — no `jsonwebtoken` dependency.
 * HTTP uses the built-in `fetch` (Node 20+).
 */

import crypto from 'crypto';
import { createRequire } from 'module';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getCurrentUserId } from './userContext.js';
import { STORAGE_MODE } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const require = createRequire(import.meta.url);

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'ai-triad-taxonomy-editor';

// Refresh installation tokens 5 min before they expire so in-flight
// operations never race the expiry clock.
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export interface SyncCredentials {
  /** "owner/repo" e.g. "AI-Rosetta-Stone/ai-triad-data" */
  repo: string;
  /** Bearer token for `https://x-access-token:<token>@github.com/...` git pushes */
  token: string;
  /** "app" = installation token; "pat" = user PAT. Purely informational. */
  mode: 'app' | 'pat';
}

// ── Private-key sourcing ──

let cachedPrivateKey: string | null = null;

async function loadPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey) return cachedPrivateKey;

  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inline && inline.trim()) {
    cachedPrivateKey = normalisePem(inline);
    return cachedPrivateKey;
  }

  const vaultUrl = process.env.AZURE_KEYVAULT_URL;
  const secretName = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME;
  if (vaultUrl && secretName) {
    try {
       
      const { SecretClient } = await import('@azure/keyvault-secrets');
      const identity = await import('@azure/identity');

      const credential = process.env.NODE_ENV === 'production'
        ? new identity.ManagedIdentityCredential()
        : new identity.DefaultAzureCredential();
      const client = new SecretClient(vaultUrl, credential);
      const resp = await client.getSecret(secretName);
      if (resp?.value) {
        cachedPrivateKey = normalisePem(resp.value);
        return cachedPrivateKey;
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'github-auth',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.auth.warn({ err }, 'Failed to load private key from Key Vault');
    }
  }

  return null;
}

/** Strip surrounding quotes, unescape `\n` from env-style single-line PEMs. */
function normalisePem(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (s.includes('\\n') && !s.includes('\n')) s = s.replace(/\\n/g, '\n');
  return s;
}

// ── JWT (RS256) ──

function b64urlEncode(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function mintJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  // GitHub requires iat ≤ now and exp ≤ iat + 600. We give ourselves a 60s
  // skew on iat and a 9-minute window on exp.
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };

  const unsigned = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(privateKey);
  return `${unsigned}.${b64urlEncode(sig)}`;
}

// ── Installation-token minting ──

interface CachedInstallToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cachedInstallToken: CachedInstallToken | null = null;

async function getInstallationToken(): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !installationId) return null;

  if (cachedInstallToken && cachedInstallToken.expiresAt > Date.now() + EXPIRY_SAFETY_MARGIN_MS) {
    return cachedInstallToken.token;
  }

  const privateKey = await loadPrivateKey();
  if (!privateKey) {
    log.auth.warn('GITHUB_APP_ID set but no private key available');
    return null;
  }

  const jwt = mintJwt(appId, privateKey);
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch((err) => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'github-app-auth',
        level: 'warn',
        message: 'Failed to read installation token error response body',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return '';
    });
    log.auth.warn({ status: res.status }, 'Installation token mint failed');
    return null;
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedInstallToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  return data.token;
}

// ── Runtime credential store (set via /api/sync/credentials) ──
//
// t/847: scoped PER USER, keyed by getCurrentUserId(). Previously a single
// process-global PAT meant one user's runtime credential was used for every
// other user's sync/PR/push (confused-deputy / cross-user PAT leak). The map
// keys on the ALS principal: single-user/Electron collapses to one "_local"
// entry (identical to the old behavior), while a multi-user Azure deployment
// isolates each authenticated user's PAT.

interface RuntimeCreds { repo: string | null; token: string | null }
// t/2895: per-user runtime creds deprecated in hosted mode (single-shared-repo; App-install token
// is canonical). Scale-guard marker removed; map retained for filesystem/local-dev mode only.
const runtimeCredsByUser = new Map<string, RuntimeCreds>();

/**
 * Store credentials at runtime (from the UI), scoped to the current user. These
 * take priority over env vars so users can configure credentials without
 * restarting the server.
 */
export function setRuntimeCredentials(repo: string, token: string): void {
  // t/2895: not supported in hosted mode — App-install token is canonical for single-shared-repo.
  if (STORAGE_MODE !== 'filesystem') {
    throw Object.assign(new ActionableError({
      goal: 'Configure per-user GitHub credentials',
      problem: 'Runtime per-user credential override is not supported in hosted mode. All hosted users share the repository configured at deployment time via the GitHub App installation token.',
      location: 'security/githubAppAuth.ts → setRuntimeCredentials',
      nextSteps: [
        'In hosted mode, repository access is managed via the GitHub App installation token — no per-user override is needed.',
        'Contact the deployment administrator to change the shared repository (GITHUB_REPO env var).',
      ],
    }), { statusCode: 409 });
  }
  runtimeCredsByUser.set(getCurrentUserId(), {
    repo: repo && repo.includes('/') ? repo : null,
    token: token && token.trim() ? token.trim() : null,
  });
}

export function clearRuntimeCredentials(): void {
  // t/2895: no-op in hosted mode — map is never populated there.
  if (STORAGE_MODE !== 'filesystem') return;
  runtimeCredsByUser.delete(getCurrentUserId());
}

// ── Public API ──

/** Repo in "owner/repo" form, or null when unset. */
export function getRepoSlug(): string | null {
  // t/2895: hosted mode is single-shared-repo — always use the deployment env var, never the per-user map.
  if (STORAGE_MODE !== 'filesystem') {
    const repo = process.env.GITHUB_REPO;
    return repo && repo.includes('/') ? repo : null;
  }
  const runtimeRepo = runtimeCredsByUser.get(getCurrentUserId())?.repo;
  if (runtimeRepo) return runtimeRepo;
  const repo = process.env.GITHUB_REPO;
  return repo && repo.includes('/') ? repo : null;
}

/**
 * Returns the epoch-ms when the cached installation token expires,
 * or 0 if no token is cached (PAT mode or no credentials).
 * Used by SessionBranchManager to validate >60 s remaining before
 * starting a multi-step batch commit.
 */
export function getTokenExpiryMs(): number {
  return cachedInstallToken?.expiresAt ?? 0;
}

/**
 * Returns a usable credential bundle, or null when no credentials are
 * configured. Callers should 503 (or render a disabled UI) on null.
 *
 * t/2895: in hosted (non-filesystem) mode the per-user runtime map is never
 * consulted — App-install token → GITHUB_TOKEN env only. A FR error is emitted
 * when all rungs are exhausted so auth failures are diagnosable.
 */
export async function getCredentials(): Promise<SyncCredentials | null> {
  if (STORAGE_MODE !== 'filesystem') {
    // Hosted mode: single-shared-repo. Never consults per-user map (defense-in-depth, t/2895).
    const repo = process.env.GITHUB_REPO ?? null;
    const repoValid = repo != null && repo.includes('/');

    // t/2895: .catch(() => null) — a network blip or JSON parse error in getInstallationToken()
    // must NOT throw out of getCredentials(), bypassing the GITHUB_TOKEN fallback and the
    // Condition-1 FR-error/graceful-null path. Absorb the throw; treat mint failure as null.
    const installToken = await getInstallationToken().catch(() => null);
    if (installToken && repoValid) return { repo: repo!, token: installToken, mode: 'app' };

    const envPat = (process.env.GITHUB_TOKEN ?? '').trim() || null;
    if (envPat && repoValid) return { repo: repo!, token: envPat, mode: 'pat' };

    // All rungs exhausted — emit an observable signal so failures are diagnosable (t/2895 Condition 1).
    const tried: string[] = [];
    if (!installToken) tried.push('GitHub App installation token (GITHUB_APP_ID/INSTALLATION_ID/private key not configured or token mint failed)');
    if (!envPat) tried.push('GITHUB_TOKEN env var (not set)');
    if (!repoValid) tried.push(`GITHUB_REPO env var (${repo == null ? 'not set' : `"${repo}" is not in owner/repo form`})`);
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'github-auth',
      level: 'error',
      message: `getCredentials() resolved to null in hosted mode — credential rungs exhausted: ${tried.join('; ')}`,
      error: { name: 'MissingCredentials', message: tried.join('; ') },
    });
    return null;
  }

  // Filesystem/single-user mode: existing priority order unchanged (t/847).
  const repo = getRepoSlug();
  if (!repo) return null;

  // 1. Runtime PAT (set via UI), scoped to the current user (t/847)
  const runtimeToken = runtimeCredsByUser.get(getCurrentUserId())?.token;
  if (runtimeToken) return { repo, token: runtimeToken, mode: 'pat' };

  // 2. GitHub App installation token
  const installToken = await getInstallationToken();
  if (installToken) return { repo, token: installToken, mode: 'app' };

  // 3. Env var PAT
  const pat = process.env.GITHUB_TOKEN;
  if (pat && pat.trim()) return { repo, token: pat.trim(), mode: 'pat' };

  return null;
}

/**
 * Thin authenticated fetch against api.github.com with the given path
 * (e.g. "/repos/owner/repo/pulls").
 */
export async function githubFetch(
  creds: SyncCredentials,
  pathAndQuery: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const url = `${GITHUB_API}${pathAndQuery}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${creds.token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* telemetry — silent by design */ data = text; }

  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'message' in data)
      ? String((data as { message: unknown }).message)
      : text || `HTTP ${res.status}`;
    return { ok: false, status: res.status, data, error: message };
  }
  return { ok: true, status: res.status, data };
}
