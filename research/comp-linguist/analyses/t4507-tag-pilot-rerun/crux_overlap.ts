/**
 * t/4507 secondary measure (declared exploratory in PREREG.md): crux overlap, A1 vs A3.
 *
 * Operationalised 2026-10-27, after the primary result (RESULTS.md) and before any crux was read:
 *  - A debate's cruxes are its `crux_tracker[].description` strings. Each one is embedded with the production
 *    ONNX all-MiniLM-L6-v2 (one description per vector; descriptions are single claims, well under 256 tokens).
 *  - Overlap(X, Y) = the symmetric mean best-match cosine: for every crux in X take the max cosine to any crux
 *    in Y, average, do the same from Y to X, and take the mean of the two directions.
 *  - Per motion: compare O_wings = Overlap(A1, A3) with the replicate floor O_floor = Overlap(A1, A1r).
 *    The wings share fewer cruxes than noise on motion m if O_wings < O_floor.
 *  - Report the count of motions with O_wings < O_floor out of the complete motions, plus every value with its n.
 *    No verdict thresholds: this measure is exploratory and does not gate anything.
 *  - A motion where any of A1, A3, A1r has zero cruxes is skipped and counted.
 *
 * Usage, from a worktree root:
 *   npx tsx research/comp-linguist/analyses/t4507-tag-pilot-rerun/crux_overlap.ts <debate dir>
 */
import * as fs from 'fs';
import * as path from 'path';
import { computeEmbeddings } from '../../../../lib/embeddings/onnxEmbedding';
import { cosineSimilarity } from '../../../../lib/embeddings/similarity';

const ARMS = ['a1', 'a3', 'a1r'] as const;
type Arm = typeof ARMS[number];
const r4 = (x: number) => +x.toFixed(4);

async function cruxVectors(file: string): Promise<number[][]> {
  const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const texts: string[] = (d.crux_tracker ?? [])
    .map((c: { description?: string }) => c.description?.trim())
    .filter((t: string | undefined): t is string => !!t);
  return texts.length ? computeEmbeddings(texts) : [];
}

function directional(x: number[][], y: number[][]): number {
  return x.reduce((s, v) => s + Math.max(...y.map(w => cosineSimilarity(v, w))), 0) / x.length;
}

const overlap = (x: number[][], y: number[][]) => (directional(x, y) + directional(y, x)) / 2;

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: crux_overlap.ts <debate dir>');
  const byMotion = new Map<string, Partial<Record<Arm, string>>>();
  for (const f of fs.readdirSync(dir)) {
    const m = /^t4507-(m\d+)-(a1r|a1|a3)-debate\.json$/.exec(f);
    if (!m) continue;
    const slot = byMotion.get(m[1]) ?? {};
    slot[m[2] as Arm] = path.join(dir, f);
    byMotion.set(m[1], slot);
  }
  const rows: unknown[] = [];
  const skipped: string[] = [];
  let lower = 0, complete = 0;
  for (const motion of [...byMotion.keys()].sort()) {
    const slot = byMotion.get(motion)!;
    if (!ARMS.every(a => slot[a])) { skipped.push(`${motion} (missing arm)`); continue; }
    const v = {} as Record<Arm, number[][]>;
    for (const a of ARMS) v[a] = await cruxVectors(slot[a]!);
    if (ARMS.some(a => v[a].length === 0)) { skipped.push(`${motion} (zero cruxes)`); continue; }
    const wings = overlap(v.a1, v.a3), floor = overlap(v.a1, v.a1r);
    complete++;
    if (wings < floor) lower++;
    rows.push({ motion, O_wings: r4(wings), O_floor: r4(floor), wings_below_floor: wings < floor,
      n_cruxes: Object.fromEntries(ARMS.map(a => [a, v[a].length])) });
  }
  process.stdout.write(JSON.stringify({ measure: 'crux overlap A1 vs A3 (exploratory)',
    motions_wings_below_floor: lower, complete_motions: complete, skipped_motions: skipped, rows }, null, 2) + '\n');
}
main().catch(e => { console.error(e); process.exit(1); });
