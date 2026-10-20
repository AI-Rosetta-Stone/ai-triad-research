/**
 * t/3963 stage 1 plumbing check (t/3963#3, staging step 1). Run with tsx from the frozen code worktree:
 *   npx tsx <this file> <stage1 output dir>
 * Checks, per arm: seat_tags reached the session; skeptic soul provenance vs A0, compared ONLY through
 * compareSoulProvenance (t/3963#2), with 'unknown' reported as its own outcome; calibration rows written.
 */
import * as fs from 'fs';
import * as path from 'path';
import { compareSoulProvenance } from '../../../../lib/debate/soulDocSchema';

const dir = process.argv[2];
if (!dir) throw new Error('usage: stage1_plumbing_check.ts <stage1 output dir>');
const arms = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
const load = (arm: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, `t3963s1-m01-${arm}-debate.json`), 'utf-8'));

const base = load('a0');
const calDir = path.join(dir, 'calibration');
const calFiles = fs.existsSync(calDir)
  ? (fs.readdirSync(calDir, { recursive: true }) as string[]).map(f => path.join(calDir, f))
      .filter(f => fs.statSync(f).isFile())
  : [];
const calText = calFiles.map(f => fs.readFileSync(f, 'utf-8')).join('\n');

for (const arm of arms) {
  const d = load(arm);
  const sk = d.soul_provenance?.skeptic;
  const prov = arm === 'a0' ? '(reference)' : compareSoulProvenance(base.soul_provenance?.skeptic, sk);
  console.log(JSON.stringify({
    arm,
    seat_tags: d.seat_tags ?? null,
    skeptic_soul: sk ?? null,
    skeptic_soul_vs_a0: prov,
    calibration_mentions: calText.split(d.id).length - 1,
    transcript_entries: (d.transcript ?? []).length,
  }));
}
