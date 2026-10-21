/**
 * t/3963 primary outcome: do the Critical and Institutional Skeptic wings produce distinct substance?
 * Operationalised per the pre-data amendment t/3963#7 (2026-10-20), before any primary computation.
 *
 *  - Unit: per debate, the Skeptic content vector = mean over that debate's Skeptic turns of each turn's
 *    vector. A turn's vector is the mean of its chunk embeddings. Chunks are paragraphs, split further at
 *    about 900 characters, because all-MiniLM-L6-v2 truncates at 256 tokens: embedding a whole ~2,000-char
 *    turn would silently use only its first half.
 *  - Embedder: the production ONNX all-MiniLM-L6-v2, offline (set AI_TRIAD_ONNX_MODEL_DIR).
 *  - Distance: cosine distance, 1 - cos.
 *  - Per motion: between = mean(d(A1,A3), d(A2,A4)); within = max(d(A1,A2), d(A3,A4)); distinct if
 *    between > within. Decision: distinct on >= 7 motions, not distinct on <= 3, else inconclusive.
 *  - Void if the median within-wing distance across motions is < 0.01 (non-degenerate guard, t/3587).
 *
 * Usage, from a worktree root:
 *   npx tsx research/comp-linguist/analyses/t3963-tag-pilot/primary_wing_distinctness.ts <stage dir> [<stage dir> ...]
 * Debates are matched by slug `t3963s<stage>-<motion>-<arm>-debate.json`. A motion missing any of
 * A1-A4 is skipped and counted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { computeEmbeddings } from '../../../../lib/embeddings/onnxEmbedding';
import { cosineSimilarity } from '../../../../lib/embeddings/similarity';

const ARMS = ['a1', 'a2', 'a3', 'a4'] as const;
const CHUNK_CHARS = 900;

function chunks(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
    if (para.length <= CHUNK_CHARS) { out.push(para); continue; }
    let rest = para;
    while (rest.length > CHUNK_CHARS) {
      const cut = rest.lastIndexOf('. ', CHUNK_CHARS);
      const at = cut > CHUNK_CHARS / 2 ? cut + 1 : CHUNK_CHARS;
      out.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

function mean(vs: number[][]): number[] {
  const m = new Array(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) m[i] += v[i] / vs.length;
  return m;
}

async function skepticVector(file: string): Promise<{ vec: number[]; turns: number; chunks: number }> {
  const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const turns = (d.transcript ?? []).filter((e: { speaker?: string; content?: string }) =>
    e.speaker === 'skeptic' && typeof e.content === 'string' && e.content.trim());
  if (turns.length === 0) throw new Error(`no Skeptic turns in ${path.basename(file)}`);
  let nChunks = 0;
  const turnVecs: number[][] = [];
  for (const t of turns) {
    const cs = chunks(t.content);
    nChunks += cs.length;
    turnVecs.push(mean(await computeEmbeddings(cs)));
  }
  return { vec: mean(turnVecs), turns: turns.length, chunks: nChunks };
}

const dist = (a: number[], b: number[]) => 1 - cosineSimilarity(a, b);

async function main(): Promise<void> {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) throw new Error('usage: primary_wing_distinctness.ts <stage dir> [...]');
  const byMotion = new Map<string, Partial<Record<string, string>>>();
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^t3963s\d+-(m\d+)-(a\d)-debate\.json$/.exec(f);
      if (!m) continue;
      const slot = byMotion.get(m[1]) ?? {};
      slot[m[2]] = path.join(dir, f);
      byMotion.set(m[1], slot);
    }
  }
  const rows: unknown[] = [];
  const skipped: string[] = [];
  let distinct = 0, evaluated = 0;
  const withins: number[] = [];
  for (const motion of [...byMotion.keys()].sort()) {
    const slot = byMotion.get(motion)!;
    if (!ARMS.every(a => slot[a])) { skipped.push(motion); continue; }
    const v: Record<string, Awaited<ReturnType<typeof skepticVector>>> = {};
    for (const a of ARMS) v[a] = await skepticVector(slot[a]!);
    const d13 = dist(v.a1.vec, v.a3.vec), d24 = dist(v.a2.vec, v.a4.vec);
    const d12 = dist(v.a1.vec, v.a2.vec), d34 = dist(v.a3.vec, v.a4.vec);
    const between = (d13 + d24) / 2, within = Math.max(d12, d34);
    evaluated++; withins.push(within);
    if (between > within) distinct++;
    rows.push({ motion, between: +between.toFixed(4), within: +within.toFixed(4), distinct: between > within,
      d13: +d13.toFixed(4), d24: +d24.toFixed(4), d12: +d12.toFixed(4), d34: +d34.toFixed(4),
      skeptic_turns: ARMS.map(a => v[a].turns), chunks: ARMS.map(a => v[a].chunks) });
  }
  withins.sort((a, b) => a - b);
  const medianWithin = withins.length ? withins[Math.floor(withins.length / 2)] : null;
  const verdict = evaluated < 10 ? `NOT A RESULT: ${evaluated} of 10 motions (plumbing or partial)`
    : medianWithin !== null && medianWithin < 0.01 ? 'VOID (median within-wing < 0.01)'
    : distinct >= 7 ? 'DISTINCT' : distinct <= 3 ? 'NOT DISTINCT' : 'INCONCLUSIVE';
  process.stdout.write(JSON.stringify({ verdict, distinct_motions: distinct, evaluated_motions: evaluated,
    median_within: medianWithin, skipped_motions: skipped, rows }, null, 2) + '\n');
}
main().catch(e => { console.error(e); process.exit(1); });
