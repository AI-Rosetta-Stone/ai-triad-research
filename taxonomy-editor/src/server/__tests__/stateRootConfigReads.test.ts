// @vitest-environment node
// t/625 (t/617 B; TL p/16#393): per-deployment config files are read from the STATE root, not the data root.
//   - With AI_TRIAD_STATE_ROOT set (staging), authorized-users.json and proxy-tiers.json come from the state root, and a
//     copy in the data root (on staging: prod's grounding share) is never read.
//   - With it unset (prod, Electron, filesystem mode) the state root is the data root, so the same file is read as before.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), auth: l(), security: l() } };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { loadAuthorizedUsers, assertAllowlistForRequiredAuth } from '../authorizedUsers.js';

const ENV = ['AI_TRIAD_DATA_ROOT', 'AI_TRIAD_STATE_ROOT', 'FREE_TIER_GEMINI_KEY'];
const saved: Record<string, string | undefined> = {};
let dataRoot: string;
let stateRoot: string;

const write = (root: string, name: string, body: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(body));
const users = (name: string) => ({ users: [{ name, github: name }] });
const tiers = (name: string, tier: string) => ({ users: [{ name, github: name, tier }] });

beforeEach(() => {
  for (const n of ENV) { saved[n] = process.env[n]; delete process.env[n]; }
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't625-data-'));
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't625-state-'));
  process.env.AI_TRIAD_DATA_ROOT = dataRoot;
  vi.resetModules();
});
afterEach(() => {
  for (const n of ENV) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

describe('t/625: authorized-users.json comes from the state root', () => {
  it('staging (state root set): the state root\'s file is read; the data root\'s is never read', () => {
    process.env.AI_TRIAD_STATE_ROOT = stateRoot;
    write(stateRoot, 'authorized-users.json', users('staging-user'));
    write(dataRoot, 'authorized-users.json', users('prod-user'));
    expect(loadAuthorizedUsers()?.users.map(u => u.name)).toEqual(['staging-user']);
  });

  it('staging with no file in the state root: null, even when the data root has one (prod\'s is never the fallback)', () => {
    process.env.AI_TRIAD_STATE_ROOT = stateRoot;
    write(dataRoot, 'authorized-users.json', users('prod-user'));
    expect(loadAuthorizedUsers()).toBeNull();
  });

  it('prod (state root unset): the data root\'s file is read, as before', () => {
    write(dataRoot, 'authorized-users.json', users('prod-user'));
    expect(loadAuthorizedUsers()?.users.map(u => u.name)).toEqual(['prod-user']);
  });
});

describe('t/625: proxy-tiers.json comes from the state root', () => {
  it('staging: the per-user tier comes from the state root\'s file, not the data root\'s', async () => {
    process.env.AI_TRIAD_STATE_ROOT = stateRoot;
    write(stateRoot, 'proxy-tiers.json', tiers('alice', 'platform'));
    write(dataRoot, 'proxy-tiers.json', tiers('alice', 'anonymous'));
    const { resolveTier } = await import('../ai/proxyTiers.js');
    expect(resolveTier('alice', 'github').level).toBe('platform');
  });

  it('prod (state root unset): the data root\'s file is read, as before', async () => {
    write(dataRoot, 'proxy-tiers.json', tiers('alice', 'platform'));
    const { resolveTier } = await import('../ai/proxyTiers.js');
    expect(resolveTier('alice', 'github').level).toBe('platform');
  });
});

describe('t/625 (Security p/93#80): a hosted required-auth deployment with no allowlist fails closed at boot', () => {
  const ALLOW = () => ({ users: [{ name: 'a' }] });
  const NONE = () => null;
  it('ACA + required mode + no file: refuses to start (ALLOWLIST_MISSING_REQUIRED_AUTH)', () => {
    expect(() => assertAllowlistForRequiredAuth({ CONTAINER_APP_NAME: 'taxonomy-editor-staging' }, NONE)).toThrow(/would let any signed-in user in/);
  });
  it('ACA + required mode + a readable file: starts', () => {
    expect(() => assertAllowlistForRequiredAuth({ CONTAINER_APP_NAME: 'taxonomy-editor' }, ALLOW)).not.toThrow();
  });
  it('optional or disabled auth mode: the allowlist is not consulted, so no check', () => {
    expect(() => assertAllowlistForRequiredAuth({ CONTAINER_APP_NAME: 'x', AUTH_OPTIONAL: '1' }, NONE)).not.toThrow();
    expect(() => assertAllowlistForRequiredAuth({ CONTAINER_APP_NAME: 'x', AUTH_DISABLED: '1' }, NONE)).not.toThrow();
  });
  it('not hosted (local, Electron, filesystem mode): unchanged', () => {
    expect(() => assertAllowlistForRequiredAuth({}, NONE)).not.toThrow();
  });
  it('the real loader: a state root with no file fails closed even when the data root has one', () => {
    process.env.AI_TRIAD_STATE_ROOT = stateRoot;
    write(dataRoot, 'authorized-users.json', users('prod-user'));
    expect(() => assertAllowlistForRequiredAuth({ CONTAINER_APP_NAME: 'taxonomy-editor-staging' })).toThrow(/ALLOWLIST|signed-in/);
  });
});
