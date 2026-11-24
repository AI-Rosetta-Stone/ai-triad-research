// @vitest-environment node
// t/467 (TL p/16#211): the anonymous op-ed spend ledger. A daily and a monthly ceiling, shared across
// visitors, fail closed when the ledger can't be read.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => ({
    readFile: async (p: string) => (files.has(p) ? files.get(p)! : null),
    writeFile: async (p: string, c: string) => { files.set(p, c); return { version: 'v' }; },
  }),
}));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { anonOpEdCeilingBreach, recordAnonOpEdSpend, ANON_OPED_DAILY_CAP_USD, ANON_OPED_MONTHLY_CAP_USD } from '../storage/anonOpEdSpend.js';

const NOW = new Date('2026-11-22T12:00:00Z');
const DAY = 'anon-oped-spend/day-2026-11-22.json';
const MONTH = 'anon-oped-spend/month-2026-11.json';

beforeEach(() => files.clear());

describe('anonymous op-ed spend ceilings (t/467)', () => {
  it('the caps are $10 a day and $50 a month', () => {
    expect(ANON_OPED_DAILY_CAP_USD).toBe(10);
    expect(ANON_OPED_MONTHLY_CAP_USD).toBe(50);
  });

  it('nothing recorded: no ceiling reached', async () => {
    expect(await anonOpEdCeilingBreach(NOW)).toBeNull();
  });

  it('DAILY ceiling: at $10 for the day, the next run is refused as daily', async () => {
    files.set(DAY, JSON.stringify({ usd: 10 }));
    expect(await anonOpEdCeilingBreach(NOW)).toBe('daily');
  });

  it('just under the daily ceiling is still allowed', async () => {
    files.set(DAY, JSON.stringify({ usd: 9.99 }));
    expect(await anonOpEdCeilingBreach(NOW)).toBeNull();
  });

  it('MONTHLY ceiling: at $50 for the month (day under its cap), the next run is refused as monthly', async () => {
    files.set(MONTH, JSON.stringify({ usd: 50 }));
    expect(await anonOpEdCeilingBreach(NOW)).toBe('monthly');
  });

  it('an unreadable day ledger fails closed: treated as at the daily ceiling', async () => {
    files.set(DAY, 'not json');
    expect(await anonOpEdCeilingBreach(NOW)).toBe('daily');
  });

  it('recording a run adds its cost to both the day and the month ledgers', async () => {
    await recordAnonOpEdSpend(2.5, NOW);
    await recordAnonOpEdSpend(1, NOW);
    expect(JSON.parse(files.get(DAY)!)).toEqual({ usd: 3.5 });
    expect(JSON.parse(files.get(MONTH)!)).toEqual({ usd: 3.5 });
  });

  it('a non-positive or non-finite cost is not recorded', async () => {
    await recordAnonOpEdSpend(0, NOW);
    await recordAnonOpEdSpend(Number.NaN, NOW);
    expect(files.size).toBe(0);
  });
});
