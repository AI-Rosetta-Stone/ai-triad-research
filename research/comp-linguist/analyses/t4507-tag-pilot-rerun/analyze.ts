/**
 * t/4507 pre-registered analysis (PREREG.md + AMENDMENT-1.md, both written before the data).
 *
 *  - Unit (t/3963#7, unchanged): per debate, the Skeptic content vector = mean over that debate's Skeptic
 *    turns (opening included) of each turn's vector; a turn's vector is the mean of its chunk embeddings
 *    (paragraphs, split further at ~900 chars because all-MiniLM-L6-v2 truncates at 256 tokens).
 *  - Embedder: the production ONNX all-MiniLM-L6-v2. Distance d = 1 - cos.
 *  - Per motion m: F = d(A1, A1r).
 *      Q1 wings:  B = mean(d(A1,A3), d(A2,A4)); distinct on m if B > F.
 *      Q2 modes:  M = mean(d(A1,A2), d(A3,A4)); distinct on m if M > F.
 *    Verdict per question: >= 7 of 10 distinct; <= 3 not distinct; else inconclusive.
 *    Fewer than 8 complete motions: underpowered. Void if median F < 0.01 (t/3587).
 *  - Manipulation checks, which gate reading Q1/Q2, over each debate's per-turn injected Skeptic node ids
 *    (transcript[].metadata.injection_manifest.povNodeIds, t/4438#5):
 *      Scope arms (A1, A3, A1r): >= 95% of injected Skeptic nodes carry the seat's tag.
 *      Prioritize arms (A2, A4): tagged share > the tag's corpus base rate in skeptic.json.
 *  - Amendment 1 covariate: Skeptic statement count (non-opening Skeptic turns) per debate; flag an arm whose
 *    mean count differs from another arm's by more than 1.0 as possibly confounded. The flag never changes a verdict.
 *  - Secondary (exploratory): tagged share of cited Skeptic taxonomy_refs per arm; Prioritize lift (A2/A4 tagged
 *    injected share minus base rate) at the stipulated TAG_BOOST_INCREMENT.
 *
 * Usage, from a worktree root (repo-root node_modules resolve up the tree):
 *   npx tsx research/comp-linguist/analyses/t4507-tag-pilot-rerun/analyze.ts <debate dir> <skeptic.json>
 */
import * as fs from 'fs';
import * as path from 'path';
import { computeEmbeddings } from '../../../../lib/embeddings/onnxEmbedding';
import { cosineSimilarity } from '../../../../lib/embeddings/similarity';

const ARMS = ['a1', 'a2', 'a3', 'a4', 'a1r'] as const;
type Arm = typeof ARMS[number];
const SEAT: Record<Arm, { tag: string; mode: 'scope' | 'prioritize' }> = {
  a1: { tag: 'critical', mode: 'scope' }, a2: { tag: 'critical', mode: 'prioritize' },
  a3: { tag: 'institutional', mode: 'scope' }, a4: { tag: 'institutional', mode: 'prioritize' },
  a1r: { tag: 'critical', mode: 'scope' },
};
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

const dist = (a: number[], b: number[]) => 1 - cosineSimilarity(a, b);
const r4 = (x: number) => +x.toFixed(4);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

interface Turn { speaker?: string; type?: string; content?: string;
  taxonomy_refs?: { node_id?: string }[]; metadata?: { injection_manifest?: { povNodeIds?: string[] } } }

interface DebateStats { vec: number[]; turns: number; statements: number; chunks: number;
  injected: number; injectedTagged: number; cited: number; citedTagged: number; seatTags: unknown }

async function analyseDebate(file: string, arm: Arm, tagsOf: Map<string, string[]>): Promise<DebateStats> {
  const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const turns: Turn[] = (d.transcript ?? []).filter((e: Turn) =>
    e.speaker === 'skeptic' && typeof e.content === 'string' && e.content.trim());
  if (turns.length === 0) throw new Error(`no Skeptic turns in ${path.basename(file)}`);
  const tag = SEAT[arm].tag;
  const has = (id: string) => (tagsOf.get(id) ?? []).includes(tag);
  let nChunks = 0, injected = 0, injectedTagged = 0, cited = 0, citedTagged = 0;
  const turnVecs: number[][] = [];
  for (const t of turns) {
    const cs = chunks(t.content!);
    nChunks += cs.length;
    turnVecs.push(mean(await computeEmbeddings(cs)));
    for (const id of t.metadata?.injection_manifest?.povNodeIds ?? []) {
      if (!id.startsWith('skp-')) continue;
      injected++; if (has(id)) injectedTagged++;
    }
    for (const r of t.taxonomy_refs ?? []) {
      if (!r.node_id?.startsWith('skp-')) continue;
      cited++; if (has(r.node_id)) citedTagged++;
    }
  }
  const statements = turns.filter(t => t.type !== 'opening').length;
  return { vec: mean(turnVecs), turns: turns.length, statements, chunks: nChunks,
    injected, injectedTagged, cited, citedTagged, seatTags: d.seat_tags ?? null };
}

function verdict(distinct: number, complete: number, medianF: number): string {
  if (complete < 8) return `UNDERPOWERED (${complete} complete motions)`;
  if (medianF < 0.01) return 'VOID (median F < 0.01)';
  return distinct >= 7 ? 'DISTINCT' : distinct <= 3 ? 'NOT DISTINCT' : 'INCONCLUSIVE';
}

