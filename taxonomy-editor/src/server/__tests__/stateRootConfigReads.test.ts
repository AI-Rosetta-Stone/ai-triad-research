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

import { loadAuthorizedUsers, resolveAllowlist, allowlistRequiredButMissing } from '../authorizedUsers.js';

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

describe('t/625 (Security p/93#80, p/93#100): a hosted required-auth deployment with no allowlist fails closed at the gate', () => {
  const ALLOW = () => ({ users: [{ name: 'a' }] });
  const NONE = () => null;
  const HOSTED = { CONTAINER_APP_NAME: 'taxonomy-editor-staging' };
  it('hosted + required mode + no file: an EMPTY allowlist (the required gate then denies every sign-in), never null', () => {
    expect(resolveAllowlist(HOSTED, NONE)).toEqual({ users: [] });
    expect(allowlistRequiredButMissing(HOSTED, NONE)).toBe(true);
  });
  it('hosted + required mode + a readable file: that file, and ready', () => {
    expect(resolveAllowlist(HOSTED, ALLOW)).toEqual(ALLOW());
    expect(allowlistRequiredButMissing(HOSTED, ALLOW)).toBe(false);
  });
  it('optional or disabled auth mode: unaffected (null = the allowlist is not consulted), and ready', () => {
    for (const mode of [{ AUTH_OPTIONAL: '1' }, { AUTH_DISABLED: '1' }]) {
      expect(resolveAllowlist({ ...HOSTED, ...mode }, NONE)).toBeNull();
      expect(allowlistRequiredButMissing({ ...HOSTED, ...mode }, NONE)).toBe(false);
    }
  });
  it('not hosted (local, Electron, filesystem mode): unchanged', () => {
    expect(resolveAllowlist({}, NONE)).toBeNull();
    expect(allowlistRequiredButMissing({}, NONE)).toBe(false);
  });
  it('never throws (no boot crash on a slow mount); a late file is picked up on the next read', () => {
    let present = false;
    const late = () => (present ? ALLOW() : null);
    expect(() => resolveAllowlist(HOSTED, late)).not.toThrow();
    expect(resolveAllowlist(HOSTED, late)).toEqual({ users: [] });
    present = true;
    expect(resolveAllowlist(HOSTED, late)).toEqual(ALLOW());
  });
  it('the real loader: a state root with no file denies even when the data root has one', () => {
    process.env.AI_TRIAD_STATE_ROOT = stateRoot;
    write(dataRoot, 'authorized-users.json', users('prod-user'));
    expect(resolveAllowlist(HOSTED)).toEqual({ users: [] });
  });
});
