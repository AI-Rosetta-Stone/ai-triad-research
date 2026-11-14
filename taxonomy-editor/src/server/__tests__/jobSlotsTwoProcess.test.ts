// @vitest-environment node
//
// t/405 — two-process test for slot-claim admission (t/400). Two separate OS processes share one filesystem
// data root and race for the single slot at cap 1. Exactly one may win. The in-process test in
// jobCapRoutes.test.ts cannot show this: the backend serialises conditional writes within a process.
//
// Each child is its own vitest process running this same file in child mode (T400_CHILD set). The parent
// starts both children, releases them together through a GO file, and checks their results.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VITEST = path.resolve(here, '../../../node_modules/vitest/vitest.mjs');
const THIS_FILE = path.resolve(here, 'jobSlotsTwoProcess.test.ts');

// ── Child mode: claim the slot once the GO file appears, write the outcome, exit. ──
describe.skipIf(!process.env.T400_CHILD)('t/405 child (one replica)', () => {
  it('claims at cap 1 when released, and records the outcome', async () => {
    const { FilesystemBackend } = await import('../storage/filesystemBackend.js');
    const { claimJobSlot } = await import('../storage/jobSlots.js');
    const goFile = process.env.T400_GO!;
    const outFile = process.env.T400_OUT!;
    const deadline = Date.now() + 90_000;
    while (!fs.existsSync(goFile)) {
      if (Date.now() > deadline) throw new Error('GO file never appeared');
      await new Promise(r => setTimeout(r, 5));
    }
    const slot = await claimJobSlot({
      backend: new FilesystemBackend(), jobsDir: process.env.T400_JOBS_DIR!, cap: 1,
      jobId: process.env.T400_JOB_ID!, isLive: async () => true,
    });
    fs.writeFileSync(outFile, JSON.stringify({ jobId: process.env.T400_JOB_ID, slot }));
    expect(true).toBe(true);
  }, 120_000);
});

// ── Parent mode: two replicas, one slot, exactly one winner. ──
describe.skipIf(!!process.env.T400_CHILD)('t/405 two processes race for one slot (t/400)', () => {
  it('exactly one of two processes claims the single slot at cap 1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't405-two-proc-'));
    const jobsDir = path.join(dir, 'jobs');
    const goFile = path.join(dir, 'GO');

    const start = (name: string) => new Promise<{ out: string; proc: ReturnType<typeof spawn> }>((resolve) => {
      const out = path.join(dir, `${name}.json`);
      const proc = spawn(process.execPath, [VITEST, 'run', THIS_FILE, '--reporter=dot'], {
        env: {
          ...process.env, T400_CHILD: '1', T400_GO: goFile, T400_OUT: out,
          T400_JOBS_DIR: jobsDir, T400_JOB_ID: `replica-${name}`, AI_TRIAD_DATA_ROOT: dir,
        },
        stdio: ['ignore', fs.openSync(path.join(dir, `${name}.log`), 'w'), fs.openSync(path.join(dir, `${name}.err`), 'w')],
      });
      resolve({ out, proc });
    });

    const a = await start('a');
    const b = await start('b');
    // Let both children reach their GO poll, then release them together.
    await new Promise(r => setTimeout(r, 15_000));
    fs.writeFileSync(goFile, 'go');

    const waitFor = (file: string) => new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 150_000;
      const tick = () => {
        if (fs.existsSync(file)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`child never wrote ${file}`));
        setTimeout(tick, 100);
      };
      tick();
    });
    await Promise.all([waitFor(a.out), waitFor(b.out)]);
    a.proc.kill();
    b.proc.kill();

    const outcomes = [a.out, b.out].map(f => JSON.parse(fs.readFileSync(f, 'utf8')) as { jobId: string; slot: unknown });
    const winners = outcomes.filter(o => o.slot !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0].slot).toMatchObject({ index: 0, generation: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  }, 240_000);
});