async function main(): Promise<void> {
  const [dir, skepticFile] = process.argv.slice(2);
  if (!dir || !skepticFile) throw new Error('usage: analyze.ts <debate dir> <skeptic.json>');
  const sk = JSON.parse(fs.readFileSync(skepticFile, 'utf-8'));
  const nodes: { id: string; pov_tags?: string[] }[] = Array.isArray(sk) ? sk : sk.nodes;
  const tagsOf = new Map(nodes.map(n => [n.id, n.pov_tags ?? []]));
  const baseRate = (tag: string) => nodes.filter(n => (n.pov_tags ?? []).includes(tag)).length / nodes.length;
  const base = { critical: baseRate('critical'), institutional: baseRate('institutional'), n_nodes: nodes.length };

  const byMotion = new Map<string, Partial<Record<Arm, string>>>();
  for (const f of fs.readdirSync(dir)) {
    const m = /^t4507-(m\d+)-(a1r|a\d)-debate\.json$/.exec(f);
    if (!m) continue;
    const slot = byMotion.get(m[1]) ?? {};
    slot[m[2] as Arm] = path.join(dir, f);
    byMotion.set(m[1], slot);
  }

  const perArm: Record<Arm, DebateStats[]> = { a1: [], a2: [], a3: [], a4: [], a1r: [] };
  const rows: unknown[] = [];
  const skipped: string[] = [];
  const Fs: number[] = [];
  let q1 = 0, q2 = 0, complete = 0;
  for (const motion of [...byMotion.keys()].sort()) {
    const slot = byMotion.get(motion)!;
    if (!ARMS.every(a => slot[a])) { skipped.push(motion); continue; }
    const v = {} as Record<Arm, DebateStats>;
    for (const a of ARMS) { v[a] = await analyseDebate(slot[a]!, a, tagsOf); perArm[a].push(v[a]); }
    const F = dist(v.a1.vec, v.a1r.vec);
    const d13 = dist(v.a1.vec, v.a3.vec), d24 = dist(v.a2.vec, v.a4.vec);
    const d12 = dist(v.a1.vec, v.a2.vec), d34 = dist(v.a3.vec, v.a4.vec);
    const B = (d13 + d24) / 2, M = (d12 + d34) / 2;
    complete++; Fs.push(F);
    if (B > F) q1++;
    if (M > F) q2++;
    rows.push({ motion, F: r4(F), B: r4(B), M: r4(M), wings_distinct: B > F, modes_distinct: M > F,
      d13: r4(d13), d24: r4(d24), d12: r4(d12), d34: r4(d34),
      skeptic_statements: Object.fromEntries(ARMS.map(a => [a, v[a].statements])) });
  }
  const medianF = median(Fs);

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const manipulation = Object.fromEntries(ARMS.map(a => {
    const xs = perArm[a];
    const inj = sum(xs.map(x => x.injected)), tagged = sum(xs.map(x => x.injectedTagged));
    const share = inj ? tagged / inj : NaN;
    const { tag, mode } = SEAT[a];
    const threshold = mode === 'scope' ? 0.95 : base[tag as 'critical' | 'institutional'];
    const pass = mode === 'scope' ? share >= threshold : share > threshold;
    const seatTagsOk = xs.every(x => JSON.stringify(x.seatTags) === JSON.stringify({ skeptic: { pov_tag: tag, tag_mode: mode } }));
    return [a, { tag, mode, injected_skeptic_nodes: inj, tagged: tagged, tagged_share: r4(share),
      criterion: mode === 'scope' ? '>= 0.95' : `> base rate ${r4(threshold)}`, pass, seat_tags_recorded_ok: seatTagsOk, n_debates: xs.length }];
  }));
  const manipulationPass = Object.values(manipulation).every((m: { pass: boolean; seat_tags_recorded_ok: boolean }) => m.pass && m.seat_tags_recorded_ok);

  const meanStatements = Object.fromEntries(ARMS.map(a => [a, r4(sum(perArm[a].map(x => x.statements)) / perArm[a].length)]));
  const dist_statements = Object.fromEntries(ARMS.map(a => [a, perArm[a].map(x => x.statements)]));
  const ms = Object.values(meanStatements) as number[];
  const turnCountFlag = Math.max(...ms) - Math.min(...ms) > 1.0;
  const confoundedArms = ARMS.filter(a => ARMS.some(b => Math.abs(meanStatements[a] - meanStatements[b]) > 1.0));

  const secondary = {
    cited_tagged_share: Object.fromEntries(ARMS.map(a => {
      const c = sum(perArm[a].map(x => x.cited)), t = sum(perArm[a].map(x => x.citedTagged));
      return [a, { cited_skeptic_refs: c, tagged: t, share: r4(c ? t / c : NaN) }];
    })),
    prioritize_lift: Object.fromEntries((['a2', 'a4'] as Arm[]).map(a => {
      const tag = SEAT[a].tag as 'critical' | 'institutional';
      return [a, r4((manipulation[a] as { tagged_share: number }).tagged_share - base[tag])];
    })),
  };

  const gate = manipulationPass ? null : 'MANIPULATION CHECK FAILED: primary not read; report as a selection defect';
  process.stdout.write(JSON.stringify({
    complete_motions: complete, skipped_motions: skipped,
    median_F: r4(medianF), F_values: Fs.map(r4),
    manipulation_checks: manipulation, manipulation_pass: manipulationPass,
    Q1_wings: gate ?? { verdict: verdict(q1, complete, medianF), distinct_motions: q1, of: complete },
    Q2_modes: gate ?? { verdict: verdict(q2, complete, medianF), distinct_motions: q2, of: complete },
    turn_count_covariate: { mean_statements: meanStatements, distribution: dist_statements,
      spread_gt_1: turnCountFlag, possibly_confounded_arms: confoundedArms },
    corpus_base_rates: { critical: r4(base.critical), institutional: r4(base.institutional), n_nodes: base.n_nodes },
    secondary_exploratory: secondary,
    rows,
  }, null, 2) + '\n');
}
main().catch(e => { console.error(e); process.exit(1); });
